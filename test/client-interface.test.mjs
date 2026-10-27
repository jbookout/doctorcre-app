import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";
import { confirmedEngagementRefusal, engagementWriterFor } from "../js/prospect-engagement.mjs";

const required = ["setProspectEngagementStatus", "getInvoiceTracker", "markInvoicePaid", "getBoard", "getDeal", "getJevDealReading", "getChanges", "presenceLease", "patchDealField", "resolveConflict", "addDealNote", "setNextStep", "addCriticalDate", "createDeal", "loopBoard", "todayTriage", "readLoop", "addLoop", "updateLoop", "closeLoop", "loopHeaders", "listIndustryEvents", "addIndustryEvent", "updateIndustryEvent", "commandCenter", "engineeringPassport", "readPortfolio", "workRequestCard", "declineWorkRequest", "supersedeWorkRequest", "setWorkShapeDisposition", "incidentBoard", "currentWorkItem", "currentWorkRequests", "governanceQueue", "getIncident", "linkIncidentWorkRequest", "notificationFeed", "acknowledgeNotification", "notificationPreferences", "setNotificationPreference", "readDocConversation", "listDocConversations", "createDocConversation", "renameDocConversation", "shareDocConversation", "docOutcomeCards"];

test('live board, archived rows and detail preserve explicit vendor cards', async () => {
  const vendors = [{ party_id: 'demo-vendor', role: 'attorney', company: { id: 'demo-company', name: 'Demo Legal' },
    contact: { id: 'demo-contact', name: 'Demo Contact', email: null, phone: null }, note: null, updated_at: '2026-10-01T12:00:00Z' }];
  const row = { id: 'demo-deal', name: 'Demo Deal', phase: 'legal', vendors };
  const client = createLiveClient({ fetchImpl: async (_path, init) => {
    const verb = JSON.parse(init.body).params.name;
    const payload = verb === 'deal-room-board' ? { deals: [row], closed_deals: [row], lost_deals: [row] }
      : { ...row, deal_id: row.id };
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }));
  } });
  const board = await client.getBoard();
  for (const key of ['deals', 'closed_deals', 'lost_deals']) assert.deepEqual(board[key][0].vendors, vendors);
  assert.deepEqual((await client.getDeal(row.id)).deal.vendors, vendors);
});

test("industry events use the authenticated read and versioned writes", async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return new Response(JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' }));
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

test("the live client sends today-triage through the pinned MCP seam, and the fixture derives it from its own records", async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ items: [] }) }] } }), { status: 200 });
  } });
  assert.deepEqual(await live.todayTriage(), { items: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].body.params.name, "today-triage");
  assert.deepEqual(calls[0].body.params.arguments, {}, "the verb takes no arguments, so none are sent");

  const fixtureText = await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8");
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}` });
  const deal = (await fixture.getBoard()).deals[0];
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await fixture.addCriticalDate({ deal: deal.id, kind: "lease_expiration", due_on: inTwoDays, source: "Demo lease abstract", idempotency_key: "11111111-1111-4111-8111-111111111111" });
  const { items } = await fixture.todayTriage();
  const added = items.find((item) => item.item_kind === "critical_date" && item.subject_id === deal.id);
  assert.ok(added, "a critical date written through the fixture appears in its triage read");
  assert.equal(added.what, "lease_expiration");
  assert.equal(added.subject_name, deal.name);
  assert.ok(items.every((item, i) => i === 0 || items[i - 1].due_on <= item.due_on), "rows arrive earliest first");
  assert.ok(items.every((item) => item.subject_name === null || String(item.subject_name).startsWith("Demo ")), "synthetic names only");
});

test('the synthetic board and detail carry the authoritative phase-date projection', async () => {
  const text=await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8');
  const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(text).toString('base64')}`});
  const board=await fixture.getBoard();
  assert.deepEqual(board.deals.find(d=>d.id==='d14').phase_started_on,{legal:'2026-01-10'});
  assert.deepEqual((await fixture.getDeal('d14')).deal.phase_started_on,{legal:'2026-01-10'});
  assert.deepEqual((await fixture.getDeal('d05')).deal.phase_started_on,{});
});

