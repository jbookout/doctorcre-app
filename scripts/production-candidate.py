"""Validate the exact successful CI completion before building or publishing."""
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone
from urllib.request import Request, urlopen


def candidate():
    repository = os.environ['GITHUB_REPOSITORY']
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    run = event['workflow_run']
    sha = run['head_sha']
    receipt = dict(repository=repository, source_commit=sha, ci_run_id=run['id'],
                   ci_run_attempt=run['run_attempt'], ci_completed_at=run.get('updated_at'),
                   disposition='failed',
                   observed_at=datetime.now(timezone.utc).isoformat())

    def record(disposition):
        receipt['disposition'] = disposition
        Path(os.environ['RUNNER_TEMP'], 'production-candidate.json').write_text(json.dumps(receipt))
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write(f'source_commit={sha}\nready={str(disposition == "eligible").lower()}\ndisposition={disposition}\n')
        print(json.dumps(receipt))

    record('failed')
    if (event.get('action') != 'completed' or event.get('repository', {}).get('full_name') != repository
            or not re.fullmatch('[0-9a-f]{40}', sha)
            or type(run['id']) is not int or run['id'] <= 0
            or type(run['run_attempt']) is not int or run['run_attempt'] <= 0):
        raise ValueError('Invalid CI completion identity')

    def trusted(value):
        return (value.get('id') == run['id'] and value.get('run_attempt') == run['run_attempt']
                and value.get('head_sha') == sha and value.get('head_branch') == 'main'
                and value.get('event') == 'push' and value.get('status') == 'completed'
                and value.get('conclusion') == 'success' and value.get('name') == 'CI'
                and value.get('path') == '.github/workflows/ci.yml'
                and value.get('head_repository', {}).get('full_name') == repository
                and value.get('repository', {}).get('full_name') == repository)

    if not trusted(run):
        raise ValueError('Completion is not successful trusted main-push CI')
    request = Request(f'https://api.github.com/repos/{repository}/actions/runs/{run["id"]}', headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'doctorcre-production-candidate',
    })
    with urlopen(request, timeout=45) as response:
        latest = json.load(response)
    if not trusted(latest):
        raise ValueError('Latest CI attempt no longer matches successful completion')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=30).strip()
    if head != sha:
        raise ValueError('Checkout differs from the tested source')
    subprocess.check_output(['git', 'fetch', '--no-tags', 'origin',
                             'refs/heads/main:refs/remotes/origin/main'], text=True, timeout=45)
    main = subprocess.check_output(['git', 'rev-parse', 'origin/main'], text=True, timeout=30).strip()
    if not re.fullmatch('[0-9a-f]{40}', main):
        raise ValueError('Invalid current main identity')
    record('eligible' if main == sha else 'superseded')


if __name__ == '__main__':
    candidate()
