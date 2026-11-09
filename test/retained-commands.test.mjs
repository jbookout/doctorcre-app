import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetainedCommands } from '../js/retained-commands.mjs';
import { createLiveClient } from '../js/live-client.js';

test('a committed write with a lost reply replays its exact frozen request and receipt', async () => {
  let keys = 0, scope = 'session-a';
  const commands = createRetainedCommands({ newKey: () => `key-${++keys}`, scope: () => scope });
  const receipts = new Map(), sent = [];
  const send = async request => {
    sent.push(structuredClone(request));
    if (!receipts.has(request.idempotency_key)) {
      receipts.set(request.idempotency_key, { ok: true, event_id: 'original-receipt' });
      throw new Error('reply lost after commit');
    }
    return receipts.get(request.idempotency_key);
  };
  const args = { base_version: 3, fields: { title: 'Reviewed title' }, idempotency_key: 'caller-key' };
  await assert.rejects(commands.send('record-a', args, send), /reply lost/);
  args.fields.title = 'later unreviewed edit';
  assert.equal(commands.pending('record-a').fields.title, 'Reviewed title');
  await assert.rejects(commands.send('record-a', args, send), { code: 'unresolved_command' });
  const result = await commands.send('record-a', { base_version: 3, fields: { title: 'Reviewed title' }, idempotency_key: 'new-key-per-click' }, send);
  assert.equal(result.event_id, 'original-receipt');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].idempotency_key, 'caller-key');
  assert.equal(keys, 0);
  assert.equal(receipts.size, 1);
  assert.equal(commands.pending('record-a'), null);
});

test('unknown replies and failed HTTP responses retain the request; definitive conflict permits a reviewed new intent', async () => {
  let key = 0;
  const commands = createRetainedCommands({ newKey: () => `key-${++key}` });
  await assert.rejects(commands.send('record', { base_version: 1 }, async () => { throw Object.assign(new Error('unavailable'), { status: 503, payload: { error: 'proxy_error' } }); }));
  assert.equal(commands.pending('record').idempotency_key, 'key-1');
  await assert.rejects(commands.send('record', { base_version: 1 }, async () => { throw Object.assign(new Error('conflict'), { status: 409, payload: { error: 'version_conflict' } }); }));
  assert.equal(commands.pending('record'), null);
  await commands.send('record', { base_version: 2 }, async request => ({ ok: true, request }));
  assert.equal(key, 2);
});

test('an authorization failure after an unknown outcome preserves scoped reconciliation and cannot retarget another session', async () => {
  let scope = 'session-a', sends = 0;
  const commands = createRetainedCommands({ newKey: () => 'original-key', scope: () => scope });
  await assert.rejects(commands.send('record', { text: 'original' }, async () => { sends++; throw new Error('timeout'); }));
  await assert.rejects(commands.send('record', { text: 'original' }, async () => { sends++; throw Object.assign(new Error('signed out'), { status: 401 }); }));
  assert.equal(commands.pending('record').idempotency_key, 'original-key');
  scope = 'session-b';
  await assert.rejects(commands.send('record', { text: 'original' }, async () => { sends++; return { ok: true }; }), { code: 'session_changed' });
  assert.equal(sends, 2);
});

test('a second click during a send never issues another request', async () => {
  const commands = createRetainedCommands({ newKey: () => 'same-key' });
  let release;
  const sending = commands.send('record', { text: 'original' }, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(commands.send('record', { text: 'original' }, () => assert.fail('duplicate send')), { code: 'command_in_flight' });
  release({ ok: true });
  await sending;
});

test('national/review/candidate writes retain original keys across timeout retries and verified session changes block replay', async () => {
  let binding = 'synthetic-session-a', lost = true;
  const calls = [], receipts = new Map();
  const client = createLiveClient({ docContext: false, fetchImpl: async (path, init) => {
    if (path === '/auth/session') return new Response(JSON.stringify({ actor: { slug: 'joe' }, csrf_token: binding }));
    const message = JSON.parse(init.body), args = message.params.arguments;
    calls.push(args);
    const payload = receipts.get(args.idempotency_key) || { ok: true, event_id: 'synthetic-receipt' };
    receipts.set(args.idempotency_key, payload);
    if (lost) { lost = false; throw new Error('reply lost after commit'); }
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
  } });
  await assert.rejects(client.createNationalAccount({ name: 'Synthetic account', idempotency_key: 'original-key' }));
  binding = 'synthetic-session-b';
  await assert.rejects(client.createNationalAccount({ name: 'Synthetic account', idempotency_key: 'click-key' }), { code: 'session_changed' });
  assert.equal(calls.length, 1);
  binding = 'synthetic-session-a';
  await client.createNationalAccount({ name: 'Synthetic account', idempotency_key: 'click-key' });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(receipts.size, 1);
});

test('an email outcome check joins its observed send when it settles during session verification', async () => {
  let releaseSend, releaseScope, checks = 0, sends = 0;
  const commands = createRetainedCommands({ scope: () => ++checks === 1 ? 'original-session' : new Promise(resolve => { releaseScope = resolve; }) });
  const request = { proposal_id: 'proposal', idempotency_key: 'original-key' };
  const first = commands.send('email', request, () => { sends++; return new Promise(resolve => { releaseSend = resolve; }); }, 'confirmEmailFiling');
  await Promise.resolve();
  const checking = commands.send('email', request, async () => { sends++; return { ok: true }; }, 'confirmEmailFiling');
  releaseSend({ ok: true });
  await first;
  releaseScope('original-session');
  await checking;
  assert.equal(sends, 1);
  assert.equal(commands.details('email'), null);
});


test('Home review forwards the displayed source version and retains it after a lost receipt', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: Ajv } = await import('ajv');
  const { contract } = JSON.parse(await readFile(new URL('./fixtures/home-review-call-contract.json', import.meta.url)));
  const validate = new Ajv({ strict: false }).compile(contract.responseSchema);
  const sent = [];
  let lost = true;
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
    const { arguments: args } = JSON.parse(init.body).params;
    sent.push(args);
    if (lost) { lost = false; throw new Error('lost receipt'); }
    const payload = { ...contract.receipt, session_id: args.session_id };
    assert.equal(validate(payload), true);
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  } });
  const args = { session_id: 'session-1', expected_source_version: 'displayed-v1' };
  await assert.rejects(client.reviewCallOutcome(args));
  await client.reviewCallOutcome(args);
  assert.equal(sent[0].expected_source_version, 'displayed-v1');
  assert.deepEqual(sent[0], sent[1]);
  assert.ok(sent[0].idempotency_key);
});
