import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { STAGING_ORIGIN, stagingSession } from './session.mjs';

export const stagingRequestAllowed = url => url.origin === STAGING_ORIGIN || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);

export async function installStagingGuard(context) {
  await context.route(url => !stagingRequestAllowed(url), route => route.abort());
  await context.addInitScript(() => {
    const hideCredentialPixels = () => {
      document.querySelector('#share-url')?.style.setProperty('opacity', '0', 'important');
    };
    hideCredentialPixels();
    new MutationObserver(hideCredentialPixels).observe(document, { childList: true, subtree: true });
  });
}

export function stagingWeb(options) {
  const engine = web({ ...options, headers: { 'x-e2e-staging-run': '1' } });
  const live = surfaceOf(engine);
  const guard = () => installStagingGuard(live.context());
  const { capabilities, ...spec } = engine;
  return defineEngine({
    ...spec,
    startAttempt: async context => {
      await engine.startAttempt(context);
      await guard();
      // `e2e mcp` sessions have no session restore. With E2E_STAGING_MCP_SESSION=1
      // each attempt performs the same cookie exchange the setup test uses, so a
      // coding agent can observe and `locate` against signed-in staging screens.
      if (process.env.E2E_STAGING_MCP_SESSION === '1') await live.context().addCookies((await stagingSession()).state.cookies);
    },
    state: { capture: engine.state.capture, restore: async (...args) => { await engine.state.restore(...args); await guard(); } },
    session: {
      ...engine.session,
      restart: async (...args) => { await engine.session.restart(...args); await guard(); },
      reset: async (...args) => { await engine.session.reset(...args); await guard(); },
    },
  });
}
