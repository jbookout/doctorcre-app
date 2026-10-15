import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJourneySelection } from './selected-journeys.mjs';
import { supervise } from './supervise.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
export function parseJourneyArgs(args) {
  if (args.length === 0) return ['W4', 'W9'];
  if (args.length !== 2 || args[0] !== '--journeys') throw new Error('Usage: npm run e2e:staging:journeys [-- --journeys W4,W9]');
  return parseJourneySelection(args[1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const suppliedArgs = process.argv.slice(2);
    if (suppliedArgs.length === 1 && suppliedArgs[0] === '--help') {
      console.log('Usage: npm run e2e:staging:journeys [-- --journeys W4,W9]\n' +
        'Select W4 and W9 by default, or one of W4/W9. Requires the staging owner session secret and a clean checkout; an explicit E2E_EXPECTED_APP_SHA may pin the deployed app revision. A missing plan is seeded with the existing baseline synthetic-record setup, which creates records beyond the selected deal journeys. No Model Room or control sweep is required. Results are selected-journey observations, never full V1 acceptance.');
      process.exit(0);
    }
    const journeys = parseJourneyArgs(suppliedArgs);
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    const expectedApp = process.env.E2E_EXPECTED_APP_SHA || checkout;
    if (!/^[a-f0-9]{40}$/.test(checkout) || !/^[a-f0-9]{40}$/.test(expectedApp) ||
        process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkout)
      throw new Error('Selected journey checkout binding refused');
    const environment = { ...process.env, GITHUB_SHA: checkout, E2E_EXPECTED_APP_SHA: expectedApp,
      E2E_STAGING_JOURNEYS: journeys.join(',') };
    const output = resolve(environment.E2E_V2_OUTPUT || join(project, '.e2e', 'bounded-run'));
    await supervise({ command: process.execPath,
      args: [join(project, 'scripts/e2e-staging/continue-run.mjs'), 'phase-worker', 'journeys'], output, environment });
  } catch (error) {
    const safe = ['selected-journey-selection-invalid', 'selected-journey-plan-required',
      'selected-journey-plan-invalid', 'selected-journey-route-unavailable', 'source-pair-mismatch',
      'checkout-mismatch', 'checkout-source-changed', 'selected-journey-session-refused',
      'selected-journey-action-proof-incomplete'];
    const code = safe.find(value => error?.message?.includes(value));
    console.error(code ? `Selected staging journeys refused: ${code}` : 'Selected staging journeys stopped; inspect the private run diagnostic.');
    process.exitCode = 1;
  }
}
