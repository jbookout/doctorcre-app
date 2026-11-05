"""Wait for a main push's exact CI run without retargeting its deployment."""
import json
import os
from pathlib import Path
import re
import subprocess
import time


def current(sha):
    subprocess.run(['git', 'fetch', '--no-tags', 'origin',
                    'refs/heads/main:refs/remotes/origin/main'], check=True, timeout=45)
    return subprocess.check_output(['git', 'rev-parse', 'origin/main'], text=True, timeout=30).strip() == sha


def ready(sha):
    if not current(sha):
        return False
    for attempt in range(6):
        runs = json.loads(subprocess.check_output([
            'gh', 'run', 'list', '--repo', os.environ['GITHUB_REPOSITORY'],
            '--workflow', 'ci.yml', '--commit', sha, '--event', 'push', '--branch', 'main',
            '--limit', '1', '--json', 'databaseId,headSha,status,conclusion',
        ], text=True, timeout=45))
        if runs:
            break
        if attempt < 5:
            time.sleep(10)
    else:
        raise RuntimeError('No main push CI run appeared within six lookups')
    run = runs[0]
    if run['headSha'] != sha:
        raise ValueError('CI run does not match the deployment source')
    if run['status'] != 'completed':
        subprocess.run([
            'gh', 'run', 'watch', str(run['databaseId']), '--repo', os.environ['GITHUB_REPOSITORY'],
            '--exit-status', '--interval', '30',
        ], check=True, timeout=1800)
    elif run['conclusion'] != 'success':
        return False
    return current(sha)


def candidate():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=30).strip()
    if not re.fullmatch('[0-9a-f]{40}', sha) or sha != os.environ['GITHUB_SHA']:
        raise ValueError('Checked-out source must match the triggering main push')
    selected = ready(sha)
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write(f'source_commit={sha}\nready={str(selected).lower()}\n')
    print(f'Main push {sha}: {"CI passed" if selected else "superseded or CI unsuccessful"}')


if __name__ == '__main__':
    candidate()
