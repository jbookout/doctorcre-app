import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBudget, renderReport } from '../scripts/performance-budget.mjs';

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
