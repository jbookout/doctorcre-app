import { prepareSlices } from '../slices.mjs';
import { fileURLToPath } from 'node:url';
import { stagingWeb } from './engine.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { BudgetRefusal, SWEEP_EXPLORE, activeBudget } from './run-budget.mjs';

export const viewports = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };
export const targets = [
  { name: 'staging-live', surface: 'app', viewport: viewports.desktop },
  { name: 'staging-live-phone', surface: 'app', viewport: viewports.phone },
  { name: 'staging-live-board', surface: 'board', viewport: viewports.desktop },
  { name: 'staging-live-board-phone', surface: 'board', viewport: viewports.phone },
];
// Live staging targets exist only inside the budgeted sweep-explore runner,
// which opens the run and makes it active before the e2e SDK loads its config.
// A bare `e2e run|explore` against staging-live has no active budget and stops here.
export function stagingTargets() {
  if (activeBudget()?.profile.name !== SWEEP_EXPLORE.name) throw new BudgetRefusal('staging-not-budgeted');
  return liveTargets();
}
const liveTargets = () => targets.map(target => ({ name: target.name, engine: stagingWeb({ browser: 'chromium', viewport: target.viewport }), app: { url: STAGING_ORIGIN, environment: 'staging' } }));

export async function screens() {
  const { contract } = await prepareSlices(fileURLToPath(new URL('../../', import.meta.url)));
  const names = { '/': 'Home and Dr. CRE', '/control-room/progress': 'Progress board', '/control-room/progress/work': 'Board work and wire', '/control-room/progress/board/all-repos': 'All repositories board' };
  return [
    ...Object.entries(contract.routes).filter(([path]) => !path.includes(':')).map(([path, asset]) => ({ path, name: names[path] || asset.replace(/\.html$/, '').replaceAll('-', ' '), surface: path.startsWith('/control-room/progress') ? 'board' : 'app' })),
    { path: '/control-room/progress/board/all-repos', name: names['/control-room/progress/board/all-repos'], surface: 'board' },
    { path: '/?view=charts', name: 'Charts', surface: 'app' },
    { path: '/deals?view=national', name: 'National deals', surface: 'app' },
    { path: '/tours/day.html', name: 'Tour day', surface: 'app' },
  ];
}
