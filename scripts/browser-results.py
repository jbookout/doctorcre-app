"""Require each shard's critical scenarios in native Node JUnit output."""
import argparse
from collections import Counter
from pathlib import Path
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

def verify(path, files, shard):
    root = ET.parse(path).getroot()
    if root.tag != 'testsuites' or not list(root.iter('testcase')):
        raise ValueError('missing native test cases')
    required_files = {s.split('::')[0] for s in CRITICAL}
    if not required_files.issubset(files):
        raise ValueError('critical test file missing from inventory')
    owned = set(files[shard - 1::4])
    required = {s.split('::', 1)[1]: s for s in CRITICAL if s.split('::')[0] in owned}
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
              for name, scenario in required.items() if counts[name] != 1]
    for name, case in cases:
        if name in required and any(case.find(tag) is not None for tag in ('skipped', 'failure', 'error')):
            errors.append(f'critical did not pass: {required[name]}')
    if errors:
        raise ValueError('\n'.join(errors))
    for scenario in required.values():
        print(f'PASS {scenario}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--shard', type=int, choices=range(1, 5), required=True)
    args = parser.parse_args()
    try:
        verify(args.input, sorted(str(p) for p in Path('test').glob('*.test.mjs')), args.shard)
    except (OSError, ValueError, ET.ParseError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
