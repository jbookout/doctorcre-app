"""Collect native Node JUnit evidence and require complete critical execution."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import subprocess
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

CRITICAL = (
    'test/home-sections-browser.test.mjs::at 23:30 Central tomorrow meetings stay upcoming and out of Today',
    'test/inbox-freshness-feedback-browser.test.mjs::authentication loss during a refresh retires all private cards',
    'test/deal-tours-browser.test.mjs::creation and pending-write departures preserve history and saved notes::1440 pending keep',
    *(f'test/calendar-rail-fit-browser.test.mjs::Calendar rail fits {count} meetings in {theme}'
      for theme in ('light', 'dark') for count in (0, 1, 2, 3, 6)),
    *(f'test/home-sections-browser.test.mjs::sectioned Home and shared panels {width} {theme}'
      for width in (390, 1024, 1280, 1440) for theme in ('light', 'dark')),
)
STATUSES = {'pass', 'fail', 'skip', 'cancelled'}


def parse_junit(source, source_file=None):
    parser = ET.XMLPullParser(events=('start', 'end'))
    stack, receipts = [], []
    complete = False
    try:
        for line in source.splitlines(keepends=True):
            parser.feed(line)
            for event, element in parser.read_events():
                if event == 'start':
                    stack.append(element)
                    continue
                if element.tag == 'testcase':
                    file = (source_file or element.get('file', '')).replace('\\', '/')
                    file = 'test/' + file.rsplit('/test/', 1)[1] if '/test/' in file else file
                    if not file.startswith('test/') or not element.get('name'):
                        raise ValueError('JUnit testcase lacks repository file or name')
                    names = [e.get('name') for e in stack[:-1] if e.tag == 'testsuite']
                    failure = element.find('failure')
                    error = element.find('error')
                    problem = failure if failure is not None else error
                    status = 'pass'
                    if element.find('skipped') is not None:
                        status = 'skip'
                    elif problem is not None:
                        kind = problem.get('type', '')
                        status = 'cancelled' if kind in {'cancelledByParent', 'testTimeoutFailure', 'testAborted'} else 'fail'
                    receipts.append(dict(scenario_id='::'.join([file, *names, element.get('name')]),
                                         status=status))
                if element.tag == 'testsuites':
                    complete = True
                stack.pop()
        parser.close()
    except ET.ParseError:
        complete = False
    return receipts, complete


def verify(reports, sha, run_id, attempt):
    errors, shards, seen = [], set(), set()
    for report in reports:
        shard = report['shard']
        if shard in shards:
            errors.append(f'duplicate shard {shard}')
        shards.add(shard)
        if (report['schema'], report['sha'], report['run_id'], report['attempt']) != ('browser-results.v1', sha, run_id, attempt):
            errors.append(f'identity mismatch in shard {shard}')
        if not report['complete'] or report['job_status'] != 'success':
            errors.append(f'incomplete or unsuccessful shard {shard}')
        for receipt in report['receipts']:
            scenario = receipt['scenario_id']
            if scenario in seen:
                errors.append(f'duplicate receipt {scenario}')
            seen.add(scenario)
            if receipt['status'] not in STATUSES or receipt['status'] in {'fail', 'cancelled'}:
                errors.append(f"{receipt['status']}: {scenario}")
            if scenario in CRITICAL and receipt['status'] != 'pass':
                errors.append(f'critical scenario did not pass: {scenario}')
    if shards != {'1', '2', '3', '4'}:
        errors.append('missing or unexpected shard receipts')
    errors.extend(f'never-executed: {scenario}' for scenario in CRITICAL if scenario not in seen)
    return errors


def run_shard(directory, shard):
    files = [str(p) for p in sorted(Path('test').glob('*.test.mjs'))][int(shard)-1::4]
    directory.mkdir(parents=True)
    (directory / 'planned.json').write_text(json.dumps(files))

    def run_file(file):
        stem = directory / Path(file).name
        stem.with_suffix('.started').touch()
        command = ['node', '--test', '--test-timeout=180000', '--test-reporter=spec',
                   '--test-reporter-destination=stdout', '--test-reporter=junit',
                   '--test-reporter-destination=' + str(stem.with_suffix('.xml')), file]
        result = subprocess.run(command, check=False)
        stem.with_suffix('.exit').write_text(str(result.returncode))
        return result.returncode

    with ThreadPoolExecutor(max_workers=2) as pool:
        return int(any(list(pool.map(run_file, files))))


def collect(directory):
    planned = directory / 'planned.json'
    files = json.loads(planned.read_text()) if planned.exists() else []
    receipts, complete = [], bool(files)
    for file in files:
        stem = directory / Path(file).name
        xml = stem.with_suffix('.xml')
        rows, ended = parse_junit(xml.read_text() if xml.exists() else '', file)
        exit_file = stem.with_suffix('.exit')
        finished = ended and exit_file.exists()
        complete = complete and finished
        receipts.extend(rows)
        status = ('pass' if exit_file.read_text() == '0' else 'fail') if finished else (
            'cancelled' if stem.with_suffix('.started').exists() else 'never-executed')
        receipts.append(dict(scenario_id=file, status=status))
    return receipts, complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('run', 'collect', 'verify'))
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--sha')
    parser.add_argument('--run-id')
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--shard', choices=('1', '2', '3', '4'))
    parser.add_argument('--job-status', choices=('success', 'failure', 'cancelled', 'skipped'))
    args = parser.parse_args()
    if args.mode == 'run':
        if not args.shard:
            parser.error('run requires shard')
        return run_shard(args.input, args.shard)
    if not args.output or not args.sha or not args.run_id or not args.attempt:
        parser.error('collect and verify require output, sha, run-id and attempt')
    if args.attempt < 1 or len(args.sha) != 40 or any(c not in '0123456789abcdef' for c in args.sha):
        parser.error('expected full SHA and positive attempt')
    identity = dict(schema='browser-results.v1', sha=args.sha, run_id=args.run_id, attempt=args.attempt)
    if args.mode == 'collect':
        if not args.shard or not args.job_status:
            parser.error('collect requires shard and job-status')
        rows, complete = collect(args.input)
        report = dict(**identity, shard=args.shard, job_status=args.job_status, complete=complete, receipts=rows)
        errors = [] if complete and args.job_status == 'success' else ['incomplete or unsuccessful shard']
        if any(r['status'] in {'fail', 'cancelled'} for r in rows):
            errors.append('unsuccessful first-attempt test')
    else:
        reports, errors = [], []
        for path in sorted(args.input.rglob('receipt.json')):
            try:
                value = json.loads(path.read_text())
                verify([value], args.sha, args.run_id, args.attempt)
                reports.append(value)
            except (ValueError, KeyError, TypeError) as error:
                errors.append(f'invalid receipt {path}: {error}')
        errors.extend(verify(reports, args.sha, args.run_id, args.attempt))
        critical = []
        for scenario in CRITICAL:
            matches = [dict(sha=r['sha'], run_id=r['run_id'], attempt=r['attempt'], shard=r['shard'], **row)
                       for r in reports for row in r['receipts'] if row['scenario_id'] == scenario]
            critical.extend(matches or [dict(scenario_id=scenario, status='never-executed',
                                            sha=args.sha, run_id=args.run_id, attempt=args.attempt, shard=None)])
        report = dict(**identity, critical=critical)
    report['errors'] = errors
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for error in errors:
        print(error, file=sys.stderr)
    return int(bool(errors))


if __name__ == '__main__':
    sys.exit(main())
