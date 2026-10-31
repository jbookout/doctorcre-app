import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const metricNames = screen => screen.startsWith('task-') ? ['criticalBytes', 'lcpMs', 'requestCount', 'usefulMs']
  : screen === 'home' ? ['interactionMs', 'lcpMs'] : ['interactionMs', 'jsBytes', 'lcpMs'];

// Same contract as CARR's performance-budget-gate.py: measurements are supplied,
// validated, and compared; this module never invents successful evidence.
export function compareBudget(budget, report) {
  if (budget?.schema !== 'doctorcre-performance-budget.v1' || report?.schema !== 'doctorcre-performance-report.v1') throw Error('invalid schema');
  if (!isDeepStrictEqual(budget.profile, report.profile)) throw Error('invalid measurement profile');
  if (!Object.keys(budget.screens || {}).length || !isDeepStrictEqual(Object.keys(budget.screens).sort(), Object.keys(report.screens || {}).sort())) throw Error('invalid screen coverage');
  const rows = [];
  const home = report.screens.home;
  const policy = budget.homeLoad;
  const samples = home?.samples?.map(sample => sample.lcpMs);
  if (!Number.isSafeInteger(policy?.samples) || policy.samples < 5 || policy.samples % 2 !== 1 ||
      !Number.isFinite(policy.limitMs) || policy.limitMs <= 0 || samples?.length !== policy.samples ||
      !samples.every(value => Number.isFinite(value) && value > 0)) throw Error('invalid Home load samples or policy');
  const median = [...samples].sort((a, b) => a - b)[samples.length >> 1];
  if (home.lcpMs !== median || !Number.isFinite(home.jsBytes) || home.jsBytes <= 0) throw Error('invalid Home load evidence');
  for (const [screen, metrics] of Object.entries(budget.screens)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(screen)) throw Error('invalid screen name');
    const expected = metricNames(screen);
    if (!isDeepStrictEqual(Object.keys(metrics || {}).sort(), expected)) throw Error(`invalid metric coverage: ${screen}`);
    const measured = report.screens?.[screen];
    for (const [metric, { baseline: before, limit: configuredLimit }] of Object.entries(metrics)) {
      const limit = screen === 'home' && metric === 'lcpMs' ? policy.limitMs : configuredLimit;
      const after = measured?.[metric];
      const valid = value => metric === 'requestCount' ? Number.isSafeInteger(value) && value >= 0
        : Number.isFinite(value) && value > 0;
      if (![before, limit, after].every(valid) || (limit < before && !(screen === 'home' && metric === 'lcpMs'))) {
        throw Error(`invalid evidence or budget: ${screen} ${metric}`);
      }
      rows.push({ screen, metric, before, after, limit, passed: after <= limit });
    }
  }
  const react = report.reactHome;
  if (react || report.taskMeasurement?.scenarios?.['task-react-home']) {
    const samples = react?.samples;
    if (samples?.length !== policy.samples || samples.some(sample => !Number.isFinite(sample.lcpMs) || sample.lcpMs <= 0 || !Number.isFinite(sample.usefulMs) || sample.usefulMs <= 0 || !Array.isArray(sample.reads) || sample.reads.filter(name => name === 'read-home-inbox').length !== 1 || sample.reads.some(name => ['get-deal-room', 'read-task', 'read-home-agenda', 'getDeal'].includes(name)))) throw Error('invalid React Home bounded-read evidence');
    for (const metric of ['lcpMs', 'usefulMs']) {
      const median = samples.map(sample => sample[metric]).sort((a, b) => a - b)[samples.length >> 1];
      if (react[metric] !== median) throw Error('invalid React Home median evidence');
      rows.push({ screen: 'react-home', metric, before: budget.screens.home.lcpMs.baseline, after: median, limit: policy.limitMs, passed: median <= policy.limitMs });
    }
  }
  return { ...(react ? { reactHomeSamples: react.samples.map(sample => sample.lcpMs) } : {}), passed: rows.every(row => row.passed), rows, homeSamples: samples, homeJsBytes: home.jsBytes };
}

