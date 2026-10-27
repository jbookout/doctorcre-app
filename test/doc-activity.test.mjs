import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFilters, activityRows, undoArgs } from '../js/doc-activity-model.js';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';
import { createLiveClient } from '../js/live-client.js';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocPresence } from '../js/doc-presence.js';

test('activity filters have inclusive local calendar days and no caller identity', () => {
  const args = activityFilters({ partner:'joe', record_type:'deal', from:'2026-10-01', to:'2026-10-01' });
  assert.equal(args.partner,'joe'); assert.equal(args.record_type,'deal');
  assert.equal(Date.parse(args.until)-Date.parse(args.since),86_400_000);
  assert.equal(new Date(args.since).getHours(),0);
  assert.deepEqual(activityFilters(),{limit:50});
});
test('feed sorting, deduplication, schema refusal and exact undo identity', async () => {
  const fixture = createDocActivityFixture(() => new Date('2026-10-01T15:00:00Z'));
  const answer = await fixture.read(), first = answer.entries[0];
  const rows = activityRows({...answer,entries:[...answer.entries].reverse().concat(first)});
  assert.equal(rows.length,5); assert.equal(rows[0].id,first.id);
  assert.throws(()=>activityRows({...answer,schema_version:'future'}));
  assert.deepEqual(undoArgs(first,'key'),{event_id:first.id,idempotency_key:'key'});
  assert.equal(undoArgs({...first,undo:{...first.undo,event_id:'other'}},'key'),null);
  assert.equal(undoArgs(answer.entries[1],'key'),null);
});
test('fixture filters, keyset pagination and undo replay are in memory only', async () => {
  const fixture = createDocActivityFixture(()=>new Date('2026-10-01T15:00:00Z'));
  const page = await fixture.read({limit:1}); assert.ok(page.next_cursor);
  const next = await fixture.read({limit:1,cursor:page.next_cursor}); assert.notEqual(page.entries[0].id,next.entries[0].id);
  assert.equal((await fixture.read({partner:'dell'})).entries.length,2);
  assert.equal((await fixture.read({record_type:'lead'})).entries.length,1);
  const args = undoArgs(page.entries[0],'demo-key');
  const result = await fixture.undo(args); assert.deepEqual(await fixture.undo(args),result);
  assert.equal((await fixture.read()).entries[0].undo.state,'undone');
});
test('live read uses pinned scoped verb, cancellation and stable undo request', async () => {
  const calls=[]; const client=createLiveClient({fetchImpl:async(path,init)=>{
    calls.push({path,init,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({ok:true})}]}}));
  }});
  await client.readDocActivity({partner:'dell',limit:1});
  await client.revertDealField({event_id:'demo-event',idempotency_key:'demo-key'});
  assert.equal(calls[0].body.params.name,'read-doc-activity');
  assert.deepEqual(calls[0].body.params.arguments,{partner:'dell',limit:1}); assert.ok(calls[0].init.signal);
  assert.equal(calls[1].body.params.name,'revert-deal-field'); assert.equal(calls[1].body.params.arguments.idempotency_key,'demo-key');
  const contract=JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json',import.meta.url)));
  assert.ok(contract.mcp_operations.includes('read-doc-activity'));
});

test('Doc detail exposes one activity destination when mounted repeatedly', t => {
  const dom = new JSDOM('<main id="appMainSlot"></main>');
  const snapshot = { state:'updating', ready:false, page:'home', epoch:0, label:'Home', records:[], observedAt:null };
  const context = { snapshot:() => snapshot, subscribe:() => () => {}, tick() {}, clear() {} };
  const client = { listDocSuggestions:() => new Promise(() => {}) };
  const options = { document:dom.window.document, window:dom.window, context, client };
  const first = mountDocPresence(options), second = mountDocPresence(options);
  t.after(() => { first.dispose(); dom.window.close(); });
  assert.equal(second, null);
  const links = dom.window.document.querySelectorAll('#docDetail [data-doc-activity-link]');
  assert.equal(links.length, 1); assert.equal(links[0].getAttribute('href'), '/doc-activity');
});

