import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';

const publication = JSON.parse(await readFile('test/fixtures/masterplan/example-health.market-study.json'));
const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MasterplanBasemap } from './src/ui/portal/masterplan-basemap';
const library = await import('/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs');
library.setWorkerUrl('/tours/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs');
const data = ${JSON.stringify(publication)};
const empty = { type: 'FeatureCollection', features: [] };
const map = new library.Map({ container: 'map', center: data.map.center, zoom: 11, attributionControl: false,
  style: { version: 8, sources: { water: { type: 'geojson', data: empty }, roads: { type: 'geojson', data: empty }, property: { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: data.map.center } }] } } },
  layers: [{ id: 'water', type: 'fill', source: 'water' }, { id: 'roads', type: 'line', source: 'roads' }, { id: 'property', type: 'circle', source: 'property', paint: { 'circle-radius': 8 } }] } });
window.map = map;
window.mode = 'ok';
window.calls = 0;
const rights = { provider: 'Synthetic', sku: 'offline-test', termsUrl: 'https://example.com/terms', reviewer: 'Synthetic reviewer', reviewedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', renderer: 'maplibre-gl@6.4.1', storageClass: 'memory-only', storableFields: [], retention: 'none', purge: 'unmount', attribution: 'Synthetic map data', exportPath: 'none', quotaGate: '60/minute', resourcePrefixes: ['https://example.com/'] };
map.on('load', () => {
 const root = createRoot(document.getElementById('controls'));
 root.render(React.createElement(MasterplanBasemap, { map, registry: library, localLayerIds: ['water', 'roads'], developments: data.developments, styleUrl: 'https://example.com/style', receipt: rights, now: () => Date.parse('2026-11-05T00:00:00Z'), openProject: id => { document.getElementById('project-dialog').textContent = id; },
 fetch: async url => {
   window.calls++;
   if (window.mode === 'missing' || !url.endsWith('/style')) return new Response('', { status: 404 });
   return Response.json(window.mode === 'tiles' ? { version: 8, sources: { test: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } }, layers: [{ id: 'road', type: 'line', source: 'test', 'source-layer': 'road' }] }
   : { version: 8, sources: {}, layers: [{ id: 'land', type: 'background' }] });
 } }));
 window.retire = () => { root.unmount(); map.remove(); };
});
` }, bundle: true, format: 'esm', platform: 'browser', write: false, external: ['/tours/*'], define: { 'process.env.NODE_ENV': '"production"' } });

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`master plan and basemap preserve selected property at ${width}px in ${theme}`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  const requested = [];
  t.after(() => { if (errors.length) console.error(errors); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.css"><style>
body{margin:0;font:16px system-ui;background:${theme === 'dark' ? '#181c20' : '#faf9f5'};color:${theme === 'dark' ? '#eee' : '#222'};--surface-1:${theme === 'dark' ? '#24292e' : '#f3f0ea'}}
button,select{font:inherit;min-height:44px;max-width:100%}#map{height:420px}#controls{max-width:100%}
</style></head><body><div id="development-map"><div id="map"></div><div id="controls"></div></div><button aria-pressed="true" data-property-id="sample-property-1">Selected synthetic property</button><div id="project-dialog" role="status"></div><script type="module" src="/fixture.js"></script></body></html>` });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text });
    if (path.startsWith('/tours/vendor/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(`.${path}`) });
    return route.fulfill({ status: 404 });
  });
  try { await page.goto('http://localhost/', { waitUntil: 'domcontentloaded' }); }
  catch (error) { console.error({ requested, url: page.url() }); throw error; }
  await page.getByRole('checkbox', { name: 'Show master plan' }).waitFor();
  await page.evaluate(() => window.map.jumpTo({ center: [-100.46, 40.28], zoom: 10.3, bearing: 15 }));
  const camera = await page.evaluate(() => ({ center: window.map.getCenter().toArray(), zoom: window.map.getZoom(), bearing: window.map.getBearing() }));
  await page.getByRole('button', { name: 'Example Town Center', exact: true }).click();
  assert.equal(await page.locator('#project-dialog').innerText(), 'sample-development-1');
  await page.getByRole('checkbox').uncheck();
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('s16-plan-sample-development-1-point', 'visibility')), 'none');
  await page.getByRole('checkbox').check();
  await page.getByRole('combobox', { name: 'Basemap' }).selectOption('vector');
  await page.getByText('Synthetic map data', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('water', 'visibility')), 'none');
  await page.getByRole('combobox').selectOption('local');
  await page.evaluate(() => { window.mode = 'tiles'; });
  await page.getByRole('combobox').selectOption('vector');
  await page.getByText('Vector basemap unavailable. Showing the permitted local map layers.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('water', 'visibility')), 'visible');
  assert.deepEqual(await page.evaluate(() => ({ center: window.map.getCenter().toArray(), zoom: window.map.getZoom(), bearing: window.map.getBearing() })), camera);
  assert.equal(await page.locator('[data-property-id]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => Boolean(window.map.getLayer('property'))), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  await mkdir('/tmp/wr227-s16-j1-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/wr227-s16-j1-evidence/masterplan-${width}-${theme}.png` });
  await page.evaluate(() => window.retire());
});
