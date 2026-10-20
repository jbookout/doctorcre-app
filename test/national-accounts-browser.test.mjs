import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

test('S1 returning to national accounts restores the selected card for keyboard users', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const artifacts = new URL('../out/test-artifacts/s1-verification/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    await t.test(`${width} ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => {
        localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
      }, theme);
      await page.route('**/api/**', route => route.fulfill({ json: {} }));
      await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
      const card = page.locator('.account-card').first();
      await card.waitFor({ state: 'visible' });
      const account = await card.getAttribute('data-account');
      await card.focus();
      await page.keyboard.press('Enter');
      await page.locator('#accountGrid').waitFor({ state: 'hidden' });
      const back = page.locator('#accountBack');
      assert.equal(await back.isVisible(), true, 'account return is reachable without opening a modal sidebar');
      await back.focus();
      await page.keyboard.press('Enter');
      await page.locator('#accountGrid').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-account')), account);
      await page.screenshot({ path: new URL(`account-${width}-${theme}.png`, artifacts).pathname });
      await page.keyboard.press('Enter');
      await page.locator('#accountGrid').waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});
