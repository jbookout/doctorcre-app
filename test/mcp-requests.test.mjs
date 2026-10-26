import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpRequests } from '../js/mcp-requests.mjs';
import { createLiveClient } from '../js/live-client.js';
import { createLeadBoardClient } from '../js/leads-client.js';

test('Live change polling keeps its bounded GET interface and normalized events', async () => {
  const sent = [];
  const client = createLiveClient({ docContext: false, fetchImpl: async (path, init) => {
    sent.push({ path, init });
    return { ok: true, json: async () => ({ cursor: 'next', events: [
      { field: 'phase', old_value: { phase: 'due_diligence' }, new_value: { phase: 'closed' } },
    ] }) };
  } });
  const result = await client.getChanges('synthetic-cursor');
  assert.equal(sent[0].path, '/pipeline/changes?cursor=synthetic-cursor');
  assert.equal(sent[0].init.credentials, 'same-origin');
  assert.ok(sent[0].init.signal instanceof AbortSignal);
  assert.deepEqual(result, { cursor: 'next', events: [
    { field: 'phase', old_value: 'Diligence', new_value: 'Closed' },
  ] });
});

test('MCP requests return decoded outcomes and retain exact request arguments', async () => {
  const sent = [];
  const request = createMcpRequests({ fetchImpl: async (path, init) => {
    sent.push({ path, init });
    return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: '{"ok":true,"event_id":"synthetic-event"}' }] } }) };
  } });
  const args = { idempotency_key: 'same-key', expected_actor: 'example-partner' };
  assert.deepEqual(await request('synthetic-command', args), { kind: 'payload', payload: { ok: true, event_id: 'synthetic-event' }, isError: false });
  assert.equal(sent[0].path, '/mcp');
  assert.equal(sent[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(sent[0].init.body), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic-command', arguments: args } });
});

test('a missing MCP result is an unknown mutation outcome through both domain clients', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1 }) });
  const live = createLiveClient({ fetchImpl, docContext: false });
  const leads = createLeadBoardClient({ fetchImpl, docContext: false });
  await assert.rejects(live.addLoop({ idempotency_key: 'same-key' }), { code: 'unknown_outcome' });
  await assert.rejects(leads.claimLead({ id: 'synthetic-lead', base_version: 1 }, 'same-key'), { code: 'unknown_outcome' });
});

test('authorization is decided from headers without touching a stalled body', async () => {
  for (const status of [401, 403]) {
    const request = createMcpRequests({ fetchImpl: async () => ({ ok: false, status, json() { assert.fail('authorization body read'); } }) });
    assert.deepEqual(await request('synthetic-command'), { kind: 'authorization', status });
  }
});

test('malformed and failed MCP replies carry uncertainty facts, never business refusals', async () => {
  for (const [response, reason] of [
    [{ ok: true, json: async () => { throw Error('broken JSON'); } }, 'envelope'],
    [{ ok: true, json: async () => ({ result: { content: [null] } }) }, 'content'],
    [{ ok: true, json: async () => ({ result: { content: { find: 1 } } }) }, 'content'],
    [{ ok: true, json: async () => ({ result: { content: [] } }) }, 'missing'],
    [{ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'broken' }] } }) }, 'payload'],
    [{ ok: true, json: async () => ({ error: { message: 'synthetic fault' } }) }, 'rpc'],
    [{ ok: false, status: 503, text: async () => 'synthetic gateway failure' }, 'http'],
  ]) {
    const request = createMcpRequests({ fetchImpl: async () => response });
    const outcome = await request('synthetic-command');
    assert.equal(outcome.kind, 'unconfirmed');
    assert.equal(outcome.reason, reason);
  }
});

test('MCP deadlines bound decoding and abort transport even when it ignores cancellation', async () => {
  for (const phase of ['request', 'body']) {
    let expire, signal;
    const request = createMcpRequests({ clock: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} }, fetchImpl: async (_, init) => {
      signal = init.signal;
      if (phase === 'request') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    } });
    const pending = request('synthetic-command', {}, { timeoutMs: 10 });
    await Promise.resolve();
    expire();
    const outcome = await pending;
    assert.equal(outcome.reason, 'deadline');
    assert.equal(outcome.cause.code, 'read_timeout');
    assert.equal(signal.aborted, true);
  }
});

