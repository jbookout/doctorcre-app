import { rm } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, WAIT_MS } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

// Register holds after response routes so release resumes the original adapter.
export async function scenario(t, { now, timezone = 'America/Chicago', seed = {}, root, page: pageOptions = {} } = {}) {
  const instant = now === undefined ? undefined : new Date(now).getTime();
  if (instant !== undefined && !Number.isFinite(instant)) throw new TypeError('Invalid scenario time');
  const records = structuredClone(seed);
  const outputDir = temporaryDirectory('doctorcre-scenario-');
  const holds = new Set();
  const failures = [];
  let browser, server, page, closing;
  async function teardown() {
    if (!closing) closing = (async () => {
      for (const hold of holds) hold.release();
      try {
        await page?.unrouteAll({ behavior: 'ignoreErrors' });
      } finally {
        const results = await Promise.allSettled([
          browser?.close(), server?.close(), rm(outputDir, { recursive: true, force: true }),
        ]);
        const errors = [...failures, ...results.filter(result => result.status === 'rejected').map(result => result.reason)];
        if (errors.length) throw new AggregateError(errors, 'Scenario cleanup failed');
      }
    })();
    return closing;
  }
  t.after(teardown);
  try {
    server = await fixtureServer({ root });
    browser = await chromium.launch();
    page = await browser.newPage({ ...pageOptions, timezoneId: timezone });
    if (instant !== undefined) await page.clock.setFixedTime(instant);
  } catch (error) {
    await teardown();
    throw error;
  }
  return {
    page, origin: server.origin, records, outputDir,
    get now() { return instant === undefined ? undefined : new Date(instant); },
    teardown,
    async open(path = '/', options) {
      if (closing) throw new Error('Scenario is closed');
      try { return await page.goto(new URL(path, server.origin).href, options); }
      catch (error) { await teardown(); throw error; }
    },
    async hold(matcher, { timeout = WAIT_MS } = {}) {
      if (closing) throw new Error('Scenario is closed');
      if (!(timeout > 0 && timeout <= WAIT_MS)) throw new RangeError('Hold timeout must be within the wait budget');
      let resume, acknowledge, rejectRequest, timer;
      const pending = new Promise(resolve => { resume = resolve; });
      const requested = new Promise((resolve, reject) => { acknowledge = resolve; rejectRequest = reject; });
      // Cleanup may run before a caller awaits acknowledgement.
      requested.catch(() => {});
      const hold = { requested, release() {
        clearTimeout(timer);
        resume();
        rejectRequest(new Error('Hold released before a request arrived'));
      } };
      holds.add(hold);
      timer = setTimeout(() => {
        failures.push(new Error(`Scenario hold exceeded ${timeout} ms`));
        hold.release();
      }, timeout);
      await page.route(typeof matcher === 'function' ? '**/*' : matcher, async route => {
        if (typeof matcher === 'function' && !matcher(route.request())) return route.fallback();
        acknowledge(route.request());
        await pending;
        await route.fallback();
      });
      return hold;
    },
  };
}
