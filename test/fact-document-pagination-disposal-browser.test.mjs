import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { observeOnPage } from '../scripts/prove-fact-document-pagination-disposal.mjs';

for (const width of [390, 1440]) for (const colorScheme of ['light', 'dark']) {
  test(`document lifecycle at ${width}px ${colorScheme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(server.origin);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const result = await observeOnPage(page, `${server.origin}/js/ui-facts.generated.js`);
    assert.ok(result.assertions.includes('healthy-fact-review-usable'));
    assert.ok(result.assertions.includes('expired-later'));
    assert.deepEqual(errors, []);
  });
}
