import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { STAGING_ORIGIN } from './session.mjs';
import { BudgetRefusal, activeBudget } from './run-budget.mjs';
import { installBudgetedRoute } from './budgeted-route.mjs';

// Only the exact staging origin. Web fonts and every other third party are
// refused locally, so a staging run contacts no one else.
export const stagingRequestAllowed = url => url.origin === STAGING_ORIGIN;

// Runs in the page: keeps a share URL's credential out of every screenshot.
export function hideCredentialPixels() {
  const hide = () => {
    document.querySelector('#share-url')?.style.setProperty('opacity', '0', 'important');
  };
  hide();
  new MutationObserver(hide).observe(document, { childList: true, subtree: true });
}

// Every context the e2e SDK opens for a staging target is charged and routed
// through the active run budget; without one, the context refuses to start.
export async function installStagingGuard(context, budget = activeBudget()) {
  if (!budget) throw new BudgetRefusal('staging-not-budgeted');
  await budget.reserve('context');
  await installBudgetedRoute(context, budget);
}

export function stagingWeb(options) {
  const engine = web({ ...options, headers: { 'x-e2e-staging-run': '1' } });
  const live = surfaceOf(engine);
  const guard = () => installStagingGuard(live.context());
  const { capabilities, ...spec } = engine;
  return defineEngine({
    ...spec,
    startAttempt: async context => { await engine.startAttempt(context); await guard(); },
    state: { capture: engine.state.capture, restore: async (...args) => { await engine.state.restore(...args); await guard(); } },
    session: {
      ...engine.session,
      restart: async (...args) => { await engine.session.restart(...args); await guard(); },
      reset: async (...args) => { await engine.session.reset(...args); await guard(); },
    },
  });
}
