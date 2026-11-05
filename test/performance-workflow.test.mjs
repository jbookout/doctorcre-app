import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compareBudget } from '../scripts/performance-budget.mjs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const performanceJob = ci.split(/^  performance:\n/m)[1].split(/^  \w+:/m)[0];

test('main and PR run the same performance build, measurement and evidence steps', () => {
  assert.doesNotMatch(performanceJob, /github\.event_name/);
  assert.match(performanceJob, /ref: \$\{\{ github.sha \}\}/);
  assert.match(performanceJob, /node-version: 22\.23\.4/);
  assert.match(performanceJob, /run: npm run build[\s\S]*run: npm run performance:check/);
  assert.match(performanceJob, /if: \$\{\{ !cancelled\(\) \}\}[\s\S]*uses: actions\/upload-artifact@/);
  assert.match(performanceJob, /name: Publish performance summary\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
});

test('both event aggregates reject failed, cancelled or skipped performance', () => {
  const aggregate = ci.split(/^  test:\n/m)[1].split(/^  preview:/m)[0];
  const shell = aggregate.split('        run: |\n')[1].replace(/^          /gm, '');
  for (const event of ['push', 'pull_request']) {
    for (const performance of ['success', 'failure', 'cancelled', 'skipped']) {
      const run = spawnSync('bash', ['-e', '-c', shell], { encoding: 'utf8',
        env: { ...process.env, CHECKS: 'success', SHARDS: 'success', LIVE: 'success',
          PRODUCTION_PROOF: event === 'push' ? 'skipped' : 'success', PERFORMANCE: performance, EVENT: event } });
      assert.equal(run.status === 0, performance === 'success', `${event} ${performance}`);
    }
  }
});

test('unchanged Home budget rejects a genuine five-sample load regression', () => {
  const budget = JSON.parse(readFileSync(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
  assert.deepEqual(budget.homeLoad, { samples: 5, limitMs: 4000 });
  const screens = Object.fromEntries(Object.entries(budget.screens).map(([id, metrics]) => [id,
    Object.fromEntries(Object.entries(metrics).map(([metric, value]) => [metric, value.baseline]))]));
  screens.home.jsBytes = 695298;
  screens.home.samples = [3992, 4000, 4008, 4008, 4036].map(lcpMs => ({ lcpMs }));
  screens.home.lcpMs = 4008;
  const report = { schema: 'doctorcre-performance-report.v1', profile: budget.profile, screens };
  const regression = compareBudget(budget, report);
  assert.equal(regression.passed, false);
  assert.deepEqual(regression.rows.filter(row => !row.passed).map(row => [row.screen, row.metric]), [['home', 'lcpMs']]);
  screens.home.samples = [3700, 3750, 3780, 3800, 3900].map(lcpMs => ({ lcpMs }));
  screens.home.lcpMs = 3780;
  assert.equal(compareBudget(budget, report).passed, true);
});
