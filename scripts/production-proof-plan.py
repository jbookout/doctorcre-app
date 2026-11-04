import argparse
import hashlib
import importlib.util
import json
import os
import fnmatch
import re
import posixpath
import shlex
from typing import NamedTuple
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


class Snapshot(NamedTuple):
    event_name: str
    base_sha: str
    head_sha: str
    body: str
    paths: tuple[str, ...]
    requirement_json: str | None = None
    source_trees: tuple[tuple[tuple[str, str], ...], ...] = ()


class Decision(NamedTuple):
    status: str
    reason: str


def declaration(body):
    clean = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    headings = list(re.finditer(r'^##\s+(.+?)\s*$', clean, re.M))
    matches = [i for i, heading in enumerate(headings) if heading[1].lower() == 'production proof']
    if len(matches) != 1:
        raise ValueError('exactly one Production proof section required')
    i = matches[0]
    return clean[headings[i].end():headings[i+1].start() if i+1 < len(headings) else len(clean)].strip()


def requirement_path(section):
    match = re.fullmatch(r'`?(proofs/requirements/[A-Za-z0-9][A-Za-z0-9._-]*\.json)`?', section)
    if not match:
        raise ValueError('Production proof must name one proofs/requirements/<change>.json')
    return match[1]


# First match owns the class. Unlisted paths remain runtime.
PATH_CLASSES = (
    ('runtime', ('src/**', 'js/**', 'css/**', 'public/**', 'public-shell/**',
                 'worker/**', 'dist/**', 'bundles/**')),
    ('non-product', ('.github/**', 'test/**', 'tests/fixtures/**', 'docs/**',
                     'README.md', '.claude/skills/**/*.md', 'proofs/requirements/**')),
    ('tooling-candidate', ('scripts/**',)),
)


def path_class(path):
    return next((kind for kind, patterns in PATH_CLASSES
                 if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)), 'runtime')


def non_product_paths(sources):
    files = dict(sources)
    scripts = {path for path in files if path_class(path) == 'tooling-candidate'}
    commands = json.loads(files.get('package.json', '{}')).get('scripts', {})
    nodes = {**files, **{'npm:' + name: text for name, text in commands.items()}}
    nodes.pop('package.json', None)

    def resolve(path, reference):
        reference = reference.split('?', 1)[0].split('#', 1)[0]
        parent = '' if path.startswith('npm:') else posixpath.dirname(path)
        roots = [posixpath.join(parent, reference)]
        if not reference.startswith('.'):
            roots.append(reference)
        candidates = {posixpath.normpath(root + suffix) for root in roots
                      for suffix in ('', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py',
                                     '/index.js', '/index.mjs', '/index.ts')}
        return candidates & files.keys()

    edges = {}
    for path, text in nodes.items():
        # Resolve path strings, never basenames or stems found in prose.
        references = re.findall(r"['\"`]([^'\"`\n]+)['\"`]", text)
        references += re.findall(r"(?<![\w/.-])((?:\.?\.?/)?scripts/[^\s'\"`;,)]+)", text)
        references += [name.replace('.', '/') for name in
                       re.findall(r'^\s*(?:from|import)\s+([\w.]+)', text, re.M)]
        edges[path] = set().union(*(resolve(path, ref) for ref in references))
        try:
            tokens = shlex.split(text, comments=True)
        except ValueError:
            if re.search(r'\bnpm\s', text) and not path.endswith('.json'):
                edges[path].update(scripts)
            tokens = []
        for i, token in enumerate(tokens):
            if token != 'npm' or (not path.startswith('npm:') and path.endswith('.json')):
                continue
            invocation = tokens[i + 1:]
            while invocation and invocation[0].startswith('-'):
                option = invocation.pop(0)
                if option in {'--prefix', '--workspace', '-w', '--userconfig', '--cache', '--registry'}:
                    if invocation:
                        invocation.pop(0)
            command = invocation[0] if invocation else ''
            name = (invocation[1] if len(invocation) > 1 else '') if command in {'run', 'run-script'} else command
            if name in commands:
                edges[path].add('npm:' + name)
            elif command not in {'ci', 'install', 'audit', 'exec', '--version'}:
                edges[path].update(scripts)
        if path.startswith('npm:'):
            name = path[4:]
            edges[path].update('npm:' + prefix + name for prefix in ('pre', 'post')
                               if prefix + name in commands)
    tools = {path for path in nodes if path.startswith(('.github/', 'test/', 'tests/fixtures/')) or
             (path.startswith('npm:') and re.search(r'^(?:pre|post)?test(?::|$)|(?:^|:)check(?::|$)|^typecheck$|^ci:', path[4:]))}
    runtime = {path for path in nodes if path not in tools and
               (path.startswith('npm:') or path_class(path) == 'runtime')}

    def reachable(roots):
        seen, pending = set(), list(roots)
        while pending:
            path = pending.pop()
            if path not in seen:
                seen.add(path)
                pending.extend(edges.get(path, ()))
        return seen

    certified = reachable(tools) & scripts
    # Unreferenced scripts are unknown, so their dependencies cannot be certified.
    excluded = reachable(runtime | (scripts - certified))
    return (certified | {path for path in files if path_class(path) == 'non-product'}) - excluded


