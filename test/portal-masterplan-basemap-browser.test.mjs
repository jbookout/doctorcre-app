import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
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
window.resources = [];
const varint = n => { const bytes = []; do { let value = n & 127; n >>>= 7; bytes.push(value | (n ? 128 : 0)); } while(n); return bytes; };
const integer = (field, n) => [...varint(field * 8), ...varint(n)];
const message = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const text = (field, value) => message(field, [...new TextEncoder().encode(value)]);
const feature = [...integer(1, 1), ...integer(3, 1), ...message(4, [9, ...varint(1810), ...varint(3094)])];
const tile = new Uint8Array(message(3, [...text(1, 'places'), ...message(2, feature), ...integer(5, 4096), ...integer(15, 2)]));
const glyph = [...integer(1, 65), ...message(2, Array(49).fill(255)), ...integer(3, 1), ...integer(4, 1), ...integer(5, 0), ...integer(6, 2), ...integer(7, 2)];
const font = new Uint8Array(message(1, [...text(1, 'Synthetic'), ...text(2, '0-255'), ...message(3, glyph)]));
const rights = { provider: 'Synthetic', sku: 'offline-test', termsUrl: 'https://example.com/terms', reviewer: 'Synthetic reviewer', reviewedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', renderer: 'maplibre-gl@6.4.1', storageClass: 'memory-only', storableFields: [], retention: 'none', purge: 'unmount', attribution: 'Synthetic map data', exportPath: 'none', quotaGate: '60/minute', resourcePrefixes: ['https://example.com/'] };
map.on('load', () => {
 const root = createRoot(document.getElementById('controls'));
 root.render(React.createElement(MasterplanBasemap, { map, registry: library, localLayerIds: ['water', 'roads'], developments: data.developments, styleUrl: 'https://example.com/style', receipt: rights, now: () => Date.parse('2026-11-05T00:00:00Z'), openProject: id => { document.getElementById('project-dialog').textContent = id; },
 fetch: async url => {
   window.calls++; window.resources.push(url);
   if (window.mode === 'assets') {
     if (url.endsWith('/style')) return Response.json({ version: 8, glyphs: './fonts/{fontstack}/{range}.pbf', sprite: './sprite', sources: { base: { type: 'vector', url: './tiles.json' } }, layers: [{ id: 'labels', type: 'symbol', source: 'base', 'source-layer': 'places', layout: { 'text-field': 'A', 'text-font': ['Synthetic'], 'text-allow-overlap': true, 'icon-image': 'park', 'icon-allow-overlap': true } }] });
     if (url.endsWith('/tiles.json')) return Response.json({ tiles: ['./tiles/{z}/{x}/{y}.pbf'], maxzoom: 0 });
     if (url.includes('/fonts/')) return new Response(font);
     if (url.includes('/tiles/')) return new Response(tile);
     if (url.endsWith('.json')) return Response.json({ park: { x: 0, y: 0, width: 1, height: 1, pixelRatio: 1 } });
     if (url.endsWith('.png')) return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='), char => char.charCodeAt(0)));
   }
   if (window.mode === 'missing' || !url.endsWith('/style')) return new Response('', { status: 404 });
   return Response.json(window.mode === 'tiles' ? { version: 8, sources: { test: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } }, layers: [{ id: 'road', type: 'line', source: 'test', 'source-layer': 'road' }] }
   : { version: 8, sources: {}, layers: [{ id: 'land', type: 'background' }] });
 } }));
 window.retire = () => { root.unmount(); map.remove(); };
});
` }, bundle: true, format: 'esm', platform: 'browser', write: false, external: ['/tours/*'], define: { 'process.env.NODE_ENV': '"production"' } });

await mkdir('out/masterplan-preview', { recursive: true });
await writeFile('out/masterplan-preview/fixture.js', compiled.outputFiles[0].text);

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`master plan and basemap preserve selected property at ${width}px in ${theme}`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  const requested = [];
  t.after(() => { if (errors.length) console.error(errors); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path === '/') { const body = `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.css"><style>
