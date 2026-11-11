import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { readFile } from 'node:fs/promises';
import { observeOnPage } from '../scripts/prove-fact-review-term-key-filter.mjs';
const recordings = JSON.parse(await readFile(new URL('./fixtures/fact-review-term-key-filter/recordings.json', import.meta.url), 'utf8'));
for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`term filter transitions and design invariants at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    const result = await observeOnPage(page, server.origin, recordings);
    assert.ok(result.assertions.includes('draft-text-and-form-identity-retained'));
    assert.ok(result.assertions.includes('disposed-late-response-ignored'));
  });
}

for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`confirmed retry waits for its write after a held session at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    await page.evaluate(() => {
      const json = Response.prototype.json, timeout = globalThis.setTimeout;
      let sessions = 0, releaseSession;
      globalThis.retrySessionTrace = [];
      Response.prototype.json = async function () {
        const data = await json.call(this);
        if (data?.csrf_token && ++sessions === 2) {
          globalThis.retrySessionTrace.push('session-held');
          await new Promise(resolve => { releaseSession = resolve; });
          globalThis.retrySessionTrace.push('session-returned');
        }
        return data;
      };
      globalThis.setTimeout = (callback, ms, ...args) => timeout(() => {
        callback(...args);
        if (ms === 10 && releaseSession) {
          const release = releaseSession; releaseSession = undefined;
          globalThis.retrySessionTrace.push('proof-tick-before-session');
          queueMicrotask(release);
        }
      }, ms);
    });
    const result = await observeOnPage(page, server.origin, recordings);
    assert.deepEqual(await page.evaluate(() => globalThis.retrySessionTrace), [
      'session-held', 'proof-tick-before-session', 'session-returned',
    ]);
    assert.ok(result.assertions.includes('confirmed-retry-refreshes'));
    assert.ok(result.assertions.includes('retry-preserves-idempotency-and-versions'));
    assert.equal(result.synthetic_write_attempts, 3);
  });
}
