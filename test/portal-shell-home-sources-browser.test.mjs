import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/portal/example-health.market-study.json', import.meta.url)));

async function open(t, width = 390, theme = 'light', mapAvailable = false) {
  const server = await startFixtureServer(); t.after(server.stop);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (!mapAvailable) await page.route('**/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs', route => route.abort());
  else await page.route('**/portal/files/*', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.goto(`${server.url}/portal/index.html`);
  await page.evaluate(async ({ fixture, theme }) => {
    document.documentElement.dataset.theme = theme;
    const { mountPortal } = await import('/js/ui-portal.js');
    window.portalPanel = mountPortal(document.querySelector('#portal-root'), { load: async () => fixture });
  }, { fixture, theme });
  return page;
}

test('synthetic shell supports keyboard, history, dialogs and expiry on phone and desktop in both themes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const page = await open(t, width, theme);
      const home = page.getByRole('heading', { name: fixture.market.home_title, exact: true });
      await home.waitFor();
      assert.equal(await home.evaluate(node => node === document.activeElement), true);
      assert.equal(await page.getByRole('status').innerText(), 'Map unavailable. Explore the development and regional context cards below.');
      await page.getByRole('button', { name: 'Explore Example Town Center', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /Concept plan only|Approximate study locator|Planning agenda/);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Explore Example Town Center', exact: true }).evaluate(node => node === document.activeElement), true);
      await page.getByRole('button', { name: 'Explore Example Regional Hospital', exact: true }).click();
      assert.match(await page.getByRole('dialog').innerText(), /Example Avenue/);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Explore current practice', exact: true }).click();
      assert.match(await page.getByRole('dialog').innerText(), /About 2,000 SF today/);
      await page.getByRole('link', { name: 'Practice website', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('navigation').getByRole('link', { name: 'Sources', exact: true }).focus();
      await page.keyboard.press('Enter');
      const sources = page.getByRole('heading', { name: 'Sources', exact: true });
      await sources.waitFor();
      assert.equal(await sources.evaluate(node => node === document.activeElement), true);
      assert.match(await page.locator('main').innerText(), /Every figure in this synthetic study is invented/);
      assert.equal(await page.locator('nav [aria-current=page]').innerText(), 'Sources');
      await page.goBack(); await home.waitFor();
      await page.goForward(); await sources.waitFor();
      await page.evaluate(() => { location.hash = '#unknown'; });
      await page.getByRole('heading', { name: 'Page unavailable' }).waitFor();
      await page.getByRole('link', { name: 'Return Home', exact: true }).click();
      await home.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('out/test-artifacts/portal-shell', { recursive: true });
      await page.screenshot({ path: `out/test-artifacts/portal-shell/${width}-${theme}.png`, fullPage: true });
      await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
      assert.match(await page.locator('#portal-root').innerText(), /session expired/);
      assert.equal(await page.locator('main, dialog').count(), 0);
      await page.evaluate(() => { location.hash = '#sources'; });
      assert.doesNotMatch(await page.locator('body').innerText(), /Every figure|Sample County/);
    });
  }
});

test('self-hosted local-layer map opens the development with no navigation handoff', async t => {
  const page = await open(t, 1280, 'light', true);
  const marker = page.locator('.portal-map').getByRole('button', { name: '1. Example Town Center', exact: true });
  await marker.waitFor();
  await page.locator('.portal-map').getByRole('button', { name: 'Example Regional Hospital', exact: true }).waitFor();
  await page.locator('.portal-map').getByRole('button', { name: 'C. Current practice', exact: true }).waitFor();
  await marker.focus();
  await page.locator('.portal-marker-preview').getByText('A mixed-use center.', { exact: true }).waitFor();
  await marker.click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /Adds rooftops near the study area/);
  assert.equal(await page.locator('a[href*="maps.google"], a[href*="maps.apple"]').count(), 0);
  await page.getByRole('dialog').getByRole('link', { name: 'View primary source', exact: true }).click();
  await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
});
