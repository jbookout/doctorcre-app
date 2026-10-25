import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createRoomTurnClient } from '../js/room-turn-client.js';

const contract = JSON.parse(readFileSync(new URL('../contracts/carr-interface.v1.json', import.meta.url)));
const reconciliation = JSON.parse(readFileSync(new URL(`../${contract.write_reconciliation.contract}`, import.meta.url)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const csrf = 'synthetic-session-a';
const read = path => readFileSync(new URL(`../js/${path}`, import.meta.url), 'utf8');

function transport({ lost = false, producer } = {}) {
  const calls = [], receipts = new Map();
  const fetchImpl = async (path, init = {}) => {
    if (path === '/api/room/turns?limit=1') return Response.json({ csrf_token: csrf });
    assert.equal(path, reconciliation.room.endpoint.split(' ')[1]);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('x-carr-csrf'), csrf);
    const payload = JSON.parse(init.body);
    calls.push(payload);
    for (const field of reconciliation.room.required) assert.ok(Object.hasOwn(payload, field), `producer requires ${field}`);
    assert.match(payload.idempotency_key, uuid, reconciliation.room.idempotency_key);
    let response;
    if (producer) response = await producer(new Request(`https://app.doctorcre.com${path}`, init));
    else {
      if (!receipts.has(payload.idempotency_key)) receipts.set(payload.idempotency_key, { ok: true, seq: receipts.size + 1 });
      response = Response.json(receipts.get(payload.idempotency_key));
    }
    if (lost) { lost = false; throw new Error('Synthetic response lost after commit'); }
    return response;
  };
  return { calls, receipts, fetchImpl };
}

function queue(t) {
  const fields = {
    enqueueTitle: { value: 'Synthetic task' }, enqueueBody: { value: 'Synthetic details' },
    enqueueTarget: { value: 'codex' }, queueNotice: {},
    queueComposer: { querySelector: () => ({}), querySelectorAll: () => [], reset() { fields.enqueueTitle.value = ''; } },
  };
  const context = vm.createContext({
    $: id => fields[id], location: { origin: 'https://app.doctorcre.com' },
    createRoomTurnClient: () => createRoomTurnClient({ fetchImpl: t.fetchImpl }), sessionFetch: t.fetchImpl,
  });
  const source = read('queue.js');
  const start = source.indexOf('const queueWrites =');
  assert.ok(start >= 0);
  vm.runInContext(source.slice(start, source.indexOf('async function readQueue(')) + '\nglobalThis.submit = enqueue;', context);
  return { send: () => context.submit({ preventDefault() {} }), fields };
}

function room(t) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: 'Synthetic Room turn', prepend() {}, focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $, roomWrites: createRoomTurnClient({ fetchImpl: t.fetchImpl, session: async () => csrf }),
    sessionFetch: t.fetchImpl, state: { csrf, viewer: 'joe', pending: new Map() },
    BODY_MAX: 20_000, composerSending: false,
    el: () => ({ remove() {} }), updateCounter() {}, render() {}, scrollToBottom() {},
    wirePoll: { refresh: async () => {} }, banner() {}, toast() {},
  });
  const source = read('progress-wire.js');
  const postStart = source.indexOf('const postTurn =');
  assert.ok(postStart >= 0);
  vm.runInContext(source.slice(postStart, source.indexOf('/* ------------------------------------------------------------ the stage', postStart)), context);
  const start = source.indexOf('async function sendComposer(');
  vm.runInContext(source.slice(start, source.indexOf('function toast(', start)) + '\nObject.assign(globalThis, {sendComposer, requestReconnect});', context);
  return { send: () => context.sendComposer(), reconnect: () => context.requestReconnect('codex'), nodes };
}

