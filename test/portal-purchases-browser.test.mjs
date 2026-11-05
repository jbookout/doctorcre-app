import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
const fixture = JSON.parse(await readFile('test/fixtures/portal-purchases/example-health.market-study.json'));
async function open(t, { width = 390, theme = 'light', map = false, failedLayers = false, publication = fixture } = {}) {
  const bundle = await build({ stdin: { contents: `export { Purchases, purchasesModule } from './src/ui/portal/purchases'; export { createRoot } from 'react-dom/client'; export { createElement } from 'react';`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  const server = await startFixtureServer(); t.after(server.stop);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', error => console.error(error.message));
  await page.route('**/purchases-test.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.route('**/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs', async route => map ? route.continue() : route.abort());
  await page.route('**/files/*', route => failedLayers ? route.abort() : route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.goto(`${server.url}/reports/index.html`);
  await page.evaluate(async ({ publication, theme }) => {
    document.documentElement.dataset.theme = theme;
    const { Purchases, createRoot, createElement } = await import('/purchases-test.js');
    document.body.innerHTML = '<main id="purchases-test"></main>';
    window.proposals = [];
    window.purchaseRoot = createRoot(document.querySelector('main'));
    window.purchaseRoot.render(createElement(Purchases, { publication, onProposal: proposal => window.proposals.push(proposal) }));
  }, { publication, theme });
  return page;
}
test('directory, dialog, plans, sources, filter/reset and proposals work without map in both themes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async t => {
    const page = await open(t, { width, theme });
    await page.getByRole('heading', { name: 'Choose a property' }).waitFor({ timeout: 3000 }).catch(async error => { console.error((await page.locator('body').innerText()).slice(0,2000)); throw error; });
    await page.getByText('Map unavailable. Use the property directory below.').waitFor();
    assert.equal(await page.locator('.purchase-factors article').count(), 6);
    const card = page.locator('.purchase-directory [data-property-id="sample-property-1"]');
    await card.getByRole('button', { name: 'View 1. Sample Way' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('data-property-id'), 'sample-property-1');
    assert.match(await dialog.innerText(), /Confirm parking count/);
    assert.equal(await dialog.getByRole('link', { name: 'View supplied floor plan' }).getAttribute('href'), `files/${'5'.repeat(64)}`);
    assert.equal(await dialog.getByRole('link', { name: 'Listing', exact: true }).getAttribute('href'), 'https://example.com/listing');
    await dialog.getByRole('button', { name: 'Add to Tour List proposal' }).click();
    assert.deepEqual(await page.evaluate(() => window.proposals), [{ propertyId: 'sample-property-1', selected: true }]);
    await page.keyboard.press('Escape');
    assert.equal(await card.getByRole('button', { name: 'View 1. Sample Way' }).evaluate(n => n === document.activeElement), true);
    await page.getByLabel('Filter properties').fill('Example Road');
    assert.equal(await page.locator('.purchase-directory [data-property-id]').count(), 1);
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: 'View 2. Example Road' }).click();
    assert.match(await page.getByRole('dialog').innerText(), /Excluded from the shortlist/);
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: /Tour List proposal/ }).count(), 0);
    await page.getByRole('button', { name: 'Close property' }).click();
    await page.getByRole('button', { name: 'Reset filters' }).click();
    assert.equal(await page.locator('.purchase-directory [data-property-id]').count(), 2);
    assert.equal(await page.locator('a[href*="maps.google"], a[href*="maps.apple"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('out/test-artifacts/purchases', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/purchases/${width}-${theme}.png`, fullPage: true });
  });
});

test('real MapLibre pins, list focus and optional table share IDs', async t => {
  const publication = structuredClone(fixture);
  publication.properties[1].locator = { lon: -100.52, lat: 40.24, precision: 'Approximate study locator' };
  const page = await open(t, { width: 1280, map: true, publication });
  const pin = page.getByRole('button', { name: 'Open 1. Sample Way', exact: true });
  await pin.waitFor();
  await page.locator('.purchase-directory').getByRole('button', { name: 'View 1. Sample Way' }).focus();
  await page.waitForFunction(() => document.querySelector('.purchase-pin[data-property-id="sample-property-1"]').dataset.active === 'true');
  await pin.click();
  assert.equal(await page.getByRole('dialog').getAttribute('data-property-id'), 'sample-property-1');
  assert.equal(await pin.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('tr[data-property-id="sample-property-1"]').getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Close property' }).click();
  await page.getByLabel('Filter properties').fill('Example Road');
  await pin.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open 2. Example Road', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /Excluded from the shortlist/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await pin.waitFor();
  await page.locator('tr[data-property-id="sample-property-1"]').getByRole('button', { name: 'Sample Way' }).click();
  assert.equal(await page.getByRole('dialog').getAttribute('data-property-id'), 'sample-property-1');
});

test('unsafe links and assets are inert; missing optional plans and table omit their controls', async t => {
  const publication = structuredClone(fixture);
  delete publication.purchases.table;
  delete publication.properties[0].floorplan;
  publication.properties[0].sources = [{ label: 'Unsafe source', url: 'javascript:alert(1)' }, { label: 'Credential source', url: 'https://user:password@example.com/' }];
  publication.properties[0].photo.sha256 = '../unsafe';
  publication.properties[0].summary = '<img src=x onerror=alert(1)>';
  const page = await open(t, { publication });
  assert.equal(await page.getByRole('table').count(), 0);
  await page.getByRole('button', { name: 'View 1. Sample Way' }).click();
  assert.match(await page.getByRole('dialog').innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.getByRole('dialog').getByRole('img').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'View supplied floor plan' }).count(), 0);
  assert.equal(await page.locator('a[href^="javascript:"], a[href*="password"], [onerror]').count(), 0);
});

test('duplicate IDs refuse publication rendering', async t => {
  const publication = structuredClone(fixture);
  publication.properties[1].id = publication.properties[0].id;
  const page = await open(t, { publication });
  assert.match(await page.getByRole('alert').innerText(), /duplicate property IDs/);
  assert.equal(await page.getByRole('button').count(), 0);
});

test('failed map layers open the breaker and leave the directory usable', async t => {
  const page = await open(t, { map: true, failedLayers: true });
  await page.getByText('Map unavailable. Use the property directory below.').waitFor();
  await page.getByRole('button', { name: 'View 1. Sample Way' }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Filter properties').fill('no match');
  await page.getByText('No properties match. Reset filters to see the directory.').waitFor();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  assert.equal(await page.locator('.purchase-directory article').count(), 2);
  await page.evaluate(() => window.purchaseRoot.unmount());
  assert.equal(await page.locator('dialog, canvas, .purchase-pin').count(), 0);
});
