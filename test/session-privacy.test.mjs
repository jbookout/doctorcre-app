import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { offlineTourSession } from '../js/offline-tour-session.js';
import { readSavedViews, writeSavedViews, SAVED_VIEWS_KEY } from '../js/search-model.js';

const storage = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k), key: i => [...values.keys()][i], get length() { return values.size; } };
};
function tab(shared) {
  const dom = new JSDOM('', { url: 'https://app.doctorcre.com/tours/day.html' });
  Object.defineProperty(dom.window, 'localStorage', { value: shared });
  return dom.window;
}

test('F07: user B cannot restore user A saved searches; legacy unscoped queries are discarded', () => {
  const store = storage();
  store.setItem(SAVED_VIEWS_KEY, JSON.stringify([{name:'A private query',query:'A intention'}]));
  assert.deepEqual([...readSavedViews(store, 'dell')], []);
  assert.equal(store.getItem(SAVED_VIEWS_KEY), null);
  writeSavedViews(store, [{name:'A private query',query:'A intention',kinds:[]}], 'joe');
  assert.deepEqual([...readSavedViews(store, 'dell')], []);
  assert.deepEqual([...readSavedViews(store)], []);
  assert.equal(readSavedViews(store, 'joe')[0].query, 'A intention');
});

test('F07: signing out in another tab invalidates an offline binding, including after offline reload', () => {
  const shared = storage(), a = tab(shared), b = tab(shared);
  const sessionA = offlineTourSession(a), sessionB = offlineTourSession(b);
  sessionA.save({scope:'private-A',userRef:'joe',tourId:'tour-A'});
  sessionB.save({scope:'private-A',userRef:'joe',tourId:'tour-A'});
  assert.ok(sessionB.read('tour-A'));
  sessionA.revoke();
  assert.equal(sessionB.read('tour-A'), null);
  assert.equal(offlineTourSession(b).read('tour-A'), null);
  a.close(); b.close();
});

async function serviceWorker() {
  const handlers = {}, stored = new Map([['/auth/session', new Response('{"actor":"previous"}')]]);
  let online = true;
  const cache = { addAll: async () => {}, put: async (request,response) => stored.set(new URL(request.url).pathname,response), match: async path => stored.get(path) };
  const context = { URL, Response, caches: { open: async () => cache, match: async request => stored.get(typeof request === 'string' ? request : new URL(request.url).pathname), keys: async () => [], delete: async () => true },
    fetch: async () => { if (!online) throw Error('offline'); return new Response('{"actor":"A"}', {headers:{'cache-control':'no-store'}}); },
    self: { location:{origin:'https://app.doctorcre.com'}, addEventListener:(name,fn) => {handlers[name]=fn;}, skipWaiting() {}, clients:{claim:async()=>{}} } };
  vm.runInNewContext(await readFile(new URL('../public-shell/sw.js',import.meta.url),'utf8'),context);
  return { stored, offline() {online=false;}, async fetch(path) { let result; handlers.fetch({request:{url:`https://app.doctorcre.com${path}`,method:'GET',mode:'cors'}, respondWith(value) {result=value;}}); return result; } };
}

test('F08: authenticated auth responses bypass offline cache, even when an older cache contains them', async () => {
  const sw = await serviceWorker();
  sw.stored.clear();
  assert.equal((await sw.fetch('/auth/session')).status,200);
  assert.equal(sw.stored.has('/auth/session'),false);
  sw.stored.set('/auth/session',new Response('{"actor":"previous"}'));
  sw.offline();
  assert.equal((await sw.fetch('/auth/session')).status,503);
});

test('F08: successful no-store responses outside the static shell are never cached', async () => {
  const sw = await serviceWorker();
  await sw.fetch('/private-record');
  assert.equal(sw.stored.has('/private-record'),false);
  await sw.fetch('/js/app-shell.js');
  assert.equal(sw.stored.has('/js/app-shell.js'),false);
});