test('prospect engagement writes require acknowledged success and retain uncertain outcomes',async()=>{
 for(const payload of [{ok:true},{}]) {
  const calls=[];const live=createLiveClient({fetchImpl:async(path,init)=>{calls.push(JSON.parse(init.body).params);return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}}),{status:200})}});
  const args={client_id:'synthetic-client',base_version:7,status:'inactive',reason:'Synthetic deferral',idempotency_key:'synthetic-key'};
  if(payload.ok) await live.setProspectEngagementStatus(args);
  else await assert.rejects(live.setProspectEngagementStatus(args),{code:'unknown_outcome'});
  assert.deepEqual(calls,[{name:'set-prospect-engagement-status',arguments:args}]);
 }
});

for (const failure of ['network','json','http','rpc','tool']) test(`prospect engagement classifies ${failure} as uncertain and permits same-key replay`,async()=>{
 const calls=[];
 const client=createLiveClient({docContext:false,fetchImpl:async(_path,init)=>{
  calls.push(JSON.parse(init.body).params.arguments);
  if(calls.length>1)return new Response(JSON.stringify({result:{content:[{text:'{"ok":true}'}]}}));
  if(failure==='network')throw new TypeError('Synthetic network failure');
  if(failure==='json')return new Response('invalid JSON');
  if(failure==='http')return new Response('Unavailable',{status:503});
  if(failure==='rpc')return new Response(JSON.stringify({error:{message:'Synthetic uncertain error'}}));
  return new Response(JSON.stringify({result:{isError:true,content:[{text:'{"error":"internal_error"}'}]}}));
 }});
 const args={client_id:'synthetic-client',base_version:7,status:'inactive',reason:'Synthetic deferral',idempotency_key:'same-key'};
 await assert.rejects(client.setProspectEngagementStatus(args),{code:'unknown_outcome'});
 await client.setProspectEngagementStatus(args);
 assert.deepEqual(calls,[args,args]);
});

test('fixture engagement preserves deal history, shares client state and replays the same key',async()=>{
 const seed=JSON.parse(await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8'));
 for(const deal of seed.deals.filter(d=>['d14','d20'].includes(d.id)))Object.assign(deal,{client_id:'demo-client',client_status:'prospect',client_version:7,invoiced_on:null});
 const client=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`,docContext:false});
 const before=await client.getDeal('d14');
 const args={client_id:'demo-client',base_version:7,status:'inactive',reason:'Synthetic deferral',expected_actor:'joe',idempotency_key:'synthetic-fixture-inactive'};
 const result=await client.setProspectEngagementStatus(args);
 assert.deepEqual(await client.setProspectEngagementStatus(args),result);
 assert.equal((await client.getBoard()).deals.some(d=>['d14','d20'].includes(d.id)),false);
 const hidden=await client.getDeal('d14');
 assert.equal(hidden.deal.prospect_engagement_status,'inactive');assert.deepEqual(hidden.thread,before.thread);
 assert.deepEqual(hidden.history,before.history);
 await assert.rejects(client.setProspectEngagementStatus({...args,status:'active',idempotency_key:'synthetic-stale'}));
 await client.setProspectEngagementStatus({...args,status:'active',base_version:result.client_version,idempotency_key:'synthetic-fixture-active'});
 const restored=(await client.getBoard()).deals.filter(d=>['d14','d20'].includes(d.id));
 assert.equal(restored.length,2);assert.ok(restored.every(d=>d.client_version===9&&d.prospect_engagement_status==='active'));
});


test('fixture stale-version refusal clears pending engagement and corrected resubmit gets a new key', async () => {
  const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
  Object.assign(seed.deals.find(deal => deal.id === 'd14'), {
    client_id: 'synthetic-prospect', client_status: 'prospect', client_version: 7,
  });
  const client = await createFixtureClient({
    seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`,
    docContext: false,
  });
  const sent = [];
  const send = client.setProspectEngagementStatus.bind(client);
  client.setProspectEngagementStatus = args => { sent.push(args); return send(args); };
  const write = engagementWriterFor(client);
  const args = { client_id: 'synthetic-prospect', base_version: 6, status: 'inactive',
    reason: 'Synthetic deferral', expected_actor: 'joe' };
  let refusal;
  await assert.rejects(write(args), error => { refusal = error; return true; });
  assert.equal(write.get(args.client_id, 'joe'), undefined);
  assert.equal(refusal.payload?.error, 'version_conflict');
  const result = await write({ ...args, base_version: 7 });
  assert.equal(result.ok, true);
  assert.notEqual(sent[1].idempotency_key, sent[0].idempotency_key);
  assert.equal((await client.getDeal('d14')).deal.client_version, 8);
  assert.equal(write.get(args.client_id, 'joe'), undefined);
});


