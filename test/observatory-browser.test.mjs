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
  const dom = openDom(html, { url: `https://app.example/observatory.html?thread=${thread}`, runScripts: 'outside-only', pretendToBeVisual: true });
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

test('pagination is hidden and disabled before the first read finishes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const room = openRoom(async () => {
    await pending;
    return { ok: true, json: async () => page(1, false) };
  }, '');
  try {
    assert.equal(room.document.getElementById('loadOlder').hidden, true);
    assert.equal(room.document.getElementById('loadOlder').disabled, true);
  } finally { release(); await settle(); }
});

for (const failure of ['network', 'http', 'conversation']) {
  test(`an initial ${failure} failure paints unavailable panels and Retry recovers`, async () => {
    let failing = true;
    const calls = [];
    const room = openRoom(async url => {
      calls.push(url);
      if (failing && (failure !== 'conversation' || new URL(url, 'https://app.example').searchParams.get('mode') === 'conversation')) {
        if (failure === 'http') return { ok: false, status: 503 };
        throw new Error('synthetic_network_code');
      }
      return { ok: true, json: async () => page(2, true, 'WR-2: Recovered room') };
    }, '');
    await settle();
    for (const id of ['presenceText', 'nowDialogue', 'runningList', 'attentionList', 'finishedList', 'currentThread', 'archiveList',
      'runningSummary', 'attentionSummary', 'finishedSummary']) {
      assert.match(room.document.getElementById(id).textContent, /unavailable/i, id);
    }
    assert.doesNotMatch(room.document.querySelector('main').textContent, /Reading|Checking|Connecting|synthetic_network_code|503/);
    assert.equal(room.document.getElementById('presenceDot').dataset.state, 'urgent');
    for (const id of ['runningCount', 'attentionCount', 'finishedCount', 'flowRunning', 'flowAttention', 'flowFinished']) {
      assert.equal(room.document.getElementById(id).textContent, '—');
    }
    const older = room.document.getElementById('loadOlder');
    assert.equal(older.hidden, true);
    assert.equal(older.disabled, true);
    older.click();
    assert.equal(calls.length, 2);
    const retry = room.document.getElementById('refreshButton');
    assert.equal(retry.textContent, 'Retry');
    assert.equal(retry.disabled, false);
    failing = false;
    retry.click();
    await settle();
    assert.equal(calls.length, 4);
    assert.match(room.document.getElementById('currentThread').textContent, /Recovered room/);
    assert.equal(retry.textContent, 'Refresh');
    assert.equal(older.hidden, false);
    assert.equal(older.disabled, false);
    older.click();
    await settle();
    assert.equal(new URL(calls[4], 'https://app.example').searchParams.get('before_seq'), '2');
  });
}

test('a response claiming more history without a valid cursor keeps pagination unavailable', async () => {
  for (const cursor of [undefined, null, '', 0, -1, 'invalid']) {
    const calls = [];
    const room = openRoom(async url => {
      calls.push(url);
      return { ok: true, json: async () => ({ ...page(1, true), before_seq: cursor }) };
    }, '');
    await settle();
    const older = room.document.getElementById('loadOlder');
    assert.equal(older.hidden, true, `cursor ${cursor}`);
    assert.equal(older.disabled, true, `cursor ${cursor}`);
    older.click();
    await settle();
    assert.equal(calls.length, 2);
  }
});

test('the final older page hides and disables pagination', async () => {
  const room = openRoom(async url => {
    const before = new URL(url, 'https://app.example').searchParams.get('before_seq');
    return { ok: true, json: async () => before ? page(1, false) : page(2, true) };
  }, '');
  await settle();
  const older = room.document.getElementById('loadOlder');
  older.click();
  await settle();
  assert.equal(older.hidden, true);
  assert.equal(older.disabled, true);
});

test('a failed later refresh paints unavailable state and Retry restores loaded history', async () => {
  let failing = false;
  const cursors = [];
  const room = openRoom(async url => {
    if (failing) throw new Error('offline');
    const before = new URL(url, 'https://app.example').searchParams.get('before_seq');
    if (before) cursors.push(before);
    return { ok: true, json: async () => before ? page(1, true, 'WR-1: Older history') : page(2, true, 'WR-2: Latest history') };
  }, '');
  await settle();
  room.document.getElementById('loadOlder').click();
  await settle();
  failing = true;
  room.poll();
  await settle();
  assert.match(room.document.getElementById('currentThread').textContent, /unavailable/i);
  failing = false;
  room.document.getElementById('refreshButton').click();
  await settle();
  assert.match(room.document.getElementById('archiveList').textContent, /Older history/);
  room.document.getElementById('loadOlder').click();
  await settle();
  assert.deepEqual(cursors, ['2', '1']);
});

test('an older-history failure preserves the cursor and the control retries it', async () => {
  let failing = true;
  const cursors = [];
  const room = openRoom(async url => {
    const before = new URL(url, 'https://app.example').searchParams.get('before_seq');
    if (before) {
      cursors.push(before);
      if (failing) throw new Error('synthetic_pagination_code');
    }
    return { ok: true, json: async () => page(before ? 1 : 2, true) };
  }, '');
  await settle();
  const older = room.document.getElementById('loadOlder');
  older.click();
  await settle();
  const toast = room.document.getElementById('roomToast');
  assert.match(toast.textContent, /unavailable/i);
  assert.doesNotMatch(toast.textContent, /synthetic_pagination_code/);
  assert.equal(older.hidden, false);
  assert.equal(older.disabled, false);
  failing = false;
  older.click();
  await settle();
  assert.deepEqual(cursors, ['2', '2']);
});