def product_paths(snapshot):
    tool_sets = [non_product_paths(tree) for tree in snapshot.source_trees]
    return [path for path in snapshot.paths if
            not (path_class(path) == 'non-product' and
                 all(path not in dict(tree) or path in tools
                     for tree, tools in zip(snapshot.source_trees, tool_sets))) and
            not (path_class(path) == 'tooling-candidate' and tool_sets and
                 any(path in tools for tools in tool_sets) and
                 all(path in tools for tree, tools in zip(snapshot.source_trees, tool_sets)
                     if path in dict(tree)))]


def source_tree(git, sha):
    entries = git('ls-tree', '-r', '-z', sha).rstrip('\0').split('\0')
    modes = {entry.partition('\t')[2]: entry.split(' ', 1)[0] for entry in entries if entry}
    paths = list(modes)
    scripts = [path for path in paths if path_class(path) == 'tooling-candidate']
    # Keep references through all file classes, including test intermediaries.
    matches = git('grep', '-I', '-z', '-o', '-E', '-e',
                  r"['\"`](\.\.?/|scripts/)[^'\"`]*['\"`]|scripts/[^[:space:]'\"`;,)]*|npm[[:space:]][^'\"`;]{0,200}|(from|import) [[:alnum:]_.]+", sha, '--')
    sources = {path: '' for path in paths}
    sources.update({'src/unclassified/' + path: "'" + path + "'" for path in scripts
                    if modes[path] not in {'100644', '100755'}})
    for line in matches.splitlines():
        name, _, text = line.partition('\0')
        path = name.removeprefix(sha + ':')
        sources[path] = sources.get(path, '') + text + '\n'
    if 'package.json' in paths:
        sources['package.json'] = git('show', sha + ':package.json')
    return tuple(sorted(sources.items()))


