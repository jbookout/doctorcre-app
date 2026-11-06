"""Require each shard's critical scenarios in native Node JUnit output."""
import argparse
from collections import Counter
from pathlib import Path
import re
from urllib.parse import unquote
import sys
import xml.etree.ElementTree as ET

CRITICAL = (
    *(f'test/home-sections-browser.test.mjs::at {now} tomorrow meetings stay upcoming and out of Today'
      for now in ('2026-11-03T23:00:00-06:00', '2026-11-03T23:30:00-06:00', '2026-11-03T23:59:59-06:00')),
    'test/inbox-freshness-feedback-browser.test.mjs::authentication loss during a refresh retires all private cards',
    'test/deal-tours-browser.test.mjs::creation and pending-write departures preserve history and saved notes::1440 pending keep',
    *(f'test/calendar-rail-fit-browser.test.mjs::Calendar rail fits {count} meetings in {theme}'
      for theme in ('light', 'dark') for count in (0, 1, 2, 3, 6)),
    *(f'test/home-sections-browser.test.mjs::sectioned Home and shared panels {width} {theme}'
      for width in (390, 1024, 1280, 1440) for theme in ('light', 'dark')),
)

def add_failure_locations(path, repository):
    tree = ET.parse(path, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
    repository = repository.resolve()
    for case in tree.iter('testcase'):
        for issue in [*case.findall('failure'), *case.findall('error')]:
            for filename, line in re.findall(r'(?:file://)?(/[^\n()]+\.test\.mjs):(\d+):\d+', issue.text or ''):
                source = Path(unquote(filename)).resolve()
                if not source.is_relative_to(repository / 'test') or not source.is_file():
                    continue
                case.set('file', source.relative_to(repository).as_posix())
                case.set('line', line)
                break
    tree.write(path, encoding='utf-8', xml_declaration=True)


def verify(path, files, shard):
    root = ET.parse(path).getroot()
    if root.tag != 'testsuites' or not list(root.iter('testcase')):
        raise ValueError('missing native test cases')
    required_files = {s.split('::')[0] for s in CRITICAL}
    if not required_files.issubset(files):
        raise ValueError('critical test file missing from inventory')
    owned = set(files[shard - 1::4])
    required = {s for s in CRITICAL if s.split('::')[0] in owned}
    cases = []

    def visit(element, names=()):
        if element.tag == 'testsuite':
            names += (element.get('name', ''),)
        if element.tag == 'testcase':
            cases.append(('::'.join((*names, element.get('name', ''))), element))
        for child in element:
            visit(child, names)

    visit(root)
    counts = Counter(name for name, _ in cases)
    errors = [f'critical must execute exactly once: {scenario}'
              for scenario in sorted(required) if counts[scenario] != 1]
    for name, case in cases:
        if name in required and any(case.find(tag) is not None for tag in ('skipped', 'failure', 'error')):
            errors.append(f'critical did not pass: {name}')
    if errors:
        raise ValueError('\n'.join(errors))
    for scenario in sorted(required):
        print(f'PASS {scenario}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--shard', type=int, choices=range(1, 5), required=True)
    args = parser.parse_args()
    try:
        add_failure_locations(args.input, Path.cwd())
        verify(args.input, sorted(str(p) for p in Path('test').glob('*.test.mjs')), args.shard)
    except (OSError, ValueError, ET.ParseError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
