import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDom } from './jsdom-harness.mjs';
import { groupConversations, labelFor, modelFor, summarizeNow } from '../js/observatory-model.js';

const html = await readFile(new URL('../observatory.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../js/observatory.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const turn = (seq, body = `WR-${seq}: Topic ${seq}`) => ({ seq: String(seq), msg_id: `m${seq}`, seat: 'human', sponsor: 'joe', kind: 'turn', body, at: new Date().toISOString() });
const page = (seq, more = true, body) => ({ turns: [turn(seq, body)], before_seq: seq, more });

function openRoom(fetch, thread = 'wr-000001') {
  const dom = openDom(html, { url: `https://app.example/observatory.html?thread=${thread}`, runScripts: 'outside-only' });
  let poll;
  Object.assign(dom.window, { fetch, groupConversations, labelFor, modelFor, summarizeNow, matchMedia: () => ({ matches: true }) });
  dom.window.setInterval = callback => { poll = callback; };
  dom.window.eval(source);
  return { document: dom.window.document, poll: () => poll() };
}

test('refresh, polling and older-history clicks share one in-flight read', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const room = openRoom(async url => {
    calls.push(url);
    if (calls.length <= 2) await pending;
    return { ok: true, json: async () => page(20, calls.length < 15) };
  });
  room.poll();
  room.document.getElementById('refreshButton').click();
  room.document.getElementById('loadOlder').click();
  try { assert.equal(calls.length, 2); }
  finally { release(); await settle(); }
  assert.equal(room.document.getElementById('refreshButton').disabled, false);
});

test('a deep link stops paging at the selected thread and preserves the older-history cursor', async () => {
  const cursors = [];
  const room = openRoom(async url => {
    const before = new URL(url, 'https://app.example').searchParams.get('before_seq');
    if (before) cursors.push(before);
    return { ok: true, json: async () => before ? page(10, cursors.length < 10, 'WR-1: Selected topic') : page(20, true) };
  });
  await settle();
  assert.deepEqual(cursors, ['20']);
  assert.match(room.document.getElementById('currentThread').textContent, /Selected topic/);
  room.poll();
  await settle();
  assert.deepEqual(cursors, ['20']);
  room.document.getElementById('loadOlder').click();
  await settle();
  assert.deepEqual(cursors, ['20', '10']);
});

test('an absent deep link has a bounded initial walk and waits for Load older', async () => {
  const cursors = [];
  const room = openRoom(async url => {
    const before = new URL(url, 'https://app.example').searchParams.get('before_seq');
    if (before) cursors.push(before);
    return { ok: true, json: async () => page(before ? Number(before) - 1 : 100, Number(before) > 90 || !before) };
  });
  await settle();
  assert.equal(cursors.length, 5);
  assert.match(room.document.getElementById('currentThread').textContent, /Load older threads/);
  assert.equal(room.document.getElementById('loadOlder').hidden, false);
  room.poll();
  await settle();
  assert.equal(cursors.length, 5);
  room.document.getElementById('loadOlder').click();
  await settle();
  assert.equal(cursors.length, 6);
});

test('a failed refresh releases the read guard so Refresh can retry', async () => {
  let failing = true;
  let calls = 0;
  const room = openRoom(async () => {
    calls++;
    if (failing) throw new Error('offline');
    return { ok: true, json: async () => page(1, false, 'WR-1: Recovered') };
  });
  await settle();
  failing = false;
  room.document.getElementById('refreshButton').click();
  await settle();
  assert.equal(calls, 4);
  assert.match(room.document.getElementById('currentThread').textContent, /Recovered/);
});
