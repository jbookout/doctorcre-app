import test from "node:test";
import assert from "node:assert/strict";
import { createSystemWorkClient } from "../js/system-work-client.js";

function harness(responses = []) {
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift() || { status: 200, body: { ok: true, data: {} } };
    return new Response(JSON.stringify(next.body), { status: next.status,
      headers: { "content-type": "application/json" } });
  };
  return { calls, client: createSystemWorkClient({ fetchImpl, uuid: () => "11111111-2222-4333-8444-555555555555" }) };
}

test("typed client never sends a generic verb, actor, tenant, or state", async () => {
  const { calls, client } = harness([
    { status: 200, body: { actor: { slug: "joe" }, csrf_token: "csrf", reauth_required: false } },
    { status: 200, body: { ok: true, data: { human_ref: "WR-000123" } } },
  ]);
  await client.bootstrap();
  await client.report({ situation: "Worker recovery", title: "Recovery receipt",
    desired_outcome: "Read it back", acceptance_criteria: [{ id: "criterion-1", text: "Receipt exists" }] });
  assert.equal(calls[1].path, "/api/system-work/report");
  assert.equal(calls[1].init.headers["x-carr-csrf"], "csrf");
  assert.deepEqual(Object.keys(calls[1].body).sort(),
    ["acceptance_criteria", "desired_outcome", "idempotency_key", "situation", "title"].sort());
  assert.equal(/verb|actor|tenant|state|command|sql/.test(JSON.stringify(calls[1].body)), false);
});

test("current collection uses the fixed read route with no caller-selected filter", async () => {
  const { calls, client } = harness([{ status: 200, body: { actor: { slug: "joe" }, csrf_token: "csrf" } }, { status: 200, body: { ok: true, data: { items: [] } } }]);
  await client.bootstrap();
  assert.deepEqual(await client.current(), { items: [] });
  assert.equal(calls[1].init.signal.aborted, false);
  const { signal, ...readInit } = calls[1].init;
  assert.deepEqual({ ...calls[1], init: readInit }, { path: "/api/system-work/current", init: { credentials: "same-origin", headers: { accept: "application/json" } }, body: null });
});

test("approval obtains a one-time challenge bound to the exact material", async () => {
  const { calls, client } = harness([
    { status: 200, body: { actor: { slug: "dell" }, csrf_token: "csrf", reauth_required: false } },
    { status: 200, body: { challenge: "challenge-1", expires_at: "2026-08-16T12:05:00Z" } },
    { status: 200, body: { ok: true, data: { state: "ready" } } },
  ]);
  await client.bootstrap();
  await client.acceptPlan("WR-000123", { base_version: 2, plan_hash: `sha256:${"a".repeat(64)}` });
  assert.deepEqual(calls[1].body, { action: "accept-ready-plan", human_ref: "WR-000123",
    base_version: 2, idempotency_key: "11111111-2222-4333-8444-555555555555",
    plan_hash: `sha256:${"a".repeat(64)}` });
  assert.equal(calls[2].path, "/api/system-work/WR-000123/plan/accept");
  assert.equal(calls[2].init.headers["x-carr-action-challenge"], "challenge-1");
  assert.equal(calls[2].body.idempotency_key, "11111111-2222-4333-8444-555555555555");
});

test("version conflict is a typed refusal and is never retried", async () => {
  const { calls, client } = harness([
    { status: 200, body: { actor: { slug: "joe" }, csrf_token: "csrf" } },
    { status: 409, body: { error: "version_conflict", message: "This request changed. No change was made." } },
  ]);
  await client.bootstrap();
  await assert.rejects(() => client.triage("WR-000123", { base_version: 1, classification: "operational" }),
    (error) => error.status === 409 && error.code === "version_conflict");
  assert.equal(calls.length, 2);
});

