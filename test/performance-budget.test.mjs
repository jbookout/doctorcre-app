import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBudget, limitFor, rebaseline, renderReport } from '../scripts/performance-budget.mjs';

const budget = { schema: 'doctorcre-performance-budget.v1', profile: { cpuSlowdown: 4 },
  screens: { home: { lcpMs: { baseline: 800, limit: 1200 }, jsBytes: { baseline: 10000, limit: 11000 }, interactionMs: { baseline: 40, limit: 100 } } },
  bundle: { jsBytes: { baseline: 20000, limit: 22000 } } };
const report = () => ({ schema: 'doctorcre-performance-report.v1', profile: { cpuSlowdown: 4 },
  screens: { home: { lcpMs: 1200, jsBytes: 11000, interactionMs: 100 } }, bundle: { jsBytes: 22000 } });

test('the budget accepts measured values at the limits', () => {
  assert.deepEqual(compareBudget(budget, report()), { passed: true, rows: [
    { screen: 'home', metric: 'lcpMs', before: 800, after: 1200, limit: 1200, passed: true },
    { screen: 'home', metric: 'jsBytes', before: 10000, after: 11000, limit: 11000, passed: true },
    { screen: 'home', metric: 'interactionMs', before: 40, after: 100, limit: 100, passed: true },
    { screen: 'bundle', metric: 'jsBytes', before: 20000, after: 22000, limit: 22000, passed: true },
  ] });
});

test('CLI exits 1 on a breach and 2 on incomplete evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctorcre-budget-'));
  const budgetPath = join(dir, 'budget.json'), reportPath = join(dir, 'report.json');
  writeFileSync(budgetPath, JSON.stringify(budget));
  const measured = report();
  measured.bundle.jsBytes = 22001;
  writeFileSync(reportPath, JSON.stringify(measured));
  let run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', budgetPath, reportPath], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /bundle \| jsBytes \| 20000 \| 22001 \| 22000 \| FAIL/);
  delete measured.screens.home;
  writeFileSync(reportPath, JSON.stringify(measured));
  run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', budgetPath, reportPath], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /invalid.*coverage/);
});

test('a breach names the screen, metric, baseline, measurement and limit', () => {
  const measured = report();
  measured.screens.home.lcpMs = 1201;
  const result = compareBudget(budget, measured);
  assert.equal(result.passed, false);
  assert.match(renderReport(result), /\| home \| lcpMs \| 800 \| 1201 \| 1200 \| FAIL \|/);
});

test('missing, nonfinite, zero or negative evidence cannot produce a passing gate', () => {
  for (const value of [undefined, NaN, Infinity, 0, -1, '100']) {
    const measured = report();
    measured.screens.home.lcpMs = value;
    assert.throws(() => compareBudget(budget, measured), /invalid.*home.*lcpMs/);
  }
});

test('an incomplete screen set or a changed measurement profile is invalid evidence', () => {
  const missing = report();
  delete missing.screens.home;
  assert.throws(() => compareBudget(budget, missing), /invalid/);
  const different = report();
  different.profile.cpuSlowdown = 1;
  assert.throws(() => compareBudget(budget, different), /profile/);
  assert.throws(() => compareBudget({ ...budget, screens: {} }, report()), /coverage/);
  assert.throws(() => compareBudget({ ...budget, schema: 'other' }, report()), /schema/);
});

test('removing a metric or setting a budget below its baseline cannot weaken the gate', () => {
  const missing = structuredClone(budget);
  delete missing.screens.home.jsBytes;
  assert.throws(() => compareBudget(missing, report()), /metric coverage/);
  const inverted = structuredClone(budget);
  inverted.bundle.jsBytes.limit = 19999;
  assert.throws(() => compareBudget(inverted, report()), /invalid.*bundle.*jsBytes/);
});

test('screen names in comment data must be bounded plain identifiers', () => {
  const invalid = structuredClone(budget), measured = report();
  invalid.screens['home | forged'] = invalid.screens.home;
  measured.screens['home | forged'] = measured.screens.home;
  assert.throws(() => compareBudget(invalid, measured), /screen name/);
});

const contract = () => JSON.parse(readFileSync(new URL('../contracts/performance-budget.v1.json', import.meta.url), 'utf8'));

test('every committed limit is the headroom rule applied to its measured baseline', () => {
  const committed = contract();
  for (const [screen, metrics] of [...Object.entries(committed.screens), ['bundle', committed.bundle]])
    for (const [metric, { baseline, limit }] of Object.entries(metrics))
      assert.equal(limit, limitFor(metric, baseline), `${screen} ${metric}`);
  assert.deepEqual([limitFor('jsBytes', 1000), limitFor('lcpMs', 1000), limitFor('lcpMs', 2000),
    limitFor('interactionMs', 100), limitFor('interactionMs', 200)], [1100, 1750, 3000, 250, 400]);
});

test('rebaselining from a hosted job-log line rewrites the baseline and keeps the profile', () => {
  const committed = contract();
  const measured = { schema: 'doctorcre-performance-report.v1', measuredAt: '2026-10-12T00:00:00.000Z', sourceCommit: 'a'.repeat(40),
    buildDigest: 'b'.repeat(64), browserVersion: '153.0.8010.12', nodeVersion: 'v22.23.2', platform: 'linux', profile: committed.profile,
    screens: Object.fromEntries(Object.keys(committed.screens).map(id => [id, { lcpMs: 1000, jsBytes: 600000, interactionMs: 90 }])),
    bundle: { jsBytes: 4600000, gzipBytes: 1300000 } };
  const dir = mkdtempSync(join(tmpdir(), 'doctorcre-rebaseline-'));
  const budgetPath = join(dir, 'budget.json'), logPath = join(dir, 'job.log');
  writeFileSync(budgetPath, JSON.stringify(committed));
  writeFileSync(logPath, `2026-10-12T00:00:00.0000000Z home: LCP=1000ms\n2026-10-12T00:00:00.0000000Z performance-report ${Buffer.from(JSON.stringify(measured)).toString('base64url')}\n`);
  const run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', '--rebaseline', budgetPath, logPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const next = JSON.parse(readFileSync(budgetPath, 'utf8'));
  assert.deepEqual(next.profile, committed.profile);
  assert.deepEqual(next.headroom, committed.headroom);
  assert.equal(next.baseline.platform, 'linux');
  assert.deepEqual(next.screens.home, { lcpMs: { baseline: 1000, limit: 1750 }, jsBytes: { baseline: 600000, limit: 660000 },
    interactionMs: { baseline: 90, limit: 240 } });
  assert.deepEqual(next.bundle, { jsBytes: { baseline: 4600000, limit: 5060000 } });
  assert.equal(compareBudget(next, measured).passed, true);
  delete measured.screens.home.interactionMs;
  assert.throws(() => rebaseline(committed, measured), /invalid evidence or budget: home interactionMs/);
});