test('domain clients preserve distinct command knowledge for the same confirmed payload', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: '{"ok":false,"conflict":{"id":"synthetic-conflict"}}' }] } }) });
  const live = createLiveClient({ fetchImpl, docContext: false });
  const leads = createLeadBoardClient({ fetchImpl, docContext: false });
  assert.equal((await live.patchDealField({ deal: 'synthetic-deal', field: 'attention', value: true, idempotency_key: 'same-key' })).status, 'conflict');
  await assert.rejects(leads.claimLead({ id: 'synthetic-lead', base_version: 1 }, 'same-key'), { code: 'tool_error' });
});

test('Live retains its first-item content contract while Leads requires typed text content', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { content: [{ text: '{"ok":true}' }] } }) });
  assert.deepEqual(await createLiveClient({ fetchImpl, docContext: false }).addLoop({ idempotency_key: 'same-key' }), { ok: true });
  await assert.rejects(createLeadBoardClient({ fetchImpl, docContext: false }).claimLead({ id: 'synthetic-lead', base_version: 1 }, 'same-key'), { code: 'unknown_outcome' });
});

test('Live read methods carry the caller signal to transport and leave MCP arguments unchanged', async () => {
  const calls = [
    ['find', client => (signal => client.find({ query: 'synthetic' }, { signal })), { query: 'synthetic' }],
    ['find-and-catch-up', client => (signal => client.findAndCatchUp({ query: 'synthetic', limit: 3 }, { signal })), { query: 'synthetic', limit: 3 }],
    ['loop-board', client => (signal => client.loopBoard({ kind: 'task', status: 'open' }, { signal })), { kind: 'task', status: 'open' }],
    ['deal-room-board', client => (signal => client.getBoard({ workspace: 'all', signal })), { workspace: 'all' }],
  ];
  for (const [verb, call, args] of calls) {
    let sent;
    const client = createLiveClient({ docContext: false, fetchImpl: async (_path, init) => {
      sent = init;
      return new Promise(() => {}); // a held read that only the caller can end
    } });
    const caller = new AbortController();
    const pending = call(client)(caller.signal);
    await new Promise(resolve => setImmediate(resolve));
    const body = JSON.parse(sent.body);
    assert.equal(body.params.name, verb);
    assert.deepEqual(body.params.arguments, args, `${verb} sends only its MCP arguments`);
    assert.equal(sent.signal.aborted, false);
    caller.abort();
    assert.equal(sent.signal.aborted, true, `${verb} aborts its transport with the caller`);
    await assert.rejects(pending, error => error.code === 'read_timeout');
  }
});

test('S2 MCP writes transmit the verified session token with the retained operation',async()=>{
 let binding='synthetic-session-a',lost=true;const sent=[];
 const client=createLiveClient({docContext:false,fetchImpl:async(path,init)=>{
  if(path==='/auth/session')return Response.json({actor:{slug:'joe'},csrf_token:binding});
  sent.push({args:JSON.parse(init.body).params.arguments,csrf:init.headers['x-carr-csrf']});
  if(lost){lost=false;throw new Error('timeout after commit');}
  return Response.json({result:{content:[{type:'text',text:JSON.stringify({ok:true,replayed:true})}]}});
 }});
 const args={deal:'demo',text:'Original step',base_version:1,idempotency_key:'original-operation'};
 await assert.rejects(client.setNextStep(args));
 assert.equal(sent[0].csrf,'synthetic-session-a');
 binding='synthetic-session-b';await assert.rejects(client.setNextStep(args),/session/i);assert.equal(sent.length,1);
 binding='synthetic-session-a';await client.setNextStep(args);assert.deepEqual(sent[1],sent[0]);
});
