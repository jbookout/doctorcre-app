import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../'+path,import.meta.url),'utf8'));
const ui = await import('data:text/javascript;base64,'+bundle.toString('base64'));
const deal = '11111111-1111-4111-8111-111111111111';
const settle = () => new Promise(resolve => setTimeout(resolve,30));
test('proposal_card_changes_nothing_until_accept', async () => {
  const dom = new JSDOM('<div id="view"></div>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const fixture = ui.createTourProposalFixture(deal);
  const root = document.querySelector('#view');
  const panel = ui.mountDealTourProposals(root,{dealId:deal,client:fixture.client});
  await settle();
  root.querySelector('[data-compare]').click();
  root.querySelector('[data-use-theirs]').click();
  assert.equal(fixture.writes.length,0);
  assert.equal(fixture.shortlist().length,2);
  root.querySelector('[data-accept-proposal]').click(); await settle();
  assert.equal(fixture.writes.length,1);
  assert.deepEqual(fixture.shortlist(),fixture.theirs);
  assert.match(root.textContent,/Shortlist confirmed/);
  panel.dispose();
});
function open(overrides={}) {
  const dom=new JSDOM('<div id="view"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;
  const fixture=ui.createTourProposalFixture(deal), root=document.querySelector('#view'), counts=[];
  const client={...fixture.client,...overrides};
  const panel=ui.mountDealTourProposals(root,{dealId:deal,client,onPending:n=>counts.push(n)});
  const click=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text)?.click();
  return {dom,fixture,root,panel,counts,click};
}
test('differences use canonical IDs, exclude another deal, and Keep mine only dismisses on Accept',async()=>{
  const f=open();await settle();f.click('Compare shortlist');
  const text=f.root.textContent;
  for(const label of ['Added','Removed','Unchanged','Demo addition','Demo removal','Demo unchanged']) assert.match(text,new RegExp(label));
  f.root.querySelector('[data-keep-mine]').click();assert.equal(f.fixture.writes.length,0);
  f.root.querySelector('[data-accept-proposal]').click();await settle();
  assert.equal(f.fixture.writes.length,1);assert.deepEqual(f.fixture.shortlist(),['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  assert.equal(f.counts.at(-1),0);assert.match(f.root.textContent,/Your shortlist kept/);f.panel.dispose();
  const foreign=ui.createTourProposalFixture('22222222-2222-4222-8222-222222222222');
  const next=open({list:foreign.client.list});await settle();assert.equal(next.root.querySelector('[data-compare]'),null);next.panel.dispose();
});
test('per-property choices send one resolution with proposal identity, cart version and a key',async()=>{
  const f=open();await settle();f.click('Compare shortlist');
  f.root.querySelector('input').click();
  assert.equal(f.fixture.writes.length,0);
  f.root.querySelector('[data-accept-proposal]').click();await settle();
  const write=f.fixture.writes[0];assert.equal(write.mode,'per_property');assert.equal(write.proposal_id,f.fixture.proposal.id);
  assert.equal(write.expected_selection_version_id,f.fixture.proposal.expected_selection_version_id);assert.match(write.idempotency_key,/^[0-9a-f-]{36}$/);
  assert.ok(f.fixture.shortlist().includes(f.fixture.theirs[0]));assert.equal(f.counts.at(-1),0);f.panel.dispose();
});
test('stale refuses, retains choices and refreshes comparison before a new accept',async()=>{
  let calls=0;
  const f=open({resolve:async()=>{++calls;throw Object.assign(Error('conflict'),{code:'proposal_shortlist_conflict'});}});
  await settle();f.click('Compare shortlist');f.root.querySelector('[data-use-theirs]').click();
  f.root.querySelector('[data-accept-proposal]').click();await settle();
  assert.match(f.root.textContent,/Your shortlist changed/);assert.equal(f.root.querySelector('input').checked,true);
  assert.equal(f.root.querySelector('[data-accept-proposal]'),null);f.click('Refresh comparison');await settle();
  assert.equal(f.root.querySelector('input').checked,true);assert.ok(f.root.querySelector('[data-accept-proposal]'));assert.equal(calls,1);f.panel.dispose();
});
test('uncertain write replays identical key; readback failure retries only readback',async()=>{
  let calls=0,readbacks=0;
  const original=ui.createTourProposalFixture(deal), requests=[];
  const f=open({list:original.client.list,labels:original.client.labels,resolve:async request=>{requests.push(structuredClone(request));if(++calls===1) throw Error('network');return original.client.resolve(request);},shortlist:async id=>{if(++readbacks===1) throw Error('unavailable');return original.client.shortlist(id);}});
  await settle();f.click('Compare shortlist');f.root.querySelector('[data-use-theirs]').click();f.root.querySelector('[data-accept-proposal]').click();await settle();
  f.click('Retry same decision');await settle();assert.deepEqual(requests[0],requests[1]);assert.equal(calls,2);
  assert.match(f.root.textContent,/readback is unavailable/);f.click('Check shortlist');await settle();assert.equal(calls,2);assert.match(f.root.textContent,/Shortlist confirmed/);f.panel.dispose();
});
test('unknown_tool hides, empty hides and unavailable is honest',async()=>{
  for(const [client,expected] of [[{list:async()=>{throw Object.assign(Error('missing'),{code:'unknown_tool'});}},''],[{list:async()=>({proposals:[],pending_count:0})},''],[{list:async()=>{throw Error('private SQL diagnostic');}},'Client proposals unavailable.']]) {
    const f=open(client);await settle();assert.ok(f.root.textContent.startsWith(expected));assert.doesNotMatch(f.root.textContent,/private SQL/);assert.equal(f.root.querySelector('[data-compare]'),null);f.panel.dispose();
  }
});
test('session invalidation and disposal fence late responses',async()=>{
  let finish;
  const f=open({list:()=>new Promise(resolve=>{finish=resolve;})});
  f.dom.window.dispatchEvent(new f.dom.window.Event('doctorcre-session-invalidated'));
  finish({proposals:[f.fixture.proposal],pending_count:1});await settle();assert.equal(f.root.textContent,'');f.panel.dispose();
});
test('adapter breaker bounds failures, cools down and never pulls portal or writes routes',async()=>{
  let time=0,calls=0;
  const client=ui.createTourProposalClient({now:()=>time,rpc:async()=>{++calls;throw Error('offline');},tour:async()=>null});
  await assert.rejects(client.list(deal));await assert.rejects(client.list(deal));await assert.rejects(client.list(deal),/circuit_open/);assert.equal(calls,2);
  time=60000;await assert.rejects(client.list(deal));assert.equal(calls,3);
});
test('adapter rejects malformed contract and oversized reads',async()=>{
  for(const data of [{proposals:new Array(51).fill({}),pending_count:51},{proposals:[{id:'not a UUID'}],pending_count:1}]) {
    const client=ui.createTourProposalClient({rpc:async()=>({ok:true,schema_version:'client-tour-proposals.v1',...data}),tour:async()=>null});
    await assert.rejects(client.list(deal));
  }
});
test('removed and unavailable labels remain identifiable; route appointments never enter resolutions',async()=>{
  const f=open({labels:async()=>({})});await settle();f.click('Compare shortlist');
  assert.match(f.root.textContent,/Property label unavailable/);assert.match(f.root.textContent,/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  f.root.querySelector('[data-use-theirs]').click();f.root.querySelector('[data-accept-proposal]').click();await settle();
  assert.deepEqual(Object.keys(f.fixture.writes[0]).sort(),['deal_id','expected_selection_version_id','idempotency_key','mode','proposal_id']);f.panel.dispose();
});
test('unknown producer returns no proposal card through the typed adapter',async()=>{
  const client=ui.createTourProposalClient({rpc:async()=>({error:'unknown_tool'}),tour:async()=>{throw Error('must not hydrate');}});
  const f=open(client);await settle();assert.equal(f.root.textContent,'');assert.equal(f.fixture.writes.length,0);f.panel.dispose();
});
