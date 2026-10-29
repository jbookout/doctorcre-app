import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMarketMap } from '../js/market-map-shell.js';

test('shared map lifecycle constructs once and removes listeners and renderer on disposal', async () => {
  const dom = new JSDOM('<div></div>'), root = dom.window.document.querySelector('div');
  const maps = [], events = new Map();
  const gl = { setWorkerUrl() {}, Map: class {
    constructor(options) { this.options = options; maps.push(this); }
    on(name, listener) { events.set(name, listener); }
    off(name, listener) { assert.equal(events.get(name), listener); events.delete(name); }
    remove() { this.removed = true; }
  } };
  let moved = 0;
  const view = mountMarketMap(root, { style: { version: 8, sources: {}, layers: [] },
    loadMapLibre: async () => gl, events: { moveend: () => moved++ } });
  await view.ready;
  await view.ready;
  assert.equal(maps.length, 1);
  assert.equal(maps[0].options.container, root);
  events.get('moveend')(); assert.equal(moved, 1);
  view.destroy(); view.destroy();
  assert.equal(maps[0].removed, true); assert.equal(events.size, 0);
  dom.window.close();
});

test('disposing while MapLibre loads never constructs a renderer', async () => {
  const dom = new JSDOM('<div></div>'); let finish, constructed = 0;
  const view = mountMarketMap(dom.window.document.querySelector('div'), {
    loadMapLibre: () => new Promise(resolve => { finish = resolve; }),
  });
  view.destroy();
  finish({ Map: class { constructor() { constructed++; } }, setWorkerUrl() {} });
  await view.ready;
  assert.equal(constructed, 0);
  dom.window.close();
});

test('aborting a territory mount before its first painted frame removes the renderer and pending listeners', { timeout: 5000 }, async () => {
  const { mountTerritoryMap } = await import('../js/leads-territory-map.js');
  const dom = new JSDOM('<div></div>'), events = new Map(), maps = [];
  const controller = new AbortController();
  const gl = { setWorkerUrl() {}, Map: class {
    constructor() { maps.push(this); }
    on(name, listener) { events.set(name, listener); }
    off(name, listener) { if (events.get(name) === listener) events.delete(name); }
    fitBounds() {}
    remove() { this.removed = true; events.clear(); }
  } };
  const pending = mountTerritoryMap(dom.window.document.querySelector('div'), () => {}, () => {}, {
    signal: controller.signal, markets: [], loadMapLibre: async () => gl,
    fetchImpl: async path => ({ ok: true, json: async () => path.endsWith('.json') ? [] : { type: 'FeatureCollection', features: [] } }),
  });
  while (!events.has('idle')) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(maps.length, 1); assert.equal(maps[0].removed, true); assert.equal(events.size, 0);
  dom.window.close();
});
