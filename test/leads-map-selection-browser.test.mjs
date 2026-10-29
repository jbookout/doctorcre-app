import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
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

test('a cluster zooms once then exposes every nearby place member at terminal zoom', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [lead(1, { city: 'Example Harbor' }), lead(2, { city: 'Example Bay' })] };
  await routeLeads(page, { getBoard: () => board });
  const places = JSON.parse(await readFile(new URL('../data/leads-market-locations.json', import.meta.url), 'utf8'));
  await page.route('**/data/leads-market-locations.json', route => route.fulfill({ json: [
    ...places,
    { id: 'example-harbor', name: 'Example Harbor', state: 'FL', position: [-87.2, 30.42] },
    { id: 'example-bay', name: 'Example Bay', state: 'FL', position: [-87.2001, 30.4201] },
  ] }));
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.getByRole('button', { name: /Zoom to markets/ }).click();
  const marker = page.getByRole('button', { name: /Example Bay, FL: 1.* leads$/ });
  await marker.waitFor();
  await marker.focus();
  await page.keyboard.press('Enter');
  const chooser = page.getByRole('region', { name: 'Leads in this place', exact: true });
  assert.deepEqual(await chooser.locator('[data-map-lead]').evaluateAll(nodes => nodes.map(node => node.dataset.mapLead).sort()), [id(1), id(2)]);
  for (const n of [1, 2]) {
    const member = chooser.getByRole('button', { name: `Dr. Example ${n}`, exact: true });
    await member.focus();
    await page.keyboard.press('Enter');
    await page.locator('#detailStage').waitFor();
    assert.equal(await page.locator('#detailTitle').innerText(), `Dr. Example ${n}`);
    await page.locator('#closeDetail').click();
    assert.equal(await member.evaluate(node => node === document.activeElement), true);
  }
});

for (const width of [1440, 390]) test(`place members follow filters across market labels without stale records at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [lead(1, { market: 'Example research' }), lead(2, { specialty: 'Medical' }), lead(3)] };
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').waitFor();
  await page.locator('.market-marker').click();
  const chooser = page.getByRole('region', { name: 'Leads in this place', exact: true });
  await chooser.waitFor();
  assert.deepEqual(await chooser.locator('[data-map-lead]').evaluateAll(nodes => nodes.map(node => node.dataset.mapLead).sort()), [id(1), id(2), id(3)]);
  await page.locator('#specialtyFilter').selectOption('Dental');
  assert.deepEqual(await chooser.locator('[data-map-lead]').evaluateAll(nodes => nodes.map(node => node.dataset.mapLead).sort()), [id(1), id(3)]);
  await chooser.getByRole('button', { name: 'Dr. Example 1', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('#detailTitle').innerText(), 'Dr. Example 1');
  await page.locator('#closeDetail').click();
  await page.locator('#leadSearch').fill('no matching synthetic lead');
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.market-marker').count(), 0);
  assert.equal(await page.locator('#leadBoard .lead-card').count(), 0);
  await page.locator('#leadSearch').fill('');
  await page.locator('.market-marker').click();
  await chooser.waitFor();
  assert.deepEqual(await chooser.locator('[data-map-lead]').evaluateAll(nodes => nodes.map(node => node.dataset.mapLead).sort()), [id(1), id(3)]);
  await chooser.getByRole('button', { name: 'Close place leads', exact: true }).click();
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.market-marker').evaluate(node => node === document.activeElement), true);
});
