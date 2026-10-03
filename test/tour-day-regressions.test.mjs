import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountTourDay } from '../tours/day.js';
import * as drafts from '../tours/day-store.js';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';
const html = await readFile(new URL('../tours/day.html', import.meta.url), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
function storage() {
  const notes = new Map(), tours = new Map();
  return {
    notes, async put(note) { notes.set(note.id, structuredClone(note)); },
    async patch(scope, id, changes) { const n = notes.get(id); if (!n || n.scope !== scope) return null; const next = structuredClone({ ...n, ...changes }); notes.set(id, next); return next; },
    async list(scope, id) { return structuredClone([...notes.values()].filter(n => n.scope === scope && n.tour_id === id)); },
    async putTour(scope, tour) { tours.set(scope, structuredClone({ tour, updated_at: new Date().toISOString() })); },
    async getTour(scope) { return structuredClone(tours.get(scope)); },
  };
}
// Implements only the Web Locks exclusive/ifAvailable semantics used by capture.
function locks() {
  const held = new Set();
  return { async request(name, options, fn) { if (held.has(name)) return fn(null); held.add(name); try { return await fn({ name }); } finally { held.delete(name); } } };
}
function media(window) {
  const instances = [];
  window.Blob = Blob;
  window.navigator.locks = locks();
  window.navigator.mediaDevices = { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } };
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { instances.push(this); this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    chunk() { this.ondataavailable({ data: new Blob(['synthetic original audio'], { type: 'audio/webm' }) }); }
    stop() { if (this.state === 'inactive') return; this.state = 'inactive'; queueMicrotask(() => this.onstop()); }
  };
  window.URL.createObjectURL = () => 'blob:synthetic'; window.URL.revokeObjectURL = () => {};
  return instances;
}
async function harness(t, options = {}) {
  const dom = new JSDOM(html, { url: `https://synthetic.test/tours/day.html?tour=${tourId}`, pretendToBeVisual: true });
  const { window } = dom, doc = window.document;
  const dialog = doc.querySelector('dialog'); dialog.showModal = function() { this.open = true; }; dialog.close = function() { this.open = false; };
  const recordings = media(window), store = options.store || storage(), current = structuredClone(detail);
  let scope = 'account-A';
  const api = { capabilities: { voiceNotes: false }, session: async () => ({ scope, user_ref: scope }), tour: async () => structuredClone(current) };
  const view = mountTourDay({ document: doc, window, api, store, prepareOffline: options.prepareOffline || (async () => {}), mapFactory: () => ({ dispatch() {}, update() {}, navigationLinks: () => [], destroy() {} }) });
  t.after(() => { view.dispose(); window.close(); }); await view.ready; await settle();
  return { window, doc, store, view, current, recordings, setScope(s) { scope = s; }, async start() { await doc.querySelector('#day-record').onclick(); }, async finish() { await doc.querySelector('#day-record').onclick(); await settle(); } };
}

test('R1: delayed failed finalization never reveals previous account recovery audio', async t => {
  const store = storage(), patch = store.patch; let rejectFinal;
  store.patch = async (scope, id, change) => {
    if (change.audio) throw new Error('quota');
    if (scope === 'account-A' && change.status && change.status !== 'empty') return new Promise((_, reject) => { rejectFinal = reject; });
    return patch(scope, id, change);
  };
  const h = await harness(t, { store }); await h.start(); h.recordings[0].chunk(); await settle();
  assert.ok(rejectFinal); h.setScope('account-B'); await h.view.refresh(); await h.view.refresh();
  assert.equal(h.doc.querySelectorAll('.note-card').length, 0);
  rejectFinal(new Error('quota')); await settle();
  assert.equal(h.doc.querySelectorAll('.note-card').length, 0);
  assert.doesNotMatch(h.doc.querySelector('#day-status').textContent, /Audio not saved/);
});

test('R5: failed durable audio is recorded as failed, while volatile audio remains recoverable', async t => {
  const store = storage(), patch = store.patch;
  store.patch = async (scope, id, change) => { if (change.audio) throw new Error('quota'); return patch(scope, id, change); };
  const h = await harness(t, { store }); await h.start(); h.recordings[0].chunk(); await settle();
  const [note] = await store.list('account-A', tourId);
  assert.equal(note.storage_error, true); assert.equal(note.status, 'failed'); assert.equal(note.audio, undefined);
  assert.doesNotMatch(drafts.noteState(note), /Saved on phone/);
  h.doc.querySelector('.note-card').click(); assert.ok(h.doc.querySelector('audio')); assert.ok(h.doc.querySelector('[download]'));
  await h.view.refresh(); assert.match(h.doc.querySelector('.note-card').textContent, /Audio not saved/);
  h.view.dispose(); const reloaded = await harness(t, { store });
  assert.match(reloaded.doc.querySelector('.note-card').textContent, /Audio not saved/);
  reloaded.doc.querySelector('.note-card').click(); assert.equal(reloaded.doc.querySelector('audio'), null);
});

