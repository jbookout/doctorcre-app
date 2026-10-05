import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same contract as CARR's performance-budget-gate.py: measurements are supplied,
// validated, and compared; this module never invents successful evidence.
export function compareBudget(budget, report) {
  if (budget.schema !== 'doctorcre-performance-budget.v1' || report.schema !== 'doctorcre-performance-report.v1') throw Error('invalid schema');
  if (!isDeepStrictEqual(budget.profile, report.profile)) throw Error('invalid measurement profile');
  if (!Object.keys(budget.screens || {}).length || !isDeepStrictEqual(Object.keys(budget.screens).sort(), Object.keys(report.screens || {}).sort())) throw Error('invalid screen coverage');
  const rows = [];
  for (const [screen, metrics] of [...Object.entries(budget.screens), ['bundle', budget.bundle]]) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(screen)) throw Error('invalid screen name');
    const expected = screen === 'bundle' ? ['jsBytes'] : ['interactionMs', 'jsBytes', 'lcpMs'];
    if (!isDeepStrictEqual(Object.keys(metrics || {}).sort(), expected)) throw Error(`invalid metric coverage: ${screen}`);
    const measured = screen === 'bundle' ? report.bundle : report.screens?.[screen];
    for (const [metric, { baseline: before, limit }] of Object.entries(metrics)) {
      const after = measured?.[metric];
      if (![before, limit, after].every(value => Number.isFinite(value) && value > 0) || limit < before) {
        throw Error(`invalid evidence or budget: ${screen} ${metric}`);
      }
      rows.push({ screen, metric, before, after, limit, passed: after <= limit });
    }
  }
  return { passed: rows.every(row => row.passed), rows };
}

export function renderReport(result) {
  return ['<!-- doctorcre-performance-budget -->', '### Mobile performance budget', '',
    '| Screen | Metric | Before | After | Budget | Result |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...result.rows.map(row => `| ${row.screen} | ${row.metric} | ${row.before} | ${row.after} | ${row.limit} | ${row.passed ? 'PASS' : 'FAIL'} |`),
    '', 'On breach: PR author reduces the named screen/metric and reruns `npm run performance:check`; the check clears when every measurement is within budget.', ''].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
