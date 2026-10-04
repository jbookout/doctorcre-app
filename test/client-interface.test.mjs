import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";

const required = ["getInvoiceTracker", "markInvoicePaid", "getBoard", "getDeal", "getJevDealReading", "getChanges", "presenceLease", "patchDealField", "resolveConflict", "addDealNote", "setNextStep", "addCriticalDate", "createDeal", "loopBoard", "todayTriage", "readLoop", "addLoop", "updateLoop", "closeLoop", "loopHeaders", "listIndustryEvents", "addIndustryEvent", "updateIndustryEvent", "commandCenter", "engineeringPassport", "readPortfolio", "workRequestCard", "declineWorkRequest", "supersedeWorkRequest", "setWorkShapeDisposition", "incidentBoard", "currentWorkItem", "currentWorkRequests", "governanceQueue", "getIncident", "linkIncidentWorkRequest", "notificationFeed", "acknowledgeNotification", "notificationPreferences", "setNotificationPreference", "readDocConversation", "listDocConversations", "createDocConversation", "renameDocConversation", "shareDocConversation", "docOutcomeCards"];

test("industry events use the authenticated read and versioned writes", async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true, events: [], count: 0 }) }] } }), { status: 200 });
  } });
  await live.listIndustryEvents({ limit: 100 });
  await live.addIndustryEvent({ title: "Demo forum", source: "Organizer", idempotency_key: "11111111-1111-4111-8111-111111111111" });
  await live.updateIndustryEvent({ event_id: "22222222-2222-4222-8222-222222222222", base_version: 7,
    title: "Demo forum revised", idempotency_key: "33333333-3333-4333-8333-333333333333" });
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body).params.name),
    ["list-industry-events", "add-industry-event", "update-industry-event"]);
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body).params.arguments), [
    { limit: 100 }, { title: "Demo forum", source: "Organizer", idempotency_key: "11111111-1111-4111-8111-111111111111" },
    { event_id: "22222222-2222-4222-8222-222222222222", base_version: 7,
      title: "Demo forum revised", idempotency_key: "33333333-3333-4333-8333-333333333333" },
  ]);
  assert.ok(calls.every(({ path, init }) => path === "/mcp" && init.credentials === "same-origin"));
});

test("synthetic and live adapters satisfy the same DealRoomClient interface", async () => {
  const fixtureText = await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8");
  const fixture = await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}`});
  const live = createLiveClient({fetchImpl: async () => new Response(JSON.stringify({result:{content:[{text:JSON.stringify({actor:"joe",deals:[]})}]}}), {status:200,headers:{"content-type":"application/json"}})});
  for (const adapter of [fixture, live]) for (const method of required) assert.equal(typeof adapter[method], "function", `${adapter.mode}.${method}`);
  assert.equal(fixture.mode, "fixture");
  assert.equal(live.mode, "live");
  assert.ok((await fixture.getBoard()).deals.every((deal) => deal.name.startsWith("Demo ")));
  assert.deepEqual((await live.getBoard()).deals, []);
});

test("the live adapter uses the pinned MCP seam rather than a database", async () => {
  const calls = [];
  const live = createLiveClient({fetchImpl: async (path, init) => {
    calls.push({path, init});
    return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({actor:"joe",deals:[]})}]}}), {status:200});
  }});
  await live.getBoard();
  assert.equal(calls[0].path, "/mcp");
  assert.equal(JSON.parse(calls[0].init.body).params.name, "deal-room-board");
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("Jev reading sends one deal id to the same-origin CARR API", async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ schema: "carr.jev-deal-reading.v1", judged: false,
      reason: "insufficient_recorded_evidence" }), { status: 200 });
  } });
  const answer = await live.getJevDealReading("00000000-0000-4000-8000-000000000001");
  assert.equal(answer.reason, "insufficient_recorded_evidence");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/v1/jev-deal-reading");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].init.body), { deal: "00000000-0000-4000-8000-000000000001" });
});

for(const method of ['engineeringPassport','workRequestCard','sessionIdentity','dispatchHistory'])test(`${method} bounds the response body and aborts on expiry`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const live=createLiveClient({fetchImpl:async(_path,init)=>{signal=init.signal;return {ok:true,json:()=>new Promise(()=>{})};}});
  const read=live[method]({});const rejected=assert.rejects(read,error=>error.code==='read_timeout');
  await Promise.resolve();t.mock.timers.tick(10001);await rejected;
  assert.equal(signal.aborted,true);
});

for (const method of ['engineeringPassport', 'workRequestCard', 'sessionIdentity', 'dispatchHistory', 'unfinishedWork', 'listProgressBoards', 'readProgressBoard']) test(`${method} uses the shared read deadline and caller cancellation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const live = createLiveClient({ readTimeoutMs: 25, fetchImpl: async (_path, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const pending = live[method]({}, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === 'read_timeout');
  controller.abort();
  assert.equal(signal.aborted, true, 'caller cancellation reaches the transport');
  await rejected;
  const expired = assert.rejects(live[method]({}), error => error.code === 'read_timeout');
  t.mock.timers.tick(26);
  await expired;
  assert.equal(signal.aborted, true, 'configured deadline cancels the transport');
});

test('confirmed authentication denial survives a stalled error body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const live=createLiveClient({fetchImpl:async()=>({ok:false,status:401,text:()=>new Promise(()=>{})})});
  const read=live.engineeringPassport({});const rejected=assert.rejects(read,error=>error.status===401);
  await Promise.resolve();t.mock.timers.tick(10001);await rejected;
});
