import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { stagingFixtureWriteGuard, readStagingFixtureRelease } from './records.mjs';
import { resolve } from 'node:path';
import { STAGING_ORIGIN } from './session.mjs';

export const stagingRequestAllowed = url => url.origin === STAGING_ORIGIN || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);

const contextRefusals = new WeakMap();
export const stagingWriteRefusals = context => contextRefusals.get(context) || [];

export async function installStagingGuard(context, fixtureGuard = stagingFixtureWriteGuard()) {
  await context.route(url => !stagingRequestAllowed(url), route => route.abort());
  const refusals = [];
  contextRefusals.set(context, refusals);
  await context.route('**/*', async route => {
    const request = route.request();
    if (!stagingRequestAllowed(new URL(request.url()))) return route.abort();
    try {
      if (['GET', 'HEAD'].includes(request.method())) {
        if (new URL(request.url()).origin !== STAGING_ORIGIN) return route.fallback();
        return await fixtureGuard.handle(request, () => route.fallback());
      }
      const response = await fixtureGuard.handle(request, () => route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30_000 }));
      await route.fulfill({ response });
    } catch (error) {
      refusals.push({ reason: error.code || 'fixture-guard-unavailable' });
      await route.abort();
    }
  });
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
  let fixtureGuard;
  const guard = async () => {
    // The explorer's normal session preflight already proves the source pair.
    // Read setup release before installing the same write policy as the sweep.
    const output = resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
    fixtureGuard ||= stagingFixtureWriteGuard({ output, release: await readStagingFixtureRelease(output) });
    await installStagingGuard(live.context(), fixtureGuard);
  };
  const { capabilities, ...spec } = engine;
  return defineEngine({
    ...spec,
    startAttempt: async context => { await engine.startAttempt(context); await guard(); },
    // In-memory refusal state survives unavailable storage and context replacement.
    // Normal settle runs first so its artifacts/cleanup are still attempted.
    settleAttempt: async context => { await engine.settleAttempt(context); fixtureGuard?.assertCoverage(); },
    state: { capture: async (...args) => { fixtureGuard?.assertCoverage(); return engine.state.capture(...args); }, restore: async (...args) => { await engine.state.restore(...args); await guard(); } },
    session: {
      ...engine.session,
      restart: async (...args) => { await engine.session.restart(...args); await guard(); },
      reset: async (...args) => { await engine.session.reset(...args); await guard(); },
    },
  });
}