test('disposing Doc cancels a pending refresh before its owner replaces the body', async t => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="appMainSlot"></main></body></html>');
  let release, startedResolve, unsubscribed = false;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const answer = new Promise(resolve => { release = resolve; });
  const snapshot = { state:'updating', ready:false, page:'home', epoch:0, label:'Home', records:[], observedAt:null };
  const context = { snapshot:() => snapshot, subscribe:() => () => { unsubscribed = true; }, tick() {}, clear() {} };
  const client = { listDocSuggestions:() => { startedResolve(); return answer; }, listFeatureSwitches:async() => ({}) };
  const presence = mountDocPresence({ document:dom.window.document, window:dom.window, context, client });
  t.after(() => { presence.dispose(); dom.window.close(); });
  dom.window.document.querySelector('#docDetail').showModal = function () { this.open = true; };
  presence.open();
  await started;
  presence.dispose();
  dom.window.document.body.replaceChildren(dom.window.document.createElement('main'));
  release({ ok:true, suggestions:[] });
  await presence.refresh();
  assert.equal(unsubscribed, true);
  assert.equal(dom.window.document.body.querySelector('main')?.id, '');
});

test('malformed or partial feed rows are unavailable rather than verified empty; incompatible inverses cannot execute',async()=>{
  const answer=await createDocActivityFixture().read(),row=answer.entries[0];
  for(const broken of [{...row,id:null},{...row,record:{...row.record,name:null}},{...row,what:null},{...row,before:{}},{...row,undo:null},{...row,evidence:{kind:'entry',summary:[]}}]){
    assert.throws(()=>activityRows({...answer,entries:[broken]}),'a wholly malformed feed must not be empty success');
    assert.throws(()=>activityRows({...answer,entries:[row,broken]}),'a partial feed must not count as complete');
  }
  for(const response of [{...answer,as_of:'bad'},{...answer,next_cursor:{at:'bad',id:row.id}},{...answer,record_types:[null]}])assert.throws(()=>activityRows(response));
  assert.deepEqual(activityRows({...answer,entries:[]}),[]);
  for(const undo of [{...row.undo,verb:'future-verb'},{...row.undo,event_id:'other'}])assert.equal(undoArgs({...row,undo},'key'),null);
});

test('Doc activity registers its route, gate and deployed files alongside the main routes', async () => {
  const { routeContract: contract } = await import('../js/routes.js');
  assert.equal(contract.routes['/doc-activity'], 'activity.html');
  assert.equal(contract.gatePaths['/doc-activity'], '/control-room');
  for (const route of ['/deals', '/leads', '/relationships', '/invoices', '/control-room/progress']) assert.ok(contract.routes[route], `main route survives: ${route}`);
});

test('Doc does not fetch suggestions for a queued context that was superseded before its read', async t => {
  const dom = new JSDOM('<main id="appMainSlot"></main>');
  let snapshot = { state:'updating', ready:false, page:'leads', epoch:0, label:'Leads', records:[], observedAt:null };
  let listener, reads = 0;
  const context = { snapshot:() => snapshot, subscribe(fn) { listener = fn; fn(snapshot); return () => {}; }, tick() {}, clear() {} };
  const client = { listDocSuggestions:async() => { reads++; return {ok:true,suggestions:[]}; }, listFeatureSwitches:async() => ({}) };
  const presence = mountDocPresence({document:dom.window.document,window:dom.window,context,client});
  t.after(() => { presence.dispose(); dom.window.close(); });
  dom.window.document.querySelector('#docDetail').showModal = function () { this.open = true; };
  presence.open();
  await presence.refresh();
  reads = 0;
  snapshot = {...snapshot,ready:true,state:'ready'}; listener(snapshot);
  snapshot = {...snapshot,epoch:1,ready:false,state:'updating'}; listener(snapshot);
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(reads,0);
});

test('activity feed orders precise instants before using descending IDs and preserves source rows', async () => {
  const answer = await createDocActivityFixture().read();
  const row = answer.entries[0];
  const entries = [
    { ...row, id: 'z-old', at: '2026-10-26T12:00:00.000001Z' },
    { ...row, id: 'a-new', at: '2026-10-26T12:00:00.000002Z' },
    { ...row, id: 'b-new', at: '2026-10-26T07:00:00.000002-05:00' },
  ];
  const original = structuredClone(entries);
  assert.deepEqual(activityRows({ ...answer, entries }).map(item => item.id), ['b-new', 'a-new', 'z-old']);
  assert.deepEqual(entries, original);
  assert.throws(() => activityRows({ ...answer, entries: [{ ...row, at: null }] }), /activity_unavailable/);
});