def admission(snapshot, validator, contract):
    if snapshot.event_name != 'pull_request':
        return Decision('skipped', 'PR admission not evaluated')
    try:
        policy = dict(contract)
        policy['x-required-targets'] = dict(contract['x-required-targets'], app=['*'])
        validator.product_paths(list(snapshot.paths), dict(contract, **{'x-non-product-paths': []}))
        product = product_paths(snapshot)
        if product and not any('app' in runner['targets'] for runner in contract['x-runners'].values()):
            raise ValueError('unsupported app production proof: pinned P1 contract has no app runner '
                             'observing deployed app /release and a live walk')
        section = declaration(snapshot.body)
        if section.lower().startswith('n/a:'):
            reason = section[4:].strip()
            if product or len(reason) < 3 or reason.lower() in {'todo', 'tbd', 'placeholder'}:
                raise ValueError('n/a requires non-product paths and a real reason')
            return Decision('admitted', 'non-product declaration accepted (admission only)')
        requirement_path(section)
        if snapshot.requirement_json is None:
            raise ValueError('declared requirement missing from PR snapshot')
        requirement = json.loads(snapshot.requirement_json)
        validator.validate(requirement, contract)
        ids = [assertion['id'] for assertion in requirement['assertions']]
        if len(set(ids)) != len(ids):
            raise ValueError('duplicate assertion IDs')
        covered = set()
        for assertion in requirement['assertions']:
            runner = contract['x-runners'].get(assertion['runner'])
            if runner is None:
                raise ValueError('unregistered runner')
            covered.update(runner['targets'])
        required = {target for target, patterns in policy['x-required-targets'].items()
                    if any(fnmatch.fnmatchcase(path, pattern) for path in product for pattern in patterns)}
        if required - set(requirement['targets']):
            raise ValueError('changed runtime target missing from declaration')
        if set(requirement['targets']) - covered:
            raise ValueError('target has no registered runner')
        return Decision('admitted', 'proof declaration accepted (admission only; execution unproven)')
    except (ValueError, KeyError, TypeError) as error:
        return Decision('refused', str(error))


def github_snapshot(event, validator, contract, root):
    pr = event['pull_request']
    base, head, body = pr['base']['sha'], pr['head']['sha'], pr['body'] or ''
    if not all(isinstance(sha, str) and re.fullmatch('[0-9a-f]{40}', sha) for sha in (base, head)):
        raise ValueError('PR base/head must be immutable commit SHAs')
    if not isinstance(body, str) or len(body.encode()) > 1048576:
        raise ValueError('PR body exceeds 1 MiB or is invalid')
    validator.github_metadata(event)

    def git(*args):
        try:
            result = subprocess.check_output(
                ['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE, timeout=15)
        except subprocess.CalledProcessError as error:
            if args[0] == 'grep' and error.returncode == 1:
                return ''
            raise
        if len(result.encode()) > 1048576:
            raise ValueError('git snapshot input exceeds 1 MiB')
        return result

    for sha in (base, head):
        if git('rev-parse', '--verify', sha + '^{commit}').strip() != sha:
            raise ValueError('PR commit identity differs')
    changed = git('diff', '--name-only', '--no-renames', '-z', base + '...' + head)
    paths = tuple(changed.rstrip('\0').split('\0')) if changed else ()
    validator.product_paths(list(paths), contract)
    section = declaration(body)
    requirement = None
    if not section.lower().startswith('n/a:'):
        path = requirement_path(section)
        entry = git('ls-tree', head, '--', path)
        if not entry.startswith(('100644 blob ', '100755 blob ')):
            raise ValueError('requirement missing or symlink at PR head')
        requirement = git('show', head + ':' + path)
    trees = tuple(source_tree(git, sha) for sha in (base, head)) if any(path_class(path) != 'runtime' for path in paths) else ()
    return Snapshot('pull_request', base, head, body, paths, requirement, trees)


def main():
    parser = argparse.ArgumentParser(description='Validate app PR production-proof admission from an immutable snapshot')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        validator, contract = load_pinned(ROOT)
        if os.environ.get('GITHUB_EVENT_NAME') != 'pull_request':
            print('Production proof: PR admission not evaluated')
            return 0
        event = json.loads(validator.read(Path(os.environ['GITHUB_EVENT_PATH'])))
        snapshot = github_snapshot(event, validator, contract, args.root)
        decision = admission(snapshot, validator, contract)
        validator.github_metadata(event)
        print('Production proof' + (' REFUSED: ' if decision.status == 'refused' else ': ') + decision.reason)
        return int(decision.status == 'refused')
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('Production proof REFUSED: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__))
        return 1


if __name__ == '__main__':
    sys.exit(main())