body{margin:0;font:16px system-ui;background:${theme === 'dark' ? '#181c20' : '#faf9f5'};color:${theme === 'dark' ? '#eee' : '#222'};--ink:${theme === 'dark' ? '#eee' : '#222'};--surface-1:${theme === 'dark' ? '#24292e' : '#f3f0ea'}}
button,select{font:inherit;min-height:44px;max-width:100%}#map{height:420px}#controls{max-width:100%}
</style></head><body><div id="development-map"><div id="map"></div><div id="controls"></div></div><button aria-pressed="true" data-property-id="sample-property-1">Selected synthetic property</button><div id="project-dialog" role="status"></div><script type="module" src="/out/masterplan-preview/fixture.js"></script></body></html>`;
      await writeFile('out/masterplan-preview/index.html', body);
      return route.fulfill({ contentType: 'text/html', body });
    }
    if (path === '/out/masterplan-preview/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text });
    if (path.startsWith('/tours/vendor/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(`.${path}`) });
    return route.fulfill({ status: 404 });
  });
  try { await page.goto('http://localhost/', { waitUntil: 'domcontentloaded' }); }
  catch (error) { console.error({ requested, url: page.url() }); throw error; }
  await page.getByRole('checkbox', { name: 'Show master plan' }).waitFor();
  const entryLabel = await page.locator('.overlay-map-label').boundingBox();
  assert.ok(entryLabel.y >= 0 && entryLabel.x >= 0 && entryLabel.x + entryLabel.width <= width, 'Project label remains inside the map.');
  await page.evaluate(() => window.map.jumpTo({ center: [-100.46, 40.28], zoom: 10.3, bearing: 15 }));
  const camera = await page.evaluate(() => ({ center: window.map.getCenter().toArray(), zoom: window.map.getZoom(), bearing: window.map.getBearing() }));
  await page.getByRole('button', { name: 'Example Town Center', exact: true }).click();
  assert.equal(await page.locator('#project-dialog').innerText(), 'sample-development-1');
  const firstLabel = await page.locator('.overlay-map-label').boundingBox();
  await page.evaluate(() => window.map.panBy([25, 0], { duration: 0 }));
  await page.waitForFunction(x => Math.abs(document.querySelector('.overlay-map-label').getBoundingClientRect().x - x) > 10, firstLabel.x);
  await page.evaluate(() => window.map.jumpTo({ center: [-100.46, 40.28], zoom: 10.3, bearing: 15 }));
  await page.getByRole('checkbox').uncheck();
  assert.equal(await page.locator('.overlay-map-label').count(), 0);
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('s16-plan-sample-development-1-point', 'visibility')), 'none');
  await page.getByRole('checkbox').check();
  await page.getByRole('combobox', { name: 'Basemap' }).selectOption('vector');
  await page.getByText('Synthetic map data', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('water', 'visibility')), 'none');
  await page.getByRole('combobox').selectOption('local');
  await page.evaluate(() => { window.mode = 'assets'; });
  await page.getByRole('combobox').selectOption('vector');
  await page.waitForFunction(() => !document.querySelector('#controls').textContent.includes('Loading vector'));
  await page.getByText('Synthetic map data', { exact: true }).waitFor();
  await page.waitForFunction(() => window.map.isStyleLoaded());
  await page.waitForFunction(() => window.resources.some(url => url.includes('/fonts/')));
  await page.waitForFunction(() => window.map.isStyleLoaded());
  assert.equal(await page.evaluate(() => window.map.hasImage(window.map.getLayoutProperty('s16-vector-labels', 'icon-image'))), true);
  await page.getByRole('combobox').selectOption('local');
  assert.equal(await page.evaluate(() => window.map.getGlyphs()), null);
  await page.evaluate(() => { window.mode = 'tiles'; });
  await page.getByRole('combobox').selectOption('vector');
  await page.getByText('Vector basemap unavailable. Showing the permitted local map layers.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.map.getLayoutProperty('water', 'visibility')), 'visible');
  assert.deepEqual(await page.evaluate(() => ({ center: window.map.getCenter().toArray(), zoom: window.map.getZoom(), bearing: window.map.getBearing() })), camera);
  assert.equal(await page.locator('[data-property-id]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => Boolean(window.map.getLayer('property'))), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  await mkdir('/tmp/wr227-s16-j2-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/wr227-s16-j2-evidence/masterplan-${width}-${theme}.png` });
  await page.evaluate(() => window.retire());
});
