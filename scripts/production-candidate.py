"""Admit the exact completed CI source when it advances the live release."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import Request, urlopen


def git(*args):
    return subprocess.check_output(['git', *args], text=True, timeout=45).strip()


def ancestor(older, newer):
    result = subprocess.run(['git', 'merge-base', '--is-ancestor', older, newer], timeout=30)
    if result.returncode not in (0, 1):
        raise ValueError('Cannot establish release ancestry')
    return result.returncode == 0


def source_sha(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{40}', value) or value == '0' * 40:
        raise ValueError('Invalid release source identity')
    return value


def ready(sha, release_url):
    repository = os.environ['GITHUB_REPOSITORY']
    run_id = os.environ['CI_RUN_ID']
    if not run_id.isdecimal():
        raise ValueError('Invalid CI run identity')
    run = json.loads(subprocess.check_output([
        'gh', 'api', f'repos/{repository}/actions/runs/{run_id}',
    ], text=True, timeout=45))
    if (not isinstance(run, dict) or run.get('id') != int(run_id) or run.get('head_sha') != sha
            or run.get('event') != 'push' or run.get('head_branch') != 'main'
            or run.get('path') != '.github/workflows/ci.yml'
            or run.get('head_repository', {}).get('full_name') != repository
            or run.get('status') != 'completed'):
        raise ValueError('CI run identity does not match the completed main source')
    if run.get('conclusion') != 'success':
        return False, 'exact source CI did not succeed'
    git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main')
    if not ancestor(sha, 'origin/main'):
        raise ValueError('CI source is outside main history')
    request = Request(release_url, headers={'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=15) as response:
        if response.status != 200 or response.headers.get_content_type() != 'application/json':
            raise ValueError('Live release did not return application JSON')
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError('Live release exceeds 64 KiB')
    release = json.loads(data)
    if not isinstance(release, dict) or release.get('service') != 'doctorcre-app' or release.get('environment') != 'production':
        raise ValueError('Invalid live release service or environment')
    live = source_sha(release.get('source_commit'))
    if live == sha:
        return False, 'source is already live'
    if ancestor(live, sha):
        return True, f'eligible source {sha} advances live {live}'
    if ancestor(sha, live):
        return False, f'newer release {live} is already live'
    raise ValueError('Candidate and live release histories diverge')


def report(message, level=None):
    print(f'::{level}::{message}' if level else message)
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
        summary.write(f'{message}\n\n')


def candidate(release_url):
    sha = source_sha(os.environ['SOURCE_COMMIT'])
    if git('rev-parse', 'HEAD') != sha:
        raise ValueError('Checked-out source must match the completed CI source')
    selected, reason = ready(sha, release_url)
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write(f'source_commit={sha}\nready={str(selected).lower()}\n')
    report(reason if selected else f'no-op: {reason}', None if selected else 'notice')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--release-url', default='https://app.doctorcre.com/app-release')
    args = parser.parse_args()
    try:
        candidate(args.release_url)
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        report(f'Production deployment refused: {reason}', 'error')
        sys.exit(1)
