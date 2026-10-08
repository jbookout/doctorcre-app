import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { STAGING_ORIGIN } from './session.mjs';

export const stagingRequestAllowed = url => url.origin === STAGING_ORIGIN || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);

// Runs in the page: keeps a share URL's credential out of every screenshot.
export function hideCredentialPixels() {
  const hide = () => {
    document.querySelector('#share-url')?.style.setProperty('opacity', '0', 'important');
  };
  hide();
  new MutationObserver(hide).observe(document, { childList: true, subtree: true });
}

export async function installStagingGuard(context) {
  await context.route(url => !stagingRequestAllowed(url), route => route.abort());
  await context.addInitScript(hideCredentialPixels);
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
