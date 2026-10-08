// The read-only Home smoke: the only live staging run an approved budget
// funds. One target, two viewports, one browser context each, at most ten
// controls inventoried per viewport (never pressed), one bounded screenshot
// per viewport, no model, no fixture, no write, no trace or video. Every
// request the browser makes is reserved against the shared RunBudget before it
// is forwarded; anything the budget does not cover is refused, not escaped.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { BudgetRefusal, createRunBudget } from './run-budget.mjs';
import { stagingSession, STAGING_ORIGIN } from './session.mjs';
import { stagingRequestAllowed, hideCredentialPixels } from './engine.mjs';
import { viewports } from './screens.mjs';
import { settledInventory } from './controls.mjs';
import { HOST_PROBE, localModelHeadroom } from './host-headroom.mjs';

export const HOME_SMOKE_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', ...viewports.desktop }),
  Object.freeze({ name: 'phone', ...viewports.phone }),
]);

// Read verbs the app issues over POST /mcp. A POST that is not one of these
// exact tools/call reads is treated as a write and refused: the Home smoke has
// a zero mutation budget, and an unknown verb is never assumed to be safe.
export const READ_VERBS = new Set([
  'capture-queue', 'correspondence-readiness', 'current-work-item', 'current-work-requests', 'deal-room-board',
  'engineering-passport', 'find', 'find-and-catch-up', 'get-call-context', 'get-deal-room', 'get-incident',
  'governance-queue', 'incident-board', 'lead-board', 'list-doc-conversations', 'list-doc-suggestions',
  'list-industry-events', 'list-my-codex-sessions', 'list-progress-boards', 'loop-board', 'loop-headers',
  'morning-brief', 'notification-feed', 'read-assurance-health', 'read-correspondence-thread', 'read-dispatch-history',
  'read-doc-activity', 'read-doc-conversation', 'read-doc-outcome-cards', 'read-invoice-tracker', 'read-loop',
  'read-notification-preferences', 'read-portfolio', 'read-progress-board', 'read-resource-dashboard', 'read-room',
  'read-room-queue', 'read-session-identity', 'schedule-board', 'today-triage', 'unfinished-work', 'work-request-card',
]);

class SmokeFailure extends Error {
  constructor(phase, code) { super(`Home smoke failed: ${phase}/${code}`); this.failure = { phase, code }; }
}

export function parseHomeSmokeArgs(argv) {
  if (argv.length) throw new BudgetRefusal('arguments-refused');
  return {};
}

function isRead(request) {
  if (['GET', 'HEAD'].includes(request.method())) return true;
  if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/mcp') return false;
  let body;
  try { body = request.postDataJSON(); } catch { return false; }
  return body?.method === 'tools/call' && READ_VERBS.has(body?.params?.name);
}

// Every request from this context is either refused locally or reserved and
// then forwarded with no redirect following; WebSockets are unsupported and
// closed without connecting.
export async function installBudgetedRoute(context, budget, { allowed = stagingRequestAllowed } = {}) {
  await context.routeWebSocket(() => true, socket => socket.close());
  await context.route(() => true, async route => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient').catch(() => {}); }
    if (!allowed(url)) return route.abort('blockedbyclient').catch(() => {});
    if (!isRead(request)) {
      await budget.reserve('mutation').catch(() => {});
      return route.abort('blockedbyclient').catch(() => {});
    }
    let response;
    try { response = await budget.dispatch('http', () => route.fetch({ maxRedirects: 0, timeout: budget.timeoutMs() })); }
    catch { return route.abort('failed').catch(() => {}); }
    await route.fulfill({ response }).catch(() => {});
  });
  await context.addInitScript(hideCredentialPixels);
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
  const crowded = await localModelHeadroom({ floorBytes: profile.memoryFloorBytes, probe: host });
  if (crowded) {
    await budget.stop('local_model_resident');
    return budget.finish({ schema: 'home-smoke-receipt.v1', origin: home.origin, qualified: false, viewports: rows,
      failure: { phase: 'host-headroom', code: 'local_model_resident', ...crowded } });
  }
  try {
    await budget.reserve('target');
    const { state } = await session();
    for (const viewport of planned) {
      await budget.reserve('viewport');
      await budget.reserve('context');
      rows.push(await measureHome({ budget, browser, state, home, viewport, allowed }));
    }
  } catch (error) {
    failure = error instanceof BudgetRefusal ? { phase: 'budget', code: error.code }
      : error instanceof SmokeFailure ? error.failure : { phase: 'preflight', code: String(error?.code || 'unexpected-failure') };
    await budget.stop(error instanceof BudgetRefusal ? error.code : 'infrastructure-failure:' + failure.code);
  }
  return budget.finish({
    schema: 'home-smoke-receipt.v1', origin: home.origin, coverage: 'bounded read-only Home sample; controls inventoried, never pressed',
    qualified: !failure && rows.length === planned.length, viewports: rows, failure,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    parseHomeSmokeArgs(process.argv.slice(2));
    const budget = await createRunBudget();
    let browser, receipt;
    try {
      browser = await chromium.launch();
      receipt = await homeSmoke({ budget, browser });
    } catch (error) {
      await budget.stop('infrastructure-failure:launch');
      receipt = await budget.finish({ schema: 'home-smoke-receipt.v1', qualified: false, viewports: [], failure: { phase: 'launch', code: error instanceof BudgetRefusal ? error.code : 'browser-launch-failed' } });
    } finally { if (browser) await browser.close(); }
    console.log(`Home smoke ${receipt.qualified ? 'qualified' : 'NOT qualified'}; stopped: ${receipt.stopped.reason}`);
    if (!receipt.qualified) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
