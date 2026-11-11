import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { retirementAssertions } from '../scripts/prove-historical-fit-session-retirement.mjs';
for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`session retirement at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(`${server.url}/__retirement__`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css"><title>Historical fit retirement</title>' }));
    await page.goto(`${server.url}/__retirement__`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, colorScheme);
    assert.equal((await retirementAssertions(page, `${server.url}/js/ui-ideal-client-profile.js`)).length, 8);
    await page.evaluate(() => { window.retirementProof.remount('ready'); window.dispatchEvent(new Event('doctorcre-session-invalidated')); });
    await page.getByRole('status').filter({ hasText: 'Sign in again' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('/tmp/WR647.S10.J1-ui', { recursive: true });
    await page.screenshot({ path: `/tmp/WR647.S10.J1-ui/${width}-${colorScheme}.png` });
    assert.deepEqual(errors, []);
  });
}
