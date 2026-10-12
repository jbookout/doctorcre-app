import test from "node:test";
import assert from "node:assert/strict";
import {workspace,detail} from "./leads-workspace-fixture.mjs";
import { createLeadBoardClient } from "../js/leads-client.js";

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("getLeadBoard uses same-origin cookie-authenticated MCP JSON-RPC", async () => {
  const calls = [];
  const client = createLeadBoardClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ generated_at: "2026-08-24T12:00:00Z", stages: [], leads: [] }) }] } });
  } });
  const board = await client.getLeadBoard();
  assert.equal(board.leads.length, 0);
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead-board", arguments: {} },
  });
});

test("getActor reads server-derived identity and refuses a missing actor", async () => {
  const calls = [];
  const client = createLeadBoardClient({ fetchImpl: async (_path, init) => {
    calls.push(JSON.parse(init.body).params);
    return jsonResponse({ result: { content: [{ type: "text", text: JSON.stringify({ actor: "joe" }) }] } });
  } });
  assert.equal(await client.getActor(), "joe");
  assert.deepEqual(calls, [{ name: "deal-room-board", arguments: { workspace: "team" } }]);
  const missing = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ result: { content: [{ type: "text", text: "{}" }] } }) });
  assert.equal(await missing.getActor(), null);
});

test("typed tool errors preserve code and payload", async () => {
  const client = createLeadBoardClient({ fetchImpl: async () => jsonResponse({
    jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not_authenticated", message: "Sign in required." }) }] },
  }) });
  await assert.rejects(client.getLeadBoard(), (error) => {
    assert.equal(error.code, "not_authenticated");
    assert.equal(error.payload.message, "Sign in required.");
    return true;
  });
});

test("uncertain decision result can be retried with the same key and exact payload", async () => {
  const calls = [];
  const client = createLeadBoardClient({ fetchImpl: async (_path, init) => {
    calls.push(JSON.parse(init.body).params);
    if (calls.length === 1) throw new Error("connection lost");
    return jsonResponse({ result: { content: [{ type: "text", text: '{"ok":true}' }] } });
  } });
  const candidate = { id: "synthetic-lead", base_version: 4 };
  await assert.rejects(client.claimLead(candidate, "same-key", "example-partner"), { code: "unknown_outcome" });
  await client.claimLead(candidate, "same-key", "example-partner");
  assert.deepEqual(calls[0], calls[1]);
});

test("mutation requires explicit success and keeps authoritative business refusal distinct", async () => {
  const candidate = { id: "synthetic-lead", base_version: 4 };
  const missingSuccess = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ result: { content: [{ type: "text", text: "{}" }] } }) });
  await assert.rejects(missingSuccess.claimLead(candidate, "same-key", "example-partner"), { code: "unknown_outcome" });
  const refusal = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ result: { isError: true, content: [{ type: "text", text: '{"error":"version_conflict"}' }] } }) });
  await assert.rejects(refusal.claimLead(candidate, "same-key", "example-partner"), { code: "version_conflict" });
});

test('Leads workspace transports exact reviewed stage, undo, claim and link intents without outward effects',async()=>{
 const calls=[];const client=createLeadBoardClient({fetchImpl:async(path,init)=>{calls.push({path,body:JSON.parse(init.body)});return jsonResponse({result:{content:[{type:"text",text:JSON.stringify(JSON.parse(init.body).params.name==='lead-board'?{...workspace(),detail:detail(workspace().leads[0])}:{ok:true})}]}})}});
 const lead={id:'30000000-0000-0000-0000-000000000001',registry_ref:'L-1',base_version:3};
 await client.getWorkspace();await client.getLeadDetail(lead);
 const review={reason:'Undo automatic stage move',evidence_ids:[],undo_event_id:'synthetic-event'};await client.recordStage(lead,'new',review,'same-key','example-partner');await client.claimLead(lead,'claim-key','example-partner');await client.linkClient(lead,'30000000-0000-0000-0000-000000000002','link-key','example-partner');
 assert.deepEqual(calls.map(c=>c.body.params.name),['lead-board','lead-board','update-lead','claim-lead','link-lead-client']);assert.deepEqual(calls[2].body.params.arguments.stage_review,review);assert.equal(calls[2].body.params.arguments.idempotency_key,'same-key');assert.equal(calls[4].body.params.arguments.confirmed,true);assert.ok(calls.slice(2).every(c=>c.body.params.arguments.expected_actor==='example-partner'));assert.ok(calls.every(c=>c.path==='/mcp'));
});
test('Leads read and mutation deadlines stop indefinite loading and classify mutation as unknown',async()=>{
 const c=createLeadBoardClient({timeoutMs:15,fetchImpl:()=>new Promise(()=>{})});
 await assert.rejects(()=>c.getWorkspace(),e=>e.code==='read_timeout');
 await assert.rejects(()=>c.claimLead({id:'synthetic-lead',base_version:1},'same-key'),e=>e.code==='unknown_outcome');
});

test('Home cancellation aborts the bounded lead transport and preserves HTTP status', async () => {
  let transportSignal;
  const client = createLeadBoardClient({ fetchImpl: (_path, init) => {
    transportSignal = init.signal;
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const pending = client.getLeadBoard({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'read_timeout' });
  assert.equal(transportSignal.aborted, true);
  const refused = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ error: { code: 'not_authenticated' } }, false, 401) });
  await assert.rejects(refused.getLeadBoard(), error => error.code === 'not_authenticated' && error.status === 401);
});

test('blocking 13: shared workspace reads reject invalid consumed projections and recover on valid data',async()=>{
 const {workspace,detail}=await import('./leads-workspace-fixture.mjs');let payload=workspace();
 const c=createLeadBoardClient({fetchImpl:async()=>jsonResponse({result:{content:[{type:'text',text:JSON.stringify(payload)}]}})});
 for(const invalid of [{schema_version:'lead-workspace.v1',leads:[null]},{...workspace(),leads:[{id:'partial'}]}]){payload=invalid;await assert.rejects(c.getWorkspace(),{code:'invalid_projection'})}
 payload=workspace();assert.equal((await c.getWorkspace()).leads.length,payload.leads.length);
 for(const invalid of [{id:payload.leads[0].id},{...detail(payload.leads[0]),correspondence:[null]}]){payload={schema_version:'lead-workspace.v1',detail:invalid};await assert.rejects(c.getLeadDetail({id:invalid.id}),{code:'invalid_projection'})}
});

test('blocking 2: HTTP authorization headers reject reads and writes before a stalled body', async () => {
  for (const status of [401, 403]) {
    let bodyReads = 0;
    const client = createLeadBoardClient({ timeoutMs: 20, fetchImpl: async () => ({
      ok: false, status, json: () => { bodyReads++; return new Promise(() => {}); },
    }) });
    for (const request of [() => client.getActor(), () => client.getWorkspace(),
      () => client.getLeadDetail({ id: 'synthetic-lead' }),
      () => client.claimLead({ id: 'synthetic-lead', base_version: 1 }, 'same-key', 'example-partner')]) {
      await assert.rejects(request, { code: status === 401 ? 'not_authenticated' : 'forbidden', status });
    }
    assert.equal(bodyReads, 0);
  }
});
