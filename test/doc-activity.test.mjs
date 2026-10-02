import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFilters, activityRows, undoArgs } from '../js/doc-activity-model.js';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';
import { createLiveClient } from '../js/live-client.js';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocDock } from '../js/doc-dock.js';

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

test('Doc popup exposes one activity destination when mounted repeatedly', t => {
  const dom = new JSDOM('<button id="docFab"></button><section id="docChat" hidden><header class="doc-chat-head"></header></section>');
  const priorDocument = globalThis.document, priorElement = globalThis.HTMLElement;
  globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
  t.after(() => { globalThis.document = priorDocument; globalThis.HTMLElement = priorElement; dom.window.close(); });
  mountDocDock('Demo workspace');
  dom.window.document.getElementById('docFab').click();
  mountDocDock('Demo workspace');
  const links = dom.window.document.querySelectorAll('[data-doc-activity-link]');
  assert.equal(links.length, 1); assert.equal(links[0].getAttribute('href'), '/doc-activity');
  assert.equal(dom.window.document.getElementById('docChat').hidden, false);
});
