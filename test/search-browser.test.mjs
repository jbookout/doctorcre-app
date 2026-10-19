import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { SAVED_VIEWS_KEY } from '../js/search-model.js';

test('S2 saved search stays under the keyboard while its results update', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const artifacts = new URL('../out/test-artifacts/s2-verification/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) for (const [label, name] of [
    ['plain', 'Demo saved search'], ['punctuation', `Demo's "saved" <search> & view`],
  ]) {
    await t.test(`${width} ${theme} ${label}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 960 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ theme, key, name }) => {
        localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
        localStorage.setItem(key, JSON.stringify([{ name, query: 'Demo Dental', kinds: [] }]));
      }, { theme, key: SAVED_VIEWS_KEY, name });
      await page.route('**/api/**', route => route.fulfill({ json: {} }));
      await page.goto(`${server.origin}/search?mode=fixture`);
      const saved = page.getByRole('link', { name, exact: true });
      await saved.waitFor({ state: 'visible' });
      await saved.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#searchResults').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#searchQuery').inputValue(), 'Demo Dental');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.view), name);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.rename), name);
      await page.screenshot({ path: new URL(`search-${width}-${theme}-${label}.png`, artifacts).pathname });
      await page.locator('#resetViewsButton').click();
      assert.equal(await page.locator('[data-view]').count(), 0);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), SAVED_VIEWS_KEY), '[]');
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});
