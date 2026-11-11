import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { labelAssertions } from '../scripts/prove-historical-win-readable-labels.mjs';
for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`recorded names, legacy fallback, validation and retirement at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.route(`${server.url}/__labels__`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css">' }));
    await page.goto(`${server.url}/__labels__`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, colorScheme);
    assert.equal((await labelAssertions(page, `${server.url}/js/ui-ideal-client-profile.generated.js`)).length, 7);
  });
}
