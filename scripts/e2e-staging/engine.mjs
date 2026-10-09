import { currentRun, RUN_LIMITS } from './run-limits.mjs';
import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { stagingFixtureWriteGuard, readStagingFixtureRelease } from './records.mjs';
import { resolve } from 'node:path';
const contextRefusals = new WeakMap();
export const stagingWriteRefusals = context => contextRefusals.get(context) || [];

export async function installStagingGuard(context, fixtureGuard = stagingFixtureWriteGuard()) {
  const refusals = [];
  contextRefusals.set(context, refusals);
  await context.route('**/*', async route => {
    const request = route.request();
    try {
      // Every method crosses the same policy before any request is forwarded.
      // Do not use fallback: interception is not re-run for redirect targets.
      const response = await fixtureGuard.handle(request, () =>
        route.fetch({ maxRetries: RUN_LIMITS.retries, maxRedirects: 0, timeout: RUN_LIMITS.httpTimeoutMs }));
      await route.fulfill({ response });
    } catch (error) {
      // A read transport failure still reaches the client's normal retry path.
      // The policy marks its own refusals, including uncertain write outcomes.
      if (error.fixturePolicy) refusals.push({ reason: error.code });
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
    const context = live.context();
    const remove = currentRun()?.onStop(() => context.close());
    if (remove) context.once('close', remove);
    await installStagingGuard(context, fixtureGuard);
  };
  const { capabilities, ...spec } = engine;
  return defineEngine({
    ...spec,
    startAttempt: async context => { await engine.startAttempt(context); await guard(); },
    // In-memory refusal state survives unavailable storage and context replacement.
    // Normal settle runs first so its artifacts/cleanup are still attempted.
    settleAttempt: async context => { await engine.settleAttempt(context); await fixtureGuard?.assertCoverage(); },
    state: { capture: async (...args) => { await fixtureGuard?.assertCoverage(); return engine.state.capture(...args); }, restore: async (...args) => { await engine.state.restore(...args); await guard(); } },
    session: {
      ...engine.session,
      restart: async (...args) => { await engine.session.restart(...args); await guard(); },
      reset: async (...args) => { await engine.session.reset(...args); await guard(); },
    },
  });
}