for (const [code, patch, confirmed] of [
  ['not_a_prospect', { client_id: 'missing-prospect' }, true],
  ['invalid_engagement_status', { status: 'invalid' }, true],
  ['invalid_engagement_status', { reason: '' }, true],
  ['account_changed', { expected_actor: 'dell' }, false],
]) {
  test(`fixture engagement ${code} carries the production refusal shape for ${JSON.stringify(patch)}`, async () => {
    const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
    Object.assign(seed.deals.find(deal => deal.id === 'd14'), {
      client_id: 'synthetic-prospect', client_status: 'prospect', client_version: 7,
    });
    const client = await createFixtureClient({
      seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`,
      docContext: false,
    });
    await assert.rejects(client.setProspectEngagementStatus({
      client_id: 'synthetic-prospect', base_version: 7, status: 'inactive',
      reason: 'Synthetic deferral', expected_actor: 'joe', idempotency_key: 'synthetic-refusal', ...patch,
    }), error => {
      assert.equal(error.payload?.error, code);
      assert.equal(confirmedEngagementRefusal(error), confirmed);
      return true;
    });
    assert.equal((await client.getDeal('d14')).deal.client_version, 7);
  });
}

test('concurrent identical page reads share one request and are not cached afterwards', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    await new Promise(resolve => setTimeout(resolve));
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ sponsor: 'joe', n: requests }) }] } }));
  };
  const [first, second] = [createLiveClient({ fetchImpl }), createLiveClient({ fetchImpl })];
  const [a, b] = await Promise.all([first.morningBrief(), second.morningBrief()]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  await first.morningBrief();
  assert.equal(requests, 2);
});

test('a shared page read honours each caller\'s own cancellation', async () => {
  const fetchImpl = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return new Response(JSON.stringify({ result: { content: [{ text: '{"ok":true}' }] } })); };
  const live = createLiveClient({ fetchImpl }), controller = new AbortController();
  const cancelled = live.morningBrief({ signal: controller.signal }), kept = live.morningBrief();
  controller.abort();
  await assert.rejects(cancelled);
  assert.deepEqual(await kept, { ok: true });
});

test('shared reads respect each client deadline', async () => {
  const fetchImpl = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return new Response(JSON.stringify({ result: { content: [{ text: '{"ok":true}' }] } }));
  };
  const short = createLiveClient({ fetchImpl, readTimeoutMs: 10 });
  const long = createLiveClient({ fetchImpl, readTimeoutMs: 200 });
  const first = short.morningBrief();
  const second = long.morningBrief();
  await assert.rejects(first);
  assert.deepEqual(await second, { ok: true });
});

test('an already cancelled shared read does not start a request', async () => {
  let requests = 0;
  const client = createLiveClient({ fetchImpl: async () => { requests++; throw new Error('unexpected request'); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.morningBrief({ signal: controller.signal }));
  assert.equal(requests, 0);
});

test('a cancelled read cannot remove its replacement from sharing', async () => {
  let requests = 0, finish;
  const fetchImpl = async () => {
    requests++;
    await new Promise(resolve => { finish = resolve; });
    return Response.json({ result: { content: [{ text: '{"ok":true}' }] } });
  };
  const client = createLiveClient({ fetchImpl });
  const controller = new AbortController();
  const cancelled = client.morningBrief({ signal: controller.signal });
  controller.abort();
  const replacement = client.morningBrief();
  await assert.rejects(cancelled);
  await new Promise(resolve => setImmediate(resolve));
  const joined = client.morningBrief();
  assert.equal(requests, 2);
  finish();
  assert.deepEqual(await replacement, { ok: true });
  assert.deepEqual(await joined, { ok: true });
});

test('a fresh morning brief does not join an older pending read', async () => {
  let requests = 0, release;
  const fetchImpl = async () => {
    const number = ++requests;
    if (number === 1) await new Promise(resolve => { release = resolve; });
    return Response.json({ result: { content: [{ text: JSON.stringify({ number }) }] } });
  };
  const client = createLiveClient({ fetchImpl });
  const older = client.morningBrief();
  assert.deepEqual(await client.morningBrief({ fresh: true }), { number: 2 });
  release();
  assert.deepEqual(await older, { number: 1 });
});