// The one headroom rule. contracts/performance-budget.v1.json describes it in
// prose; a test keeps every committed limit equal to this applied to its baseline.
export const limitFor = (metric, baseline) => metric === 'requestCount' ? baseline
  : ['jsBytes', 'criticalBytes'].includes(metric) ? Math.ceil(baseline * 1.1)
  : ['lcpMs', 'usefulMs'].includes(metric) ? baseline + Math.max(Math.ceil(baseline / 2), 750)
  : baseline + Math.max(baseline, 150);

// Re-measures the baseline from a complete report under the same profile. The
// result is a reviewable contract diff, never a silent widening.
export function rebaseline(budget, report) {
  const metrics = values => Object.fromEntries(Object.keys(values).map(metric =>
    [metric, { baseline: values[metric], limit: limitFor(metric, values[metric]) }]));
  const provenance = { measuredAt: report.measuredAt, sourceCommit: report.sourceCommit, buildDigest: report.buildDigest,
    browserVersion: report.browserVersion, nodeVersion: report.nodeVersion, platform: report.platform };
  const draft = { ...budget,
    baseline: provenance,
    ...(Object.keys(budget.screens).some(id => id.startsWith('task-'))
      ? { taskBaseline: { ...provenance, measurement: report.taskMeasurement } } : {}),
    screens: Object.fromEntries(Object.keys(budget.screens).map(id => [id,
      Object.fromEntries(metricNames(id).map(metric => [metric, id === 'home' && metric === 'lcpMs'
        ? { baseline: report.screens?.[id]?.[metric] } : metrics({ [metric]: report.screens?.[id]?.[metric] })[metric]]))])) };
  if (!compareBudget(draft, report).passed) throw Error('rebaseline did not reproduce its own report');
  return draft;
}

export function renderReport(result) {
  return ['<!-- doctorcre-performance-budget -->', '### Mobile performance budget', '',
    '| Screen | Metric | Before | After | Budget | Result |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...result.rows.map(row => `| ${row.screen} | ${row.metric} | ${row.before} | ${row.after} | ${row.limit} | ${row.passed ? 'PASS' : 'FAIL'} |`),
    '', `Home LCP samples (ms): ${result.homeSamples.join(', ')}. Median: ${[...result.homeSamples].sort((a, b) => a - b)[result.homeSamples.length >> 1]} ms.`,
    `Home transferred JS: ${result.homeJsBytes} bytes (informational).`,
    ...(result.reactHomeSamples ? [`React Home LCP samples (ms): ${result.reactHomeSamples.join(', ')}. One bounded snapshot per sample.`] : []),
    '', 'On breach: PR author reduces the named screen/metric and reruns `npm run performance:check`; the check clears when every measurement is within budget.', ''].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--rebaseline') {
  const [budgetPath, reportPath] = process.argv.slice(3);
  const budget = JSON.parse(readFileSync(budgetPath));
  // Accepts report.json or a job log holding its `performance-report <base64url>` line.
  const text = readFileSync(reportPath, 'utf8');
  const line = text.match(/performance-report ([A-Za-z0-9_-]+)/);
  const report = JSON.parse(line ? Buffer.from(line[1], 'base64url').toString('utf8') : text);
  writeFileSync(budgetPath, JSON.stringify(rebaseline(budget, report), null, 2) + '\n');
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [budgetPath, reportPath, outputPath] = process.argv.slice(2);
    const budget = JSON.parse(readFileSync(budgetPath));
    const report = JSON.parse(readFileSync(reportPath));
    const result = compareBudget(budget, report);
    // Carry the exact evaluated budget to the trusted comment writer, including
    // intentional budget changes proposed in this PR. This remains data only.
    writeFileSync(reportPath, JSON.stringify({ ...report, evaluatedBudget: budget }, null, 2) + '\n');
    const text = renderReport(result);
    if (outputPath) writeFileSync(outputPath, text);
    console.log(text);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(`performance-budget: invalid evidence: ${error.message}`);
    process.exitCode = 2;
  }
}