test('R7: finish remains enabled after accepted active stops disappear', async t => {
  const h = await harness(t); await h.start(); h.recordings[0].chunk();
  h.current.routes[0].stops = []; await h.view.refresh();
  assert.equal(h.doc.querySelector('#day-record').disabled, false);
  assert.match(h.doc.querySelector('#day-record').getAttribute('aria-label'), /waterfront/);
  await h.finish(); const [note] = await h.store.list('account-A', tourId);
  assert.equal(note.property_id, detail.routes[0].stops[0].property_id); assert.equal(note.status, 'local');
});

test('R8: missing or ambiguous immutable capture identities fail closed', async t => {
  const h = await harness(t);
  for (const mutate of [d => { delete d.routes[0].id; }, d => { delete d.routes[0].stops[0].property_id; }, d => { d.routes[0].stops[0].property_id = 'bad'; }, d => { d.routes.push(structuredClone(d.routes[0])); }]) {
    Object.assign(h.current, structuredClone(detail)); mutate(h.current); await h.view.refresh();
    assert.equal(h.doc.querySelector('#day-record').disabled, true);
    await h.doc.querySelector('#day-record').onclick(); assert.equal(h.recordings.length, 0);
  }
});

test('R9: popup close and changed/unchanged polling preserve property and note focus', async t => {
  const h = await harness(t);
  h.doc.querySelector('.day-stop').focus(); h.doc.querySelector('.day-stop').click(); h.doc.querySelector('#day-dialog-close').click();
  assert.equal(h.doc.activeElement.dataset.stopId, detail.routes[0].stops[0].id);
  h.doc.querySelector('.property-open').focus(); await h.view.refresh(); assert.equal(h.doc.activeElement.className, 'property-open');
  h.current.routes[0].stops[0].access_notes = 'Synthetic updated access'; await h.view.refresh(); assert.equal(h.doc.activeElement.className, 'property-open');
  await h.start(); h.recordings[0].chunk(); await h.finish(); h.doc.querySelector('.note-card').focus(); await h.view.refresh(); assert.equal(h.doc.activeElement.className, 'note-card');
  h.doc.querySelector('.note-card').click(); h.doc.querySelector('summary').focus(); h.current.routes[0].stops[0].access_notes = 'Synthetic second update'; await h.view.refresh(); assert.equal(h.doc.activeElement.tagName, 'SUMMARY');
  h.doc.querySelector('#day-dialog-close').click(); assert.equal(h.doc.activeElement.className, 'note-card');
});

test('R11: failed itinerary cache remains visible through reads and recording', async t => {
  const store = storage(); store.putTour = async () => { throw new Error('quota'); };
  const h = await harness(t, { store }); assert.match(h.doc.querySelector('#day-status').textContent, /Offline itinerary unavailable/);
  await h.start(); h.recordings[0].chunk(); await h.finish(); await h.view.refresh(); assert.match(h.doc.querySelector('#day-status').textContent, /Offline itinerary unavailable/);
});

test('R11: shell install failure is visible until both cache paths recover', async t => {
  let failed = true;
  const h = await harness(t, { prepareOffline: async () => { if (failed) throw new Error('shell install failed'); } });
  assert.match(h.doc.querySelector('#day-status').textContent, /Offline app unavailable/);
  await h.view.refresh(); assert.match(h.doc.querySelector('#day-status').textContent, /Offline app unavailable/);
  failed = false; await h.view.refresh(); await settle(); assert.equal(h.doc.querySelector('#day-status').textContent, 'Voice notes stay on this phone');
});

test('R12: local capture has no dormant producer sync implementation or caller', async () => {
  assert.equal(drafts.createNoteSync, undefined); assert.equal(drafts.matchesNote, undefined);
  const source = await readFile(new URL('../tours/day.js', import.meta.url), 'utf8'); assert.doesNotMatch(source, /createNoteSync|\.sync\(/);
});
