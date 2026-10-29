import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { workspace, lead, id } from './leads-workspace-fixture.mjs';

for (const width of [1440, 390]) test(`every coincident place member opens its record and restores focus at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [lead(1), lead(2), lead(3)] };
  await routeLeads(page, { getBoard: () => board });
  await page.route('**/maplibre-gl.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export * from './maplibre-gl.mjs?provider';
    import { Map as ProviderMap } from './maplibre-gl.mjs?provider';
    export class Map extends ProviderMap {
      constructor(options) { super(options); globalThis.leadsRenderer = this; }
    }
  ` }));
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').waitFor();
  await page.evaluate(() => leadsRenderer.jumpTo({ center: [-87.2, 30.42], zoom: 11 }));
  const canvas = await page.locator('#territoryMap canvas').elementHandle();
  const camera = await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() }));
  await page.locator('.market-marker').focus();
  await page.keyboard.press('Enter');
  const chooser = page.getByRole('region', { name: 'Leads in this place', exact: true });
  await chooser.waitFor();
  assert.match(await chooser.innerText(), /Market area only/);
  assert.equal(await chooser.locator('a').count(), 0, 'a city group offers no address navigation');
  assert.equal(await page.locator('#marketFilter').inputValue(), '', 'opening members does not change filters');
  for (const mode of ['mouse', 'keyboard']) for (const n of [1, 2, 3]) {
    const member = chooser.getByRole('button', { name: `Dr. Example ${n}`, exact: true });
    if (mode === 'mouse') await member.click();
    else { await member.focus(); await page.keyboard.press('Enter'); }
    await page.locator('#detailStage').waitFor();
    assert.equal(await page.locator('#detailTitle').innerText(), `Dr. Example ${n}`);
    assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(n));
    await page.getByRole('button', { name: 'Close lead details', exact: true }).click();
    await member.waitFor();
    assert.equal(await member.evaluate(node => node === document.activeElement), true, 'closing restores the exact member');
    assert.deepEqual(await page.evaluate(() => ({ center: leadsRenderer.getCenter().toArray(), zoom: leadsRenderer.getZoom() })), camera);
  }
  assert.equal(await canvas.evaluate(node => node.isConnected), true);
  if (process.env.UI_SCREENSHOT_DIR) {
    await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('.territory').screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/lead-members-${width}-${theme}.png` });
    }
  }
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.market-marker').evaluate(node => node === document.activeElement), true);
});
