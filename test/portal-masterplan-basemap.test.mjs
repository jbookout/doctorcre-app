import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const built = await build({ entryPoints: ['src/ui/portal/masterplan-provider.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { providerSession } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
function receipt() {
  return { provider: 'Synthetic', sku: 'offline-test', termsUrl: 'https://example.com/terms', reviewer: 'Synthetic reviewer', reviewedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', renderer: 'maplibre-gl@6.4.1', storageClass: 'memory-only', storableFields: [], retention: 'none', purge: 'unmount', attribution: 'Synthetic tiles', exportPath: 'none', quotaGate: '60/minute', resourcePrefixes: ['https://example.com/'] };
}
const now = () => Date.parse('2026-11-05T00:00:00Z');
test('provider bounds attempts, concurrent reads, response size and cancellation', async () => {
  let calls = 0;
  const failed = providerSession({ receipt: receipt(), now, fetch: async () => { calls++; return new Response('', { status: 404 }); } });
  await assert.rejects(failed.read('https://example.com/style'));
  await assert.rejects(failed.read('https://example.com/style'));
  assert.equal(calls, 2);
  const rate = providerSession({ receipt: receipt(), now, fetch: async () => new Response('ok') });
  for (let i = 0; i < 60; i++) await rate.read('https://example.com/tile');
  await assert.rejects(rate.read('https://example.com/tile'));
  const large = providerSession({ receipt: receipt(), now, fetch: async () => new Response(new Uint8Array(2097153)) });
  await assert.rejects(large.read('https://example.com/tile'), /too large/);
  let aborted = 0;
  const pending = providerSession({ receipt: receipt(), now, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); })) });
  const reads = [pending.read('https://example.com/1'), pending.read('https://example.com/2')];
  await assert.rejects(pending.read('https://example.com/3'));
  pending.dispose();
  await Promise.all(reads.map(read => assert.rejects(read, /aborted/)));
  assert.equal(aborted, 2);
  await assert.rejects(pending.read('https://example.com/4'));
});
test('only receipt-authorized credential-free resources load and expiry applies to each read', async () => {
  let instant = now();
  let calls = 0;
  const session = providerSession({ receipt: receipt(), now: () => instant, fetch: async (_url, options) => {
    calls++;
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response('ok');
  } });
  for (const url of ['http://example.com/tile', 'https://other.example/tile', 'https://example.com/tile?key=secret', 'https://user:pass@example.com/tile']) await assert.rejects(session.read(url));
  await session.read('https://example.com/tile');
  instant = Date.parse('2027-01-01');
  await assert.rejects(session.read('https://example.com/tile'));
  assert.equal(calls, 1);
});
test('provider deadline aborts a stalled fetch without scheduling another request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const session = providerSession({ receipt: receipt(), now, fetch: async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('deadline'))));
  } });
  const read = session.read('https://example.com/style');
  t.mock.timers.tick(5000);
  await assert.rejects(read, /deadline/);
  assert.equal(calls, 1);
  session.dispose();
});
test('provider refuses absent, stale, future and renderer-mismatched rights before fetch', async () => {
  let calls = 0;
  for (const rights of [undefined, { ...receipt(), expiresAt: '2026-11-04' }, { ...receipt(), reviewedAt: '2026-11-06' }, { ...receipt(), renderer: 'other' }]) {
    const session = providerSession({ receipt: rights, now, fetch: async () => { calls++; return new Response('ok'); } });
    await assert.rejects(session.read('https://example.com/style'));
    session.dispose();
  }
  assert.equal(calls, 0);
});
test('overlay updates and vector failures preserve camera, selection and unrelated layers', async () => {
  const result = await build({ entryPoints: ['src/ui/portal/masterplan-basemap.tsx'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { masterplanController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  const publication = JSON.parse(await readFile('test/fixtures/masterplan/example-health.market-study.json'));
  const sources = new Map();
  const layers = new Map([['water', {}], ['roads', {}], ['property', { selected: 'sample-property-1' }]]);
  const listeners = new Map();
  const map = { camera: [10, 20, 7], addSource: (id, source) => sources.set(id, source), getSource: id => sources.get(id), removeSource: id => sources.delete(id),
    addLayer: layer => layers.set(layer.id, layer), getLayer: id => layers.get(id), removeLayer: id => layers.delete(id),
    setLayoutProperty: (id, key, value) => { layers.get(id)[key] = value; },
    on: (...args) => listeners.set(args.slice(0, -1).join(':'), args.at(-1)), off: (...args) => listeners.delete(args.slice(0, -1).join(':')) };
  let state;
  let opened;
  const protocols = new Map();
  const controller = masterplanController({ map, registry: { addProtocol: (key, handler) => protocols.set(key, handler), removeProtocol: key => protocols.delete(key) }, localLayerIds: ['water', 'roads'], onState: value => { state = value; }, openProject: id => { opened = id; }, receipt: receipt(), now,
    fetch: async url => url.endsWith('/style') ? Response.json({ version: 8, sources: { base: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } }, layers: [{ id: 'land', type: 'fill', source: 'base', 'source-layer': 'land' }] }) : new Response('', { status: 404 }) });
  controller.overlays(publication.developments);
  assert.equal(sources.size, 1);
  controller.visible(false);
  assert.ok([...layers.values()].some(layer => layer.visibility === 'none'));
  controller.visible(true);
  listeners.get('click:s16-plan-sample-development-1-point')();
  assert.equal(opened, 'sample-development-1');
  await controller.vector('https://example.com/style');
  assert.equal(state.kind, 'vector');
  assert.equal(layers.get('water').visibility, 'none');
  const handler = [...protocols.values()][0];
  await assert.rejects(handler({ url: `${[...protocols.keys()][0]}://https://example.com/1/1/1.pbf` }, new AbortController()));
  assert.equal(state.kind, 'fallback');
  assert.equal(layers.get('water').visibility, 'visible');
  assert.deepEqual(map.camera, [10, 20, 7]);
  assert.deepEqual(layers.get('property'), { selected: 'sample-property-1' });
  controller.overlays([]);
  assert.equal(sources.size, 0);
  controller.dispose();
  assert.equal(protocols.size, 0);
  assert.equal(listeners.size, 0);
});
test('missing style, unsupported assets, overlay errors and late loads keep the local map usable', async () => {
  const result = await build({ entryPoints: ['src/ui/portal/masterplan-basemap.tsx'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { masterplanController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  let state;
  let mode = 'missing';
  let suppliedStyle = { version: 8, sources: {}, layers: [], sprite: 'https://example.com/sprite' };
  let resolve;
  const layers = new Map([['water', {}], ['roads', {}], ['selected-property', {}]]);
  const sources = new Map();
  const listeners = new Map();
  const map = { addSource: (id, source) => { if (mode === 'bad-overlay') throw Error('bad geometry'); sources.set(id, source); }, getSource: id => sources.get(id), removeSource: id => sources.delete(id),
    addLayer: layer => layers.set(layer.id, layer), getLayer: id => layers.get(id), removeLayer: id => layers.delete(id), setLayoutProperty: (id, key, value) => { layers.get(id)[key] = value; },
    on: (...args) => listeners.set(args.slice(0, -1).join(':'), args.at(-1)), off: (...args) => listeners.delete(args.slice(0, -1).join(':')) };
  const controller = (overrides = {}) => masterplanController({ map, registry: { addProtocol() {}, removeProtocol() {} }, localLayerIds: ['water', 'roads'], onState: value => { state = value; }, openProject() {}, receipt: receipt(), now,
    fetch: async () => mode === 'missing' ? new Response('', { status: 404 }) : mode === 'pending' ? new Promise(done => { resolve = done; }) : Response.json(suppliedStyle), ...overrides });
  let current = controller();
  await current.vector('https://example.com/style');
  assert.equal(state.kind, 'fallback');
  current.dispose();
  mode = 'capacity'; current = controller();
  current.overlays(Array.from({ length: 33 }, (_, i) => ({ id: `plan-${i}`, title: 'Synthetic', overlay: { type: 'FeatureCollection', features: [{}] } })));
  assert.match(state.notice, /capacity/);
  for (const style of [
    { version: 8, sources: {}, layers: Array.from({ length: 65 }, (_, i) => ({ id: String(i), type: 'background' })) },
    { version: 8, sources: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), {}])), layers: [] },
  ]) {
    suppliedStyle = style;
    await current.vector('https://example.com/style');
    assert.equal(state.kind, 'fallback');
    assert.equal(sources.size, 0);
  }
  current.dispose();
  mode = 'unsupported'; current = controller();
  suppliedStyle = { version: 8, sources: {}, layers: [], sprite: 'https://example.com/sprite' };
  await current.vector('https://example.com/style');
  assert.equal(state.kind, 'fallback');
  mode = 'bad-overlay';
  current.overlays([{ id: 'synthetic', title: 'Synthetic', overlay: { type: 'FeatureCollection', features: [{}] } }]);
  assert.match(state.notice, /Master plan unavailable/);
  assert.equal(sources.size, 0);
  current.dispose();
  mode = 'valid'; suppliedStyle = { version: 8, sources: {}, layers: [] }; current = controller();
  await current.vector('https://example.com/style');
  assert.equal(state.kind, 'vector');
  current.dispose();
  assert.equal(state.kind, 'disposed');
  mode = 'pending'; current = controller();
  const waiting = current.vector('https://example.com/style');
  assert.equal(state.kind, 'loading');
  current.local();
  assert.equal(state.kind, 'local');
  resolve(Response.json({ version: 8, sources: {}, layers: [] }));
  await waiting;
  assert.equal(state.kind, 'local');
  const retiring = current.vector('https://example.com/style');
  current.dispose();
  resolve(Response.json({ version: 8, sources: {}, layers: [] }));
  await retiring;
  assert.equal(state.kind, 'disposed');
  assert.deepEqual([...layers.keys()], ['water', 'roads', 'selected-property']);
  current = controller({ receipt: undefined });
  await current.vector('https://example.com/style');
  assert.equal(state.kind, 'fallback');
  current.dispose();
  current = controller({ localLayerIds: ['absent'] });
  await current.vector('https://example.com/style');
  assert.match(state.notice, /Map unavailable. The property list/);
  current.dispose();
});
