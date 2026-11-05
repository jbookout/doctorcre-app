"""Reconcile a serialized deployment wake against current main's exact CI run."""
import json
import os
from pathlib import Path
import re
import subprocess


def candidate():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=30).strip()
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Invalid checked-out source SHA')
    runs = json.loads(subprocess.check_output([
        'gh', 'run', 'list', '--repo', os.environ['GITHUB_REPOSITORY'],
        '--workflow', 'ci.yml', '--commit', sha, '--event', 'push', '--branch', 'main',
        '--limit', '1', '--json', 'headSha,status,conclusion',
    ], text=True, timeout=45))
    ready = bool(runs and runs[0]['headSha'] == sha
                 and runs[0]['status'] == 'completed' and runs[0]['conclusion'] == 'success')
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write(f'source_commit={sha}\nready={str(ready).lower()}\n')
    print(f'Current main {sha}: {"CI passed" if ready else "waiting for successful CI"}')


if __name__ == '__main__':
    candidate()
