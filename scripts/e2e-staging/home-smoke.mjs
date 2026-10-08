// The read-only Home smoke. One target, two viewports, one browser context
// each, at most ten controls inventoried per viewport (never pressed), one
// bounded screenshot per viewport, no model, no fixture, no write, no trace or
// video. Every request the browser makes goes through the budgeted route and
// is charged before it is sent; anything the budget does not cover is refused.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BUDGET_DIR, BudgetRefusal, HOME_SMOKE } from './run-budget.mjs';
import { stagingSession, STAGING_ORIGIN } from './session.mjs';
import { stagingRequestAllowed } from './engine.mjs';
import { installBudgetedRoute } from './budgeted-route.mjs';
import { viewports } from './screens.mjs';
import { settledInventory } from './controls.mjs';
import { HOST_PROBE, localModelHeadroom, openWithHeadroom } from './host-headroom.mjs';

export const HOME_SMOKE_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', ...viewports.desktop }),
  Object.freeze({ name: 'phone', ...viewports.phone }),
]);

class SmokeFailure extends Error {
  constructor(phase, code, detail = {}) { super(`Home smoke failed: ${phase}/${code}`); this.failure = { phase, code, ...detail }; }
}

export function parseHomeSmokeArgs(argv) {
  if (argv.length) throw new BudgetRefusal('arguments-refused');
  return {};
}

async function measureHome({ budget, browser, state, home, viewport, allowed }) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, storageState: state, serviceWorkers: 'block' });
  const release = budget.onStop(() => context.close());
  try {
    await installBudgetedRoute(context, budget, { allowed });
    const page = await context.newPage();
    let response;
    try { response = await page.goto(home.href, { waitUntil: 'domcontentloaded', timeout: budget.timeoutMs() }); }
    catch { throw new SmokeFailure('navigation', 'navigation-failed'); }
    if (!response?.ok() || new URL(page.url()).origin !== home.origin) throw new SmokeFailure('navigation', 'home-response-refused');
    try { await page.waitForLoadState('networkidle', { timeout: budget.timeoutMs() }); }
    catch { throw new SmokeFailure('load', 'network-idle-failed'); }
    let listed;
    try { listed = await settledInventory(page, { timeoutMs: budget.timeoutMs() }); }
    catch { throw new SmokeFailure('inventory', 'inventory-failed'); }
    budget.throwIfStopped();
    const measured = listed.slice(0, budget.profile.controlsPerViewport);
    await budget.reserve('control', measured.length);
    const screenshot = await budget.captureScreenshot(page, `home-${viewport.name}.jpg`);
    budget.throwIfStopped();
    return {
      viewport: viewport.name, visible_controls: listed.length,
      controls: measured.map(({ name, role, disabled, reason }) => ({ name, role, disabled, ...(disabled ? { reason } : {}) })),
      screenshot,
    };
  } finally {
    release();
    await context.close().catch(() => {});
  }
}

// The second line of the host-headroom guard: checked again inside the run,
// before the preflight and before every viewport.
async function requireHeadroom(budget, host) {
  const crowded = await localModelHeadroom({ floorBytes: budget.profile.memoryFloorBytes, probe: host });
  if (crowded) throw new SmokeFailure('host-headroom', 'local_model_resident', crowded);
}

export async function homeSmoke({
  budget, browser, origin = STAGING_ORIGIN, allowed = stagingRequestAllowed,
  session = () => stagingSession(STAGING_ORIGIN, { budget }), viewports: planned = HOME_SMOKE_VIEWPORTS, host = HOST_PROBE,
}) {
  const profile = budget.profile;
  if (profile.model || profile.mutation || profile.fixture || profile.ownerState || profile.trace || profile.video || profile.aiTrace)
    throw new BudgetRefusal('profile-not-read-only');
  const home = new URL('/', origin);
  if (!allowed(home)) throw new BudgetRefusal('origin-refused');
  const rows = [];
  let failure = null;
  try {
    await requireHeadroom(budget, host);
    await budget.reserve('target');
    const { state } = await session();
    for (const viewport of planned) {
      await requireHeadroom(budget, host);
      await budget.reserve('viewport');
      await budget.reserve('context');
      rows.push(await measureHome({ budget, browser, state, home, viewport, allowed }));
    }
  } catch (error) {
    failure = error instanceof BudgetRefusal ? { phase: 'budget', code: error.code }
      : error instanceof SmokeFailure ? error.failure : { phase: 'preflight', code: String(error?.code || 'unexpected-failure') };
    await budget.stop(error instanceof BudgetRefusal ? error.code
      : failure.code === 'local_model_resident' ? 'local_model_resident' : 'infrastructure-failure:' + failure.code);
  }
  return budget.finish({
    schema: 'home-smoke-receipt.v1', origin: home.origin, coverage: 'bounded read-only Home sample; controls inventoried, never pressed',
    qualified: !failure && rows.length === planned.length, viewports: rows, failure,
  });
}

// The command-line run: host headroom is checked before the authorization is
// opened, so a crowded host never spends it.
export async function runHomeSmoke({ dir = BUDGET_DIR, host = HOST_PROBE, launch = () => chromium.launch(), clock } = {}) {
  const budget = await openWithHeadroom({ dir, profile: HOME_SMOKE.name, host, clock });
  let browser;
  try {
    browser = await launch();
  } catch {
    await budget.stop('infrastructure-failure:launch');
    return budget.finish({ schema: 'home-smoke-receipt.v1', qualified: false, viewports: [], failure: { phase: 'launch', code: 'browser-launch-failed' } });
  }
  try { return await homeSmoke({ budget, browser, host }); }
  finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    parseHomeSmokeArgs(process.argv.slice(2));
    const receipt = await runHomeSmoke();
    console.log(`Home smoke ${receipt.qualified ? 'qualified' : 'NOT qualified'}; stopped: ${receipt.stopped.reason}`);
    if (!receipt.qualified) process.exitCode = 1;
  }).catch(error => { console.error(error instanceof BudgetRefusal ? error.message : 'Home smoke failed before a budget opened'); process.exitCode = 1; });
}
