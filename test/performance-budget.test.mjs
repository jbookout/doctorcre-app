import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareBudget, limitFor, rebaseline, renderReport } from '../scripts/performance-budget.mjs';

const budget = { schema: 'doctorcre-performance-budget.v1', profile: { cpuSlowdown: 4 }, homeLoad: { samples: 5, limitMs: 1200 },
  screens: { home: { lcpMs: { baseline: 800 }, interactionMs: { baseline: 40, limit: 100 } } } };
const report = () => ({ schema: 'doctorcre-performance-report.v1', profile: { cpuSlowdown: 4 },
  screens: { home: { lcpMs: 1200, jsBytes: 11000, interactionMs: 100, samples: Array.from({ length: 5 }, () => ({ lcpMs: 1200 })) } } });

test('task budgets reject slow useful content, extra reads, and critical bytes independently', () => {
  const extended = structuredClone(budget), measured = report();
  extended.screens['task-leads'] = {
    lcpMs: { baseline: 800, limit: 1550 },
    usefulMs: { baseline: 1000, limit: 1750 },
    requestCount: { baseline: 3, limit: 3 },
    criticalBytes: { baseline: 10000, limit: 11000 },
  };
  measured.screens['task-leads'] = { lcpMs: 1550, usefulMs: 1750, requestCount: 3, criticalBytes: 11000 };
  assert.equal(compareBudget(extended, measured).passed, true);
  for (const [metric, value] of Object.entries({ lcpMs: 1551, usefulMs: 1751, requestCount: 4, criticalBytes: 11001 })) {
    const breach = structuredClone(measured);
    breach.screens['task-leads'][metric] = value;
    const result = compareBudget(extended, breach);
    assert.equal(result.passed, false);
    assert.match(renderReport(result), new RegExp(`task-leads \\| ${metric} .* FAIL`));
  }
  for (const metric of ['lcpMs', 'usefulMs', 'requestCount', 'criticalBytes']) {
    const missing = structuredClone(measured);
    delete missing.screens['task-leads'][metric];
    assert.throws(() => compareBudget(extended, missing), /invalid evidence/);
  }
  extended.screens['task-leads'].requestCount = { baseline: 0, limit: 0 };
  measured.screens['task-leads'].requestCount = 0;
  assert.equal(compareBudget(extended, measured).passed, true, 'offline tasks may issue no reads');
  measured.screens['task-leads'].requestCount = 0.5;
  assert.throws(() => compareBudget(extended, measured), /invalid evidence/);
});

test('task rebaselines retain their metrics and bind provenance to the new run', () => {
  const extended = structuredClone(budget), measured = report();
  extended.screens['task-tour-offline'] = {
    lcpMs: { baseline: 800, limit: 1550 },
    usefulMs: { baseline: 1000, limit: 1750 }, requestCount: { baseline: 2, limit: 2 },
    criticalBytes: { baseline: 10000, limit: 11000 },
  };
  measured.screens['task-tour-offline'] = { lcpMs: 1000, usefulMs: 1200, requestCount: 0, criticalBytes: 9000 };
  measured.sourceCommit = 'c'.repeat(40);
  measured.taskMeasurement = { policy: 'synthetic offline reload' };
  const next = rebaseline(extended, measured);
  assert.deepEqual(next.screens['task-tour-offline'], {
    lcpMs: { baseline: 1000, limit: 1750 },
    criticalBytes: { baseline: 9000, limit: 9900 }, requestCount: { baseline: 0, limit: 0 },
    usefulMs: { baseline: 1200, limit: 1950 },
  });
  assert.equal(next.taskBaseline.sourceCommit, measured.sourceCommit);
  assert.deepEqual(next.taskBaseline.measurement, measured.taskMeasurement);
});

test('the budget accepts measured values at the limits', () => {
  assert.deepEqual(compareBudget(budget, report()), { passed: true, rows: [
    { screen: 'home', metric: 'lcpMs', before: 800, after: 1200, limit: 1200, passed: true },
    { screen: 'home', metric: 'interactionMs', before: 40, after: 100, limit: 100, passed: true },
  ], homeSamples: [1200, 1200, 1200, 1200, 1200], homeJsBytes: 11000 });
});

test('CLI exits 1 on a breach and 2 on incomplete evidence', t => {
  const dir = temporaryDirectory('doctorcre-budget-', t);
  const budgetPath = join(dir, 'budget.json'), reportPath = join(dir, 'report.json');
  writeFileSync(budgetPath, JSON.stringify(budget));
  const measured = report();
  measured.screens.home.interactionMs = 101;
  writeFileSync(reportPath, JSON.stringify(measured));
  let run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', budgetPath, reportPath], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /home \| interactionMs \| 40 \| 101 \| 100 \| FAIL/);
  delete measured.screens.home;
  writeFileSync(reportPath, JSON.stringify(measured));
  run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', budgetPath, reportPath], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /invalid.*coverage/);
});

