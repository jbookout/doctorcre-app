import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { handleDoctorcreRequest } from '../src/worker.js';
const source = await readFile(new URL('../public-shell/sw.js', import.meta.url), 'utf8');
function worker(windows = []) {
  const handlers = {}, shown = [], opened = []; let cacheReads = 0;
  const self = { location: { origin: 'https://app.example' }, addEventListener: (name, fn) => { handlers[name] = fn; },
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url); } } };
  vm.runInNewContext(source, { self, URL, caches: { open() { cacheReads++; throw Error('Business payload cached'); } } });
  async function fire(name, event) { let work; assert.ok(handlers[name], `${name} handler exists`); handlers[name]({ ...event, waitUntil(p) { work = p; } }); await work; }
  const push = event_id => fire('push', { data: { json: () => ({ schema_version: 'web-push.v1', event_id, path: `/inbox/card/${encodeURIComponent(event_id)}` }) } });
  return { fire, push, shown, opened, cacheReads: () => cacheReads };
}
test('cold_push_tap_opens_exact_encoded_inbox_card_after_sign_in', async () => {
  const w = worker(), id = 'partner-needed:synthetic/event 1'; await w.push(id);
  await w.fire('notificationclick', { notification: { data: w.shown[0][1].data, close() {} } });
  assert.deepEqual(w.opened, [`https://app.example/inbox/card/${encodeURIComponent(id)}`]);
  let signedIn = false; const gates = [], assets = [];
  const env = {
    CARR: { async fetch(request) { gates.push(new URL(request.url).pathname); return signedIn ? new Response(null) : new Response(null, { status: 302, headers: { location: '/auth/login?return_to=%2F' } }); } },
    ASSETS: { async fetch(request) { assets.push(new URL(request.url).pathname); return new Response('Synthetic Inbox shell'); } },
  };
  const denied = await handleDoctorcreRequest(new Request(w.opened[0]), env);
  assert.equal(denied.status, 302); assert.equal(assets.length, 0);
  const returnTo = new URL(denied.headers.get('location')).searchParams.get('return_to');
  assert.equal(returnTo, `/inbox/card/${encodeURIComponent(id)}`);
  signedIn = true;
  const allowed = await handleDoctorcreRequest(new Request(new URL(returnTo, 'https://app.example')), env);
  assert.equal(allowed.status, 200); assert.deepEqual(assets, ['/inbox.html']); assert.deepEqual(gates, ['/', '/']);
});
test('existing_window_navigation', async () => {
  const navigated = []; let focused = 0;
  const w = worker([{ url: 'https://app.example/inbox', navigate: async url => { navigated.push(url); }, focus: async () => { focused++; } }]);
  await w.push('event-a'); await w.fire('notificationclick', { notification: { data: w.shown[0][1].data, close() {} } });
  assert.deepEqual(navigated, ['https://app.example/inbox/card/event-a']); assert.equal(focused, 1); assert.equal(w.opened.length, 0);
});
test('malformed_payload_and_malicious_path', async () => {
  const w = worker();
  for (const path of ['https://evil.example/inbox/card/a', 'javascript:alert(1)', 'data:text/html,x', '//evil.example/inbox/card/a', '/inbox/card/b', '/inbox/card/a?x=1', '/inbox/card/%61']) {
    await w.fire('push', { data: { json: () => ({ schema_version: 'web-push.v1', event_id: 'a', path }) } });
    await w.fire('notificationclick', { notification: { data: { event_id: 'a', path }, close() {} } });
  }
  await w.fire('push', { data: { json() { throw Error('bad JSON'); } } });
  assert.equal(w.shown.length, 0); assert.equal(w.opened.length, 0);
});
test('distinct_cards_remain_distinct', async () => {
  const w = worker(); await w.push('a'); await w.push('b'); assert.notEqual(w.shown[0][1].tag, w.shown[1][1].tag);
});
test('duplicate_event_tag_and_no_cached_push_payload', async () => {
  const w = worker(); await w.push('a'); await w.push('a'); assert.equal(w.shown[0][1].tag, w.shown[1][1].tag);
  assert.equal(w.cacheReads(), 0); assert.deepEqual(Object.keys(w.shown[0][1].data).sort(), ['event_id', 'path']);
});
