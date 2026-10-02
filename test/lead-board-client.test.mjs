import test from "node:test";
import assert from "node:assert/strict";
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

test("moveLeadStage submits exact versioned stage-only update and does not retry conflicts", async () => {
  const calls = [];
  const client = createLeadBoardClient({ uuid: () => "test-key", fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "version_conflict", message: "Changed elsewhere." }) }] } });
  } });
  await assert.rejects(client.moveLeadStage({ id: "lead-1", registry_ref: "L-100", base_version: 7 }, "contacted"), (error) => {
    assert.equal(error.code, "version_conflict");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body).params, {
    name: "update-lead",
    arguments: { lead: "L-100", base_version: 7, fields: { stage: "contacted" }, idempotency_key: "test-key" },
  });
});

test("Claim Card reads five ranked candidates and sends explicit versioned decisions", async () => {
  const calls = [];
  const client = createLeadBoardClient({ fetchImpl: async (_path, init) => {
    const params = JSON.parse(init.body).params;
    calls.push(params);
    return jsonResponse({ result: { content: [{ type: "text", text: JSON.stringify(params.name === "claim-card" ? { claimable: 2, candidates: [] } : { ok: true }) }] } });
  } });
  const card = await client.getClaimCard();
  assert.equal(card.claimable, 2);
  const candidate = { pool_id: "synthetic-pool", base_version: 4 };
  const evidence = { sources: [{ url: "https://example.test/source", observed_at: "2026-09-27T00:00:00Z" }], field_evidence: { name: [0], company: [0], phone: [0], specialty: [0], market: [0] }, discrepancies: [] };
  await client.promoteCandidate(candidate, evidence, "fixed-claim-key");
  await client.declineCandidate(candidate, "Outside our territory", "fixed-decline-key");
  assert.deepEqual(calls, [
    { name: "claim-card", arguments: { limit: 5 } },
    { name: "promote-pool", arguments: { pool_id: "synthetic-pool", base_version: 4, stage: "outreach_active", research_evidence: evidence, idempotency_key: "fixed-claim-key" } },
    { name: "decline-candidate", arguments: { pool_id: "synthetic-pool", base_version: 4, reason: "Outside our territory", idempotency_key: "fixed-decline-key" } },
  ]);
});

test("uncertain decision result can be retried with the same key and exact payload", async () => {
  const calls = [];
  const client = createLeadBoardClient({ fetchImpl: async (_path, init) => {
    calls.push(JSON.parse(init.body).params);
    if (calls.length === 1) throw new Error("connection lost");
    return jsonResponse({ result: { content: [{ type: "text", text: '{"ok":true}' }] } });
  } });
  const candidate = { pool_id: "synthetic-pool", base_version: 4 };
  await assert.rejects(client.declineCandidate(candidate, "Not a fit", "same-key"), { code: "unknown_outcome" });
  await client.declineCandidate(candidate, "Not a fit", "same-key");
  assert.deepEqual(calls[0], calls[1]);
});

test("mutation treats malformed or missing MCP envelopes and HTTP 503 as unknown outcomes", async () => {
  const candidate = { pool_id: "synthetic-pool", base_version: 4 };
  for (const response of [
    { ok: true, status: 200, json: async () => { throw new Error("broken JSON"); } },
    jsonResponse({ jsonrpc: "2.0", id: 1 }),
    jsonResponse({ error: "carr_unavailable" }, false, 503),
    jsonResponse({ result: { content: [null] } }),
    jsonResponse({ result: { content: { find: 1 } } }),
  ]) {
    const client = createLeadBoardClient({ fetchImpl: async () => response });
    await assert.rejects(client.declineCandidate(candidate, "Not a fit", "same-key"), { code: "unknown_outcome" });
  }
});

test("mutation requires explicit success and keeps authoritative business refusal distinct", async () => {
  const candidate = { pool_id: "synthetic-pool", base_version: 4 };
  const missingSuccess = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ result: { content: [{ type: "text", text: "{}" }] } }) });
  await assert.rejects(missingSuccess.declineCandidate(candidate, "Not a fit", "same-key"), { code: "unknown_outcome" });
  const refusal = createLeadBoardClient({ fetchImpl: async () => jsonResponse({ result: { isError: true, content: [{ type: "text", text: '{"error":"version_conflict"}' }] } }) });
  await assert.rejects(refusal.declineCandidate(candidate, "Not a fit", "same-key"), { code: "version_conflict" });
});

test("synthetic promotion moves one candidate onto the refreshed Lead Board; refusal changes neither", async () => {
  let candidate = { pool_id: "synthetic-pool", base_version: 2 };
  const leads = [];
  const seen = new Map();
  const client = createLeadBoardClient({ fetchImpl: async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === "claim-card") result = { claimable: Number(Boolean(candidate)), needs_contact_count: 0, candidates: candidate ? [candidate] : [] };
    if (name === "lead-board") result = { generated_at: "2026-09-27T12:00:00Z", stages: [], leads };
    if (name === "promote-pool") {
      if (args.base_version !== candidate?.base_version) result = { error: "version_conflict" };
      else if (seen.has(args.idempotency_key)) result = seen.get(args.idempotency_key);
      else { candidate = null; leads.push({ registry_ref: "L-SYNTHETIC", stage: args.stage }); result = { ok: true, ref: "L-SYNTHETIC" }; seen.set(args.idempotency_key, result); }
    }
    return jsonResponse({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
  } });
  const before = await client.getClaimCard();
  await assert.rejects(client.promoteCandidate({ ...candidate, base_version: 1 }, {}, "stale"), { code: "version_conflict" });
  assert.equal((await client.getClaimCard()).claimable, before.claimable);
  assert.equal((await client.getLeadBoard()).leads.length, 0);
  const evidence = { sources: [{ url: "https://example.test/source", observed_at: "2026-09-27T12:00:00Z" }], field_evidence: { name: [0], company: [0], phone: [0], specialty: [0], market: [0] }, discrepancies: [] };
  await client.promoteCandidate(candidate, evidence, "claim-once");
  assert.equal((await client.getClaimCard()).claimable, 0);
  assert.equal((await client.getLeadBoard()).leads[0].registry_ref, "L-SYNTHETIC");
});

test('Leads workspace transports exact reviewed stage, undo, claim and link intents without outward effects',async()=>{
 const calls=[];const client=createLeadBoardClient({fetchImpl:async(path,init)=>{calls.push({path,body:JSON.parse(init.body)});return jsonResponse({result:{content:[{type:"text",text:JSON.stringify({ok:true})}]}})}});
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