for (const caller of ['Room composer', 'queue enqueue', 'desk reconnect']) {
  test(`${caller} sends a producer-valid UUID and succeeds in the same session`, async () => {
    const t = transport(), h = caller === 'queue enqueue' ? queue(t) : room(t);
    await (caller === 'desk reconnect' ? h.reconnect() : h.send());
    assert.equal(t.calls.length, 1);
    assert.equal(t.receipts.size, 1, 'one authorized operation committed');
    if (caller === 'queue enqueue') {
      assert.equal(t.calls[0].body, '@queue enqueue target=codex cap=read :: Synthetic task\nSynthetic details');
      assert.equal(h.fields.enqueueTitle.value, '', 'successful submission resets the real form');
    } else if (caller === 'Room composer') {
      assert.equal(t.calls[0].body, 'Synthetic Room turn');
      assert.equal(h.nodes.get('composerInput').value, '', 'successful submission clears the real composer');
    } else assert.deepEqual(t.calls[0].control, { action: 'login', desk: 'codex' });
  });
  test(`${caller} retries the exact producer-valid payload after a committed answer is lost`, async () => {
    const t = transport({ lost: true }), h = caller === 'queue enqueue' ? queue(t) : room(t);
    const send = caller === 'desk reconnect' ? h.reconnect : h.send;
    await send();
    await send();
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls[1], t.calls[0]);
    assert.equal(t.receipts.size, 1, 'retry does not append a second turn');
  });
}

function pinnedRoomPost() {
  const source = execFileSync('git', ['-C', process.env.CARR_PRODUCER_CHECKOUT, 'show',
    `${contract.producer.source_commit}:mcp-server/src/dealroom-web.js`], { encoding: 'utf8' });
  const functions = ['roomControlTurn', 'roomTurnPost'].map(name => {
    const found = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(found, `pinned producer function ${name}`);
    return found[0].replace(/^export /, '');
  });
  const partner = execFileSync('git', ['-C', process.env.CARR_PRODUCER_CHECKOUT, 'show',
    `${contract.producer.source_commit}:mcp-server/src/partner-room.js`], { encoding: 'utf8' });
  const constants = ['ROOM_MAX_BODY', 'ROOM_BODY_MAX', 'ROOM_CONTROL_ACTIONS', 'ROOM_DESK_NAME'].map(name => {
    const found = (name === 'ROOM_BODY_MAX' ? partner : source).match(new RegExp(`^(?:export )?const ${name} = .*;$`, 'm'));
    assert.ok(found, `pinned producer constant ${name}`);
    return found[0].replace(/^export /, '');
  });
  const context = vm.createContext({
    json: (payload, status = 200) => Response.json(payload, { status }),
    guardSystemWorkPost: async (request, _env, session) => {
      assert.equal(request.headers.get('x-carr-csrf'), session.csrfToken);
      return { value: await request.json() };
    },
    personalScopeForActor: actor => ({ status: 'personal', sponsor: actor.slug }),
    roomMessageId: async (session, actor, key) => `${session}:${actor}:${key}`,
  });
  vm.runInContext([...constants, ...functions].join('\n') + '\nglobalThis.post = roomTurnPost;', context);
  const receipts = new Map();
  return {
    receipts,
    post: request => context.post(request, {}, { key: 'synthetic-session', csrfToken: csrf, actor: { slug: 'joe' } }, {
      roomWriteFn: async (_env, args) => {
        if (!receipts.has(args.msgId)) receipts.set(args.msgId, { ok: true, seq: receipts.size + 1 });
        return receipts.get(args.msgId);
      },
    }),
  };
}

test('real Room, queue and reconnect payloads pass the exact pinned producer before dispatch and replay once', {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && 'Set CARR_PRODUCER_CHECKOUT to execute the pinned producer',
}, async () => {
  const producer = pinnedRoomPost();
  for (const payload of [{ body: 'Synthetic turn' }, { control: { action: 'login', desk: 'codex' } }]) {
    const refusal = await producer.post(new Request('https://app.doctorcre.com/api/room/turn', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-carr-csrf': csrf }, body: JSON.stringify(payload),
    }));
    assert.equal(refusal.status, 400);
    assert.equal((await refusal.json()).error, 'idempotency_key_required');
    assert.equal(producer.receipts.size, 0, 'missing keys are refused before dispatch');
  }
  for (const caller of ['Room composer', 'queue enqueue', 'desk reconnect']) {
    const before = producer.receipts.size;
    const t = transport({ lost: true, producer: producer.post }), h = caller === 'queue enqueue' ? queue(t) : room(t);
    const send = caller === 'desk reconnect' ? h.reconnect : h.send;
    await send(); await send();
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls[1], t.calls[0]);
    assert.equal(producer.receipts.size, before + 1, caller);
  }
});
