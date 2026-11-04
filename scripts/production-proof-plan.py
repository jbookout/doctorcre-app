import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REVISION = '2b65380ebcbb9f4d9db0f1cc2034c550b2c1b024'
CONTRACT_SHA256 = '36224e67292a2a834dc03b0021ba09379894b3e9207cf08d492fd5e8432d6a6f'
VALIDATOR_SHA256 = 'dec2b482c0e63eb6eacefa9f5268d8e6c193ce754ca93809ed9fca3e0b851112'


def load_pinned(root):
    contract = root / 'contracts/production-proof-plan.v1.json'
    validator = root / 'scripts/vendor/production-proof-plan.v1.py'
    for path, digest in [(contract, CONTRACT_SHA256), (validator, VALIDATOR_SHA256)]:
        if path.stat().st_size > 1048576 or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('pinned source drift: ' + path.name)
    spec = importlib.util.spec_from_file_location('pinned_production_proof', validator)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, json.loads(contract.read_text())


def admission(validator, body, paths, root, contract):
    policy = dict(contract)
    policy['x-non-product-paths'] = contract['x-non-product-paths'] + [
        'scripts/production-proof-plan.py', 'scripts/production-proof-plan-selftest.py',
        'scripts/vendor/production-proof-plan.v1.py', 'scripts/check-action-pins.mjs',
    ]
    policy['x-required-targets'] = dict(contract['x-required-targets'], app=['*'])
    if validator.product_paths(paths, policy) and not any(
            'app' in runner['targets'] for runner in contract['x-runners'].values()):
        raise ValueError('unsupported app production proof: pinned P1 contract has no app runner '
                         'observing deployed app /release and a live walk')
    return validator.admission(body, paths, root, policy)


def main():
    parser = argparse.ArgumentParser(description='Validate app PR production-proof admission with pinned P1 policy')
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--body-file', type=Path)
    parser.add_argument('--files-file', type=Path)
    parser.add_argument('--base', default='origin/main')
    args = parser.parse_args()
    try:
        validator, contract = load_pinned(ROOT)
        event = None
        if args.body_file:
            body = validator.read(args.body_file)
            base = args.base
        elif os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
            event = json.loads(validator.read(Path(os.environ['GITHUB_EVENT_PATH'])))
            validator.github_metadata(event)
            body = event['pull_request']['body'] or ''
            base = event['pull_request']['base']['sha']
        else:
            print('Production proof: PR admission not evaluated; local use --body-file')
            return 0
        paths = json.loads(validator.read(args.files_file)) if args.files_file else validator.command(
            'git', 'diff', '--name-only', '--no-renames', '-z', base + '...HEAD').rstrip('\0').split('\0')
        result = admission(validator, body, paths, args.root, contract)
        if event:
            validator.github_metadata(event)
        print('Production proof: ' + result)
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('Production proof REFUSED: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__))
        return 1


if __name__ == '__main__':
    sys.exit(main())