test('a breach names the screen, metric, baseline, measurement and limit', () => {
  const measured = report();
  measured.screens.home.lcpMs = 1201;
  measured.screens.home.samples = Array.from({ length: 5 }, () => ({ lcpMs: 1201 }));
  const result = compareBudget(budget, measured);
  assert.equal(result.passed, false);
  assert.match(renderReport(result), /\| home \| lcpMs \| 800 \| 1201 \| 1200 \| FAIL \|/);
});

test('missing, nonfinite, zero or negative evidence cannot produce a passing gate', () => {
  for (const value of [undefined, NaN, Infinity, 0, -1, '100']) {
    const measured = report();
    measured.screens.home.lcpMs = value;
    assert.throws(() => compareBudget(budget, measured), /invalid.*Home/i);
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
  delete missing.screens.home.interactionMs;
  assert.throws(() => compareBudget(missing, report()), /metric coverage/);
  const inverted = structuredClone(budget);
  inverted.screens.home.interactionMs.limit = 1;
  assert.throws(() => compareBudget(inverted, report()), /invalid.*home.*interactionMs/);
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
  for (const [screen, metrics] of Object.entries(committed.screens))
    for (const [metric, { baseline, limit }] of Object.entries(metrics))
      if (!(screen === 'home' && metric === 'lcpMs')) assert.equal(limit, limitFor(metric, baseline), `${screen} ${metric}`);
  assert.deepEqual([limitFor('jsBytes', 1000), limitFor('lcpMs', 1000), limitFor('lcpMs', 2000),
    limitFor('interactionMs', 100), limitFor('interactionMs', 200)], [1100, 1750, 3000, 250, 400]);
});

test('rebaselining from a hosted job-log line rewrites the baseline and keeps the profile', t => {
  const committed = contract();
  const measured = { schema: 'doctorcre-performance-report.v1', measuredAt: '2026-10-12T00:00:00.000Z', sourceCommit: 'a'.repeat(40),
    buildDigest: 'b'.repeat(64), browserVersion: '153.0.8010.12', nodeVersion: 'v22.23.2', platform: 'linux', profile: committed.profile,
    screens: Object.fromEntries(Object.keys(committed.screens).map(id => [id, id.startsWith('task-')
      ? { lcpMs: 1000, usefulMs: 1500, requestCount: 5, criticalBytes: 700000 }
      : { lcpMs: 1000, jsBytes: 600000, interactionMs: 90 }])),
    bundle: { jsBytes: 4600000, gzipBytes: 1300000 } };
  measured.screens.home.samples = Array.from({ length: committed.homeLoad.samples }, () => ({ lcpMs: 1000 }));
  const dir = temporaryDirectory('doctorcre-rebaseline-', t);
  const budgetPath = join(dir, 'budget.json'), logPath = join(dir, 'job.log');
  writeFileSync(budgetPath, JSON.stringify(committed));
  writeFileSync(logPath, `2026-10-12T00:00:00.0000000Z home: LCP=1000ms\n2026-10-12T00:00:00.0000000Z performance-report ${Buffer.from(JSON.stringify(measured)).toString('base64url')}\n`);
  const run = spawnSync(process.execPath, ['scripts/performance-budget.mjs', '--rebaseline', budgetPath, logPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const next = JSON.parse(readFileSync(budgetPath, 'utf8'));
  assert.deepEqual(next.profile, committed.profile);
  assert.deepEqual(next.headroom, committed.headroom);
  assert.equal(next.baseline.platform, 'linux');
  assert.deepEqual(next.screens.home, { interactionMs: { baseline: 90, limit: 240 }, lcpMs: { baseline: 1000 },
    });
  assert.equal(next.bundle, undefined);
  assert.equal(compareBudget(next, measured).passed, true);
  delete measured.screens.home.interactionMs;
  assert.throws(() => rebaseline(committed, measured), /invalid evidence or budget: home interactionMs/);
});

test('Home load gate uses five cold LCP samples and reports JS without a byte limit', () => {
  const policy = structuredClone(budget), measured = report();
  policy.homeLoad = { samples: 5, limitMs: 4000 };
  delete policy.screens.home.jsBytes;
  delete policy.screens.home.lcpMs.limit;
  measured.screens.home.jsBytes = 9999999;
  measured.screens.home.samples = [3900, 4100, 4000, 3800, 4200].map(lcpMs => ({ lcpMs }));
  measured.screens.home.lcpMs = 4000;
  assert.equal(compareBudget(policy, measured).passed, true);
  measured.screens.home.samples = [4100, 4200, 4300, 3900, 4400].map(lcpMs => ({ lcpMs }));
  measured.screens.home.lcpMs = 4200;
  const result = compareBudget(policy, measured);
  assert.equal(result.passed, false);
  assert.match(renderReport(result), /4100, 4200, 4300, 3900, 4400/);
  assert.match(renderReport(result), /9999999/);
  measured.screens.home.samples.pop();
  assert.throws(() => compareBudget(policy, measured), /samples/);
});
