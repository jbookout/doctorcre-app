import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('critical Home identities match the actual browser producer', () => {
  const file = 'test/home-sections-browser.test.mjs';
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const native = spawnSync(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=junit', file],
    { env, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(native.status, 0, native.stdout + native.stderr);
  const admission = spawnSync('python3', ['-c', `
import collections, runpy, sys
results = runpy.run_path('scripts/browser-results.py')
file = sys.argv[1]
rows, complete = results['parse_junit'](sys.stdin.read(), file)
assert complete, 'native Home report is incomplete'
required = [s for s in results['CRITICAL'] if s.startswith(file + '::')]
observed = collections.Counter(r['scenario_id'] for r in rows)
for scenario in required:
    assert observed[scenario] == 1, f'critical identity must execute exactly once: {scenario}'
    assert {'scenario_id': scenario, 'status': 'pass'} in rows, scenario
late = {file + '::at ' + now + ' tomorrow meetings stay upcoming and out of Today'
        for now in ('2026-11-03T23:00:00-06:00', '2026-11-03T23:30:00-06:00', '2026-11-03T23:59:59-06:00')}
assert late.issubset(required), 'all three late-night cases must remain critical'
`, file], { input: native.stdout, encoding: 'utf8', timeout: 10000 });
  assert.equal(admission.status, 0, admission.stdout + admission.stderr);
});