test('S2 plan replay retains the original key, body and version after a committed response is lost', async () => {
  const calls = [], receipts = new Map(); let keys = 0, lost = true, commits = 0;
  const client = createSystemWorkClient({ uuid: () => `key-${++keys}`, fetchImpl: async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (path.endsWith('/session')) return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session-a' });
    calls.push({ path, body });
    if (!receipts.has(body.idempotency_key)) { commits++; receipts.set(body.idempotency_key, { ok: true, plan_hash: 'synthetic-receipt' }); }
    if (lost) { lost = false; throw new Error('response lost after commit'); }
    return Response.json({ data: receipts.get(body.idempotency_key) });
  }});
  await client.bootstrap();
  const args = { base_version: 2, scope_summary: 'Original bounded scope' };
  await assert.rejects(client.preparePlan('WR-000123', args), /response lost/);
  assert.equal(client.pendingAction('WR-000123').request.base_version, 2);
  await assert.rejects(client.preparePlan('WR-000123', { ...args, scope_summary: 'Replacement' }), /earlier|previous|unconfirmed|unresolved/i);
  assert.equal(calls.length, 1);
  await client.preparePlan('WR-000123', args);
  assert.deepEqual(calls[1], calls[0]); assert.equal(commits, 1); assert.equal(keys, 1);
  assert.equal(client.pendingAction('WR-000123'), null);
});

test('S2 a definitive conflict releases the refused operation for a newly reviewed version', async () => {
  const bodies = []; let keys = 0;
  const client = createSystemWorkClient({ uuid: () => `key-${++keys}`, fetchImpl: async (path, init = {}) => {
    if (path.endsWith('/session')) return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session-a' });
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? Response.json({ error: 'version_conflict' }, { status: 409 }) : Response.json({ data: { ok: true } });
  }});
  await client.bootstrap();
  await assert.rejects(client.triage('WR-000123', { base_version: 1, classification: 'operational' }), error => error.status === 409);
  await client.triage('WR-000123', { base_version: 2, classification: 'needs_judgment' });
  assert.notEqual(bodies[1].idempotency_key, bodies[0].idempotency_key); assert.equal(bodies[1].base_version, 2);
});

test('S2 a retained Work Request operation cannot move to a new authenticated session', async () => {
  let csrf = 'synthetic-session-a', writes = 0;
  const client = createSystemWorkClient({ fetchImpl: async (path) => {
    if (path.endsWith('/session')) return Response.json({ actor: { slug: 'joe' }, csrf_token: csrf });
    writes++; throw new Error('response lost');
  }});
  await client.bootstrap(); const args = { base_version: 2, scope_summary: 'Original scope' };
  await assert.rejects(client.preparePlan('WR-000123', args));
  csrf = 'synthetic-session-b'; await client.bootstrap();
  await assert.rejects(client.preparePlan('WR-000123', args), /session|scope/i);
  assert.equal(writes, 1);
});

test('S2 the write deadline retains a committed Work Request operation for receipt replay',async()=>{
 const sent=[],receipts=new Map();let first=true;
 const client=createSystemWorkClient({writeTimeoutMs:5,fetchImpl:async(path,init={})=>{
  if(path.endsWith('/session'))return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session-a'});
  const body=JSON.parse(init.body);sent.push(body);
  if(!receipts.has(body.idempotency_key))receipts.set(body.idempotency_key,{ok:true,plan_hash:'synthetic-plan'});
  if(first){first=false;return new Promise(()=>{});}return Response.json({data:receipts.get(body.idempotency_key)});
 }});
 await client.bootstrap();const args={base_version:1,scope_summary:'Bounded read'};
 await assert.rejects(client.preparePlan('WR-000123',args),/timed out/i);
 await client.preparePlan('WR-000123',args);
 assert.deepEqual(sent[1],sent[0]);assert.equal(receipts.size,1);
});

for(const reply of [{},{data:{}},null])test(`S2 malformed Work Request success ${JSON.stringify(reply)} keeps the original operation`,async()=>{
 let malformed=true;const sent=[];
 const client=createSystemWorkClient({fetchImpl:async(path,init={})=>{
  if(path.endsWith('/session'))return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session-a'});
  sent.push(JSON.parse(init.body));return Response.json(malformed?reply:{ok:true,data:{ok:true,plan_hash:'synthetic-plan'}});
 }});
 await client.bootstrap();const args={base_version:1,scope_summary:'Original scope'};
 await assert.rejects(client.preparePlan('WR-000123',args),/unknown|receipt/i);
 malformed=false;await client.preparePlan('WR-000123',args);assert.deepEqual(sent[1],sent[0]);
});
