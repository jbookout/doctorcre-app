import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import {mountLeadsWorkspace} from '../js/leads-workspace-app.js';import {workspace,detail,id} from './leads-workspace-fixture.mjs';
import {createLeadBoardClient} from '../js/leads-client.js';
const tick=()=>new Promise(r=>setTimeout(r,10));
async function setup(overrides={},mapFactory=async()=>({update(){},dispose(){}})){
 const dom=new JSDOM(await readFile(new URL('../leads.html',import.meta.url),'utf8'),{url:'https://example.test/leads',pretendToBeVisual:true});const w=dom.window,d=w.document;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){if(this.open){this.open=false;this.dispatchEvent(new w.Event('close'))}};
 let board=workspace(),actor='example-partner',writes=[];
 const client={getActor:async()=>actor,getWorkspace:async()=>structuredClone(board),getLeadDetail:async l=>({detail:detail(board.leads.find(x=>x.id===l.id))}),
 recordStage:async(l,stage,review,key)=>{writes.push({l,stage,review,key});let r=board.leads.find(x=>x.id===l.id);r.stage=stage;r.base_version++;r.last_stage_move={idempotency_key:key};return{ok:true}},
 linkClient:async(l,clientId,key)=>{writes.push({l,clientId,key});board.leads.find(x=>x.id===l.id).client_id=clientId;return{ok:true}},
 claimLead:async(l,key)=>{writes.push({l,key});board.leads.find(x=>x.id===l.id).owner=actor;return{ok:true}},...overrides};
 const app=mountLeadsWorkspace(d,client,{mapFactory});await tick();
 return{dom,w,d,app,client,board,writes,setActor:a=>{actor=a},close:()=>{app.dispose();w.close()}};
}
test('territory reveal coalesces repeated activation while filters remain usable',async()=>{
 let ready,calls=0;const updates=[];
 const s=await setup({},()=>{calls++;return new Promise(resolve=>{ready=()=>resolve({update:groups=>updates.push(groups),dispose(){}})})});
 try{
  assert.equal(calls,0);
  const button=s.d.getElementById('showTerritory');button.click();button.click();
  assert.equal(calls,1);
  const select=s.d.getElementById('marketFilter');select.value='Mobile, AL';select.dispatchEvent(new s.w.Event('change'));
  const before=[...s.d.querySelectorAll('#leadBoard .lead-card')].map(node=>node.dataset.leadId);
  ready();await tick();button.click();await s.app.refresh();
  assert.equal(calls,1);assert.equal(select.value,'Mobile, AL');
  assert.deepEqual([...s.d.querySelectorAll('#leadBoard .lead-card')].map(node=>node.dataset.leadId),before);
  assert.ok(updates.length>0);assert.ok(updates.at(-1).every(group=>group.key==='Mobile, AL'));
 }finally{s.close()}
});
test('failed territory reveal keeps the market filters and lead list usable',async()=>{
 const s=await setup({},async()=>{throw new Error('Synthetic map failure')});
 try{
  s.d.getElementById('showTerritory').click();await tick();
  assert.match(s.d.getElementById('territoryMap').textContent,/Map unavailable/);
  const select=s.d.getElementById('marketFilter');select.value='Mobile, AL';select.dispatchEvent(new s.w.Event('change'));
  assert.ok(s.d.querySelectorAll('#leadBoard .lead-card').length>0);
  s.d.querySelector('#mapLeadMembers button').click();await tick();
  assert.equal(s.d.getElementById('leadDetail').open,true);
  assert.match(s.d.querySelector('.lead-location').textContent,/Location not checked/);
 }finally{s.close()}
});
test('territory completion after workspace disposal releases the renderer',async()=>{
 let ready,disposed=0;const s=await setup({},()=>new Promise(resolve=>{ready=()=>resolve({dispose(){disposed++},update(){throw new Error('disposed view updated')}})}));
 try{s.d.getElementById('showTerritory').click();s.app.dispose();ready();await tick();assert.equal(disposed,1)}finally{s.close()}
});
test('a remounted workspace reveals territory without starting the disposed workspace map',async()=>{
 let oldCalls=0,newCalls=0,remounted;
 const s=await setup({},async()=>{oldCalls++;return{update(){},dispose(){}}});
 try{
  s.app.dispose();
  remounted=mountLeadsWorkspace(s.d,s.client,{mapFactory:async()=>{newCalls++;return{update(){},dispose(){}}}});await tick();
  s.d.getElementById('showTerritory').click();await tick();
  assert.equal(oldCalls,0);assert.equal(newCalls,1);
 }finally{remounted?.dispose();s.close()}
});
test('board renders six full columns, five hottest, quiet IDs/scores and timestamps; filter-only archive',async()=>{
 const s=await setup();try{assert.equal(s.d.querySelectorAll('[data-stage]').length,6);assert.equal(s.d.querySelectorAll('.hot-row').length,5);assert.equal(s.d.querySelectorAll('.lead-card').length,14);
 assert.match(s.d.getElementById('searchUpdated').textContent,/Oct 1/);assert.match(s.d.querySelector('.lead-card .lead-market').textContent,/Pensacola, FL/);assert.equal(s.d.querySelector('.lead-card .party-id'),null);assert.match(s.d.querySelector('.stage-column[data-stage="opportunity"]').textContent,/Opportunity/);assert.match(s.d.querySelector('.auto-move').textContent,/Moved by Doc: reply received 10\/1/);
 const select=s.d.getElementById('stageFilter');select.value='archived';select.dispatchEvent(new s.w.Event('change'));assert.equal(s.d.querySelectorAll('[data-stage]').length,0);assert.equal(s.d.querySelectorAll('.lead-card').length,1);
 }finally{s.close()}
});
test('all New leads claimed: the panel names the claimed count and owners, never "No New leads"',async()=>{
 const s=await setup({getWorkspace:async()=>{const b=workspace();for(const l of b.leads)if(l.stage==='new')l.owner='joe';return b}});
 try{assert.equal(s.d.getElementById('hotTitle').textContent,'Top new leads');assert.match(s.d.getElementById('hotSummary').textContent,/All 9 New leads are claimed/);
 assert.equal(s.d.querySelectorAll('.hot-row').length,5);assert.equal(s.d.querySelectorAll('#hotLeads [data-claim]').length,0);assert.equal(s.d.querySelector('.hot-owner').textContent,'Joe');
 assert.doesNotMatch(s.d.querySelector('.top-grid').textContent,/No New leads/);
 }finally{s.close()}
});
test('empty stage columns say so in words',async()=>{
 const s=await setup({getWorkspace:async()=>{const b=workspace();b.leads=b.leads.filter(l=>l.stage==='new');return b}});
 try{assert.equal(s.d.querySelector('.stage-column[data-stage="engaged"] .stage-empty').textContent,'No leads in Engaged');}finally{s.close()}
});
test('card opens wide details with original entries; polling preserves expanded details',async()=>{
 const s=await setup();try{s.d.querySelector('.lead-card').click();await tick();assert.equal(s.d.getElementById('leadDetail').open,true);assert.match(s.d.getElementById('detailBody').textContent,/Contact.*Market.*Vertical.*Plans.*Correspondence.*Stage history/s);
 const original=s.d.querySelector('#detailBody details');original.open=true;await s.app.refresh();assert.equal(s.d.querySelector('#detailBody details').open,true);
 }finally{s.close()}
});
for (const interruption of ['visibility', 'bfcache']) test(`Lead resumes the same eligible record and reading position after ${interruption}`,async()=>{
 const s=await setup();let release,releaseDetail;try{
  await s.app.readDetail(id(1));const expanded=s.d.querySelector('#detailBody details');expanded.open=true;
  const key=expanded.dataset.entryKey;s.d.getElementById('leadDetail').scrollTop=173;
  s.client.getActor=()=>new Promise(resolve=>release=resolve);
  s.client.getLeadDetail=()=>new Promise(resolve=>releaseDetail=resolve);
  if(interruption==='visibility'){
   Object.defineProperty(s.d,'visibilityState',{value:'hidden',configurable:true});s.d.dispatchEvent(new s.w.Event('visibilitychange'));
   Object.defineProperty(s.d,'visibilityState',{value:'visible',configurable:true});s.d.dispatchEvent(new s.w.Event('visibilitychange'));
  }else{s.w.dispatchEvent(new s.w.PageTransitionEvent('pagehide',{persisted:true}));s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));}
  await tick();assert.equal(s.d.getElementById('leadDetail').open,false);assert.equal(s.d.getElementById('detailBody').textContent,'');
  assert.equal(s.d.querySelectorAll('.lead-card').length,0);
  release('example-partner');await tick();assert.equal(typeof releaseDetail,'function');
  assert.doesNotMatch(s.d.getElementById('detailBody').textContent,/example@example.test/);
  releaseDetail({detail:{...detail(s.board.leads[0]),phone:'+1-555-010-0099'}});await tick();
  assert.equal(s.d.querySelector('#detailBody a[href="tel:+1-555-010-0099"]').textContent,'+1-555-010-0099');
  assert.equal(s.d.getElementById('leadDetail').open,true);assert.match(s.d.getElementById('detailTitle').textContent,/Example 1/);
  assert.equal(s.d.querySelector(`[data-entry-key="${key}"]`).open,true);assert.equal(s.d.getElementById('leadDetail').scrollTop,173);
  assert.equal(s.d.querySelector('.lead-card[data-selected="true"]').dataset.leadId,id(1));assert.equal(s.writes.length,0);
 }finally{release?.('example-partner');releaseDetail?.({detail:detail(s.board.leads[0])});s.close()}
});
for (const refusal of ['actor change','denied','vanished','ineligible']) test(`Lead resume forgets the record after ${refusal}`,async()=>{
 const s=await setup();try{
  await s.app.readDetail(id(1));
  if(refusal==='actor change')s.setActor('another-example');
  if(refusal==='denied')s.client.getActor=async()=>{throw Object.assign(new Error('denied'),{status:403})};
  const lead=s.board.leads[0];
  if(refusal==='vanished')s.board.leads.shift();
  if(refusal==='ineligible')lead.client_id=id(888);
  s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
  assert.equal(s.d.getElementById('leadDetail').open,false);assert.equal(s.d.getElementById('detailBody').textContent,'');
  s.setActor('example-partner');s.client.getActor=async()=> 'example-partner';
  if(refusal==='vanished')s.board.leads.unshift(lead);delete lead.client_id;
  await s.app.refresh();assert.equal(s.d.getElementById('leadDetail').open,false);assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('drag opens short evidence prompt, does not write before confirmation, commits exact version and evidence IDs',async()=>{
 const s=await setup();try{const card=s.d.querySelector('.lead-card');const start=new s.w.Event('dragstart',{bubbles:true});start.dataTransfer={setData(){}};card.dispatchEvent(start);
 s.d.querySelector('[data-stage="engaged"]').dispatchEvent(new s.w.Event('drop',{bubbles:true,cancelable:true}));await tick();assert.equal(s.writes.length,0);assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.querySelector('#stageQuestions textarea'),null);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(s.writes[0].stage,'engaged');assert.equal(s.writes[0].l.base_version,1);assert.deepEqual(s.writes[0].review.evidence_ids,[id(600),id(601)]);
 }finally{s.close()}
});
for(const finish of ['dragend','drop'])test(`map readiness preserves the native drag source until ${finish}`,async()=>{
 let ready;const map={locate:()=>true,update(){},dispose(){}};
 const s=await setup({},()=>new Promise(resolve=>{ready=()=>resolve(map)}));
 try{
  s.d.getElementById('showTerritory').click();
  const card=s.d.querySelector('.lead-card'),start=new s.w.Event('dragstart',{bubbles:true});
  start.dataTransfer={setData(){}};card.dispatchEvent(start);
  ready();await tick();
  assert.equal(card.isConnected,true,'map readiness must not replace the browser drag source');
  assert.equal(card.classList.contains('dragging'),true);
  assert.equal(card.querySelector('.lead-location').textContent,'Location not checked');
  const target=finish==='drop'?s.d.querySelector('[data-stage="engaged"]'):card;
  target.dispatchEvent(new s.w.Event(finish,{bubbles:true,cancelable:true}));
  if(finish==='drop')card.dispatchEvent(new s.w.Event('dragend',{bubbles:true}));
  assert.equal(s.d.querySelector('.dragging'),null);
  assert.equal(s.d.querySelector('.lead-location').textContent,'Market area only');
  assert.equal(s.writes.length,0);
 }finally{s.close()}
});
for(const finish of ['pointerup','pointercancel','lostpointercapture'])test(`map readiness preserves the touch drag source until ${finish}`,async()=>{
 let ready;const map={locate:()=>true,update(){},dispose(){}};
 const s=await setup({},()=>new Promise(resolve=>{ready=()=>resolve(map)}));
 try{
  s.d.getElementById('showTerritory').click();
  const card=s.d.querySelector('.lead-card'),handle=card.querySelector('[data-drag-handle]');
  const pointer=type=>{const event=new s.w.Event(type,{bubbles:true});Object.assign(event,{pointerId:1,clientX:0,clientY:0});handle.dispatchEvent(event)};
  pointer('pointerdown');ready();await tick();
  assert.equal(handle.isConnected,true,'map readiness must not replace the captured pointer target');
  assert.equal(s.d.getElementById('leadBoard').dataset.touchDragging,'true');
  pointer(finish);
  assert.equal(s.d.getElementById('leadBoard').dataset.touchDragging,undefined);
  assert.equal(s.d.querySelector('.lead-location').textContent,'Market area only');
  assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('missing evidence asks one question; changed record refreshes the unsigned prompt without writing',async()=>{
 const s=await setup();try{await s.app.openReview(id(1),'qualified');assert.equal(s.d.querySelectorAll('#stageQuestions textarea').length,1);s.d.querySelector('textarea').value='Synthetic timing and space need confirmed';
 s.board.leads[0].base_version++;await s.app.refresh();assert.equal(s.d.getElementById('saveStage').disabled,false);assert.equal(s.app.state.proposal.lead.base_version,2);assert.equal(s.d.querySelector('textarea').value,'Synthetic timing and space need confirmed');assert.equal(s.writes.length,0);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(s.writes[0].l.base_version,2);
 }finally{s.close()}
});
test('Undo collects a human quote; Link removes card and Claim preserves New stage',async()=>{
 const s=await setup();try{s.d.querySelector('[data-undo]').click();await tick();assert.equal(s.writes.length,0);assert.equal(s.d.getElementById('stageDialog').open,true);
 assert.match(s.d.getElementById('stageQuestions').textContent,/Why undo/);
 const submit=()=>s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));
 submit();await tick();assert.equal(s.writes.length,0);
 s.d.querySelector('#stageQuestions textarea').value='   ';submit();await tick();assert.equal(s.writes.length,0);
 s.d.querySelector('#stageQuestions textarea').value='Synthetic reply was attributed to the wrong lead';
 await s.app.refresh();assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic reply was attributed to the wrong lead');
 submit();await tick();assert.equal(s.writes[0].stage,'outreach_active');assert.equal(s.writes[0].l.base_version,1);assert.deepEqual(s.writes[0].review,{reason:'Undo automatic stage move',evidence_ids:[],undo_event_id:id(500),human_quote:'Synthetic reply was attributed to the wrong lead'});
 s.d.querySelector('[data-link]').click();await tick();assert.equal(s.d.querySelector(`#leadBoard [data-lead-id="${id(19)}"]`),null);
 s.d.querySelector('[data-claim]').click();await tick();assert.equal(s.board.leads[0].stage,'new');assert.equal(s.board.leads[0].owner,'example-partner');assert.equal(s.d.querySelector(`#hotLeads [data-lead-id="${id(1)}"]`),null);
 }finally{s.close()}
});
for (const connected of [false, null, true]) test(`Engaged submits only connected call evidence: ${connected}`, async () => {
 const s=await setup();try{
  const call={id:id(700),kind:'call',connected,occurred_at:'2026-10-01T10:00:00Z',summary:'Synthetic call outcome'};
  s.client.getLeadDetail=async()=>({detail:{...detail(s.board.leads[0]),correspondence:[call]}});
  await s.app.openReview(id(1),'engaged');
  const submit=()=>s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));
  if(connected!==true){
   assert.equal(s.d.getElementById('stageQuestions').textContent,'What contact has taken place?');
   submit();await tick();assert.equal(s.writes.length,0);
   s.d.querySelector('#stageQuestions textarea').value='Synthetic contact confirmed in person';
  }else assert.equal(s.d.querySelector('#stageQuestions textarea'),null);
  submit();await tick();assert.equal(s.writes[0].stage,'engaged');
  assert.deepEqual(s.writes[0].review,connected===true?{reason:'Call completed',evidence_ids:[id(700)]}:
   {reason:'Synthetic contact confirmed in person',evidence_ids:[],human_quote:'Synthetic contact confirmed in person'});
 }finally{s.close()}
});
test('Undo cancellation and a replaced automatic event never send a correction',async()=>{
 const s=await setup();try{
  s.d.querySelector('[data-undo]').click();await tick();s.d.getElementById('stageDialog').close();assert.equal(s.writes.length,0);
  s.d.querySelector('[data-undo]').click();await tick();s.d.querySelector('#stageQuestions textarea').value='Synthetic correction';
  s.board.leads.find(row=>row.id===id(10)).last_stage_move.event_id=id(501);await s.app.refresh();
  assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.app.state.proposal,null);
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('Undo preserves its historical stage, event and quote through resume and an uncertain write',async()=>{
 const calls=[];const s=await setup({recordStage:async(...args)=>{calls.push(args);throw Object.assign(new Error('uncertain'),{code:'unknown_outcome'})}});try{
  s.board.leads.find(row=>row.id===id(10)).last_stage_move.from='closed_lost';await s.app.refresh();
  s.d.querySelector('[data-undo]').click();await tick();s.d.querySelector('#stageQuestions textarea').value='Synthetic correction after reviewing the reply';
  s.w.dispatchEvent(new s.w.PageTransitionEvent('pagehide',{persisted:true}));s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
  assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic correction after reviewing the reply');assert.equal(calls.length,0);
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(calls[0][1],'closed_lost');assert.equal(calls[0][2].undo_event_id,id(500));assert.equal(calls[0][2].human_quote,'Synthetic correction after reviewing the reply');
  await s.app.refresh();assert.equal(calls.length,1);
  s.d.getElementById('checkPending').click();await tick();assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
 }finally{s.close()}
});
test('stale Undo resume cannot copy its draft into another lead review',async()=>{
 const s=await setup();let release;try{
  const a=s.board.leads.find(row=>row.id===id(10)),b=s.board.leads.find(row=>row.id===id(9));
  b.stage='engaged';b.last_stage_move={...a.last_stage_move,event_id:id(502)};await s.app.refresh();
  await s.app.openReview(a.id,'outreach_active',{undoEventId:id(500)});
  s.d.querySelector('#stageQuestions textarea').value='Synthetic reason for lead A';
  const read=s.client.getLeadDetail;
  s.client.getLeadDetail=l=>l.id===a.id?new Promise(resolve=>{release=resolve}):read(l);
  s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
  assert.equal(typeof release,'function');s.d.getElementById('closeStage').click();
  await s.app.openReview(b.id,'outreach_active',{undoEventId:id(502)});
  release({detail:detail(a)});await tick();
  assert.equal(s.d.querySelector('#stageQuestions textarea').value,'');
  s.d.querySelector('#stageQuestions textarea').value='Synthetic reason for lead B';
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(s.writes.length,1);assert.equal(s.writes[0].l.id,b.id);
  assert.equal(s.writes[0].review.undo_event_id,id(502));assert.equal(s.writes[0].review.human_quote,'Synthetic reason for lead B');
 }finally{release?.({detail:detail(s.board.leads.find(row=>row.id===id(10)))});s.close()}
});
for(const source of ['board','fresh detail'])test(`Undo restores distinct producer stages within Nurture from ${source}`,async()=>{
 const s=await setup();try{
  const row=s.board.leads.find(row=>row.id===id(10));row.last_stage_move.from='nurture_drip';row.last_stage_move.to='closed_lost';
  row.stage=source==='board'?'closed_lost':'engaged';row.last_stage_move.to=row.stage;await s.app.refresh();
  s.client.getLeadDetail=async()=>({detail:detail({...row,stage:'closed_lost',last_stage_move:{...row.last_stage_move,to:'closed_lost'}})});
  s.d.querySelector(`[data-undo="${row.id}"]`).click();await tick();
  assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.getElementById('saveStage').disabled,false);
  s.d.querySelector('#stageQuestions textarea').value='Synthetic historical restoration';await s.app.refresh();
  assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic historical restoration');
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(s.writes.length,1);assert.equal(s.writes[0].stage,'nurture_drip');assert.equal(s.writes[0].review.undo_event_id,id(500));
 }finally{s.close()}
});
test('Undo draft survives a failed detail poll and requires fresh verification before confirmation',async()=>{
 const s=await setup();try{
  s.d.querySelector('[data-undo]').click();await tick();s.d.querySelector('#stageQuestions textarea').value='Synthetic correction retained after read failure';
  const read=s.client.getLeadDetail;s.client.getLeadDetail=async()=>{throw new Error('Synthetic network failure')};await s.app.refresh();
  assert.equal(s.d.getElementById('saveStage').disabled,true);assert.equal(s.app.state.proposal,null);
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));assert.equal(s.writes.length,0);
  s.client.getLeadDetail=read;await s.app.refresh();assert.equal(s.d.getElementById('saveStage').disabled,false);
  assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic correction retained after read failure');
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(s.writes[0].review.human_quote,'Synthetic correction retained after read failure');
 }finally{s.close()}
});
test('Undo draft survives visibility resume while its detail poll is pending',async()=>{
 const s=await setup();let release;try{
  s.d.querySelector('[data-undo]').click();await tick();s.d.querySelector('#stageQuestions textarea').value='Synthetic correction retained during pending poll';
  const read=s.client.getLeadDetail;s.client.getLeadDetail=()=>new Promise(resolve=>{release=resolve});const polling=s.app.refresh();await tick();
  assert.equal(s.app.state.proposal,null);assert.equal(s.d.getElementById('saveStage').disabled,true);
  Object.defineProperty(s.d,'visibilityState',{value:'hidden',configurable:true});s.d.dispatchEvent(new s.w.Event('visibilitychange'));
  s.client.getLeadDetail=read;Object.defineProperty(s.d,'visibilityState',{value:'visible',configurable:true});s.d.dispatchEvent(new s.w.Event('visibilitychange'));await tick();
  release({detail:detail(s.board.leads.find(row=>row.id===id(10)))});await polling;await tick();
  assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.getElementById('saveStage').disabled,false);
  assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic correction retained during pending poll');assert.equal(s.writes.length,0);
 }finally{release?.({detail:detail(s.board.leads.find(row=>row.id===id(10)))});s.close()}
});
test('Undo polling preserves edits made while fresh detail is pending',async()=>{
 const s=await setup();let release;try{
  s.d.querySelector('[data-undo]').click();await tick();const input=s.d.querySelector('#stageQuestions textarea');input.value='Synthetic initial draft';
  s.client.getLeadDetail=()=>new Promise(resolve=>{release=resolve});const polling=s.app.refresh();await tick();
  input.value='Synthetic revised draft during verification';release({detail:detail(s.board.leads.find(row=>row.id===id(10)))});await polling;
  assert.equal(s.d.querySelector('#stageQuestions textarea'),input);assert.equal(input.value,'Synthetic revised draft during verification');
 }finally{release?.({detail:detail(s.board.leads.find(row=>row.id===id(10)))});s.close()}
});
test('unknown write retains exact key and payload, never automatically resends; actor change clears it',async()=>{
 const writes=[];const s=await setup({recordStage:async(...args)=>{writes.push(args);throw Object.assign(new Error('network'),{code:'unknown_outcome'})}});
 try{await s.app.openReview(id(1),'engaged');s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();const pending=s.app.state.pending;assert.ok(pending);s.board.leads[0].base_version++;await s.app.refresh();assert.equal(writes.length,1);assert.equal(s.app.state.pending,pending);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(writes[1][3],writes[0][3]);assert.deepEqual(writes[1][2],writes[0][2]);
 s.setActor('another-example');await s.app.refresh();assert.equal(s.app.state.pending,null);assert.equal(s.d.getElementById('stageDialog').open,false);
 }finally{s.close()}
});
test('authoritative version conflict refreshes the prompt and requires a new confirmation',async()=>{
 const s=await setup();let calls=0;try{
 s.client.recordStage=async(l)=>{calls++;if(calls===1){s.board.leads[0].base_version++;throw Object.assign(new Error('changed'),{code:'version_conflict'})}assert.equal(l.base_version,2);return{ok:true}};
 await s.app.openReview(id(1),'qualified');s.d.querySelector('textarea').value='Synthetic qualification';s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls,1);assert.equal(s.app.state.pending,null);assert.equal(s.app.state.proposal.lead.base_version,2);assert.equal(s.d.querySelector('textarea').value,'Synthetic qualification');assert.equal(s.d.getElementById('saveStage').disabled,false);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(calls,2);
 }finally{s.close()}
});
test('a prompt closes without writing when its move is complete or the lead becomes a client',async()=>{
 const s=await setup();try{
 await s.app.openReview(id(1),'engaged');s.board.leads[0].stage='engaged';s.board.leads[0].base_version++;await s.app.refresh();assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.writes.length,0);
 s.board.leads[0].stage='new';await s.app.refresh();await s.app.openReview(id(1),'engaged');s.board.leads[0].client_id=id(888);s.board.leads[0].base_version++;await s.app.refresh();assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.app.state.proposal,null);assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('prompt polls new correspondence without a version change and preserves the same question input',async()=>{
 const s=await setup();let rows=[];try{
 s.client.getLeadDetail=async()=>({detail:{...detail(s.board.leads[0]),correspondence:rows}});
 await s.app.openReview(id(1),'outreach_active');const input=s.d.querySelector('textarea');input.value='Synthetic outreach draft';await s.app.refresh();assert.equal(s.d.querySelector('textarea'),input);assert.equal(input.value,'Synthetic outreach draft');
 rows=[{id:id(701),kind:'email_out',occurred_at:'2026-10-01T10:00:00Z',summary:'Synthetic outreach sent'}];await s.app.refresh();assert.equal(s.d.querySelector('textarea'),null);assert.equal(s.app.state.proposal.review.evidence[0].id,id(701));assert.equal(s.app.state.proposal.lead.base_version,1);assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('late detail from card A cannot replace card B; private view clears after auth denial',async()=>{
 let release;const s=await setup();try{s.client.getLeadDetail=l=>l.id===id(1)?new Promise(r=>{release=r}):Promise.resolve({detail:detail(s.board.leads.find(x=>x.id===l.id))});
 const a=s.app.readDetail(id(1));await s.app.readDetail(id(2));release({detail:detail(s.board.leads[0])});await a;assert.match(s.d.getElementById('detailTitle').textContent,/Example 2/);
 s.client.getActor=async()=>{throw Object.assign(new Error(),{code:'unauthorized'})};await s.app.refresh();assert.equal(s.d.querySelectorAll('.lead-card').length,0);assert.equal(s.d.getElementById('leadDetail').open,false);
 }finally{s.close()}
});
test('touch drop and keyboard move open review; cancelled touch never writes',async()=>{
 const s=await setup();try{
 const pointer=(type,x,y)=>{const e=new s.w.Event(type,{bubbles:true});Object.assign(e,{pointerId:1,clientX:x,clientY:y});s.d.querySelector('[data-drag-handle]').dispatchEvent(e)};
 s.d.elementFromPoint=()=>s.d.querySelector('[data-stage="engaged"]');
 pointer('pointerdown',0,0);pointer('pointermove',50,50);assert.ok(s.d.querySelector('[data-drop-active]'));pointer('pointercancel',50,50);pointer('pointerup',50,50);await tick();assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.writes.length,0);
 pointer('pointerdown',0,0);pointer('pointerup',50,50);await tick();assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.app.state.proposal.target,'engaged');assert.equal(s.writes.length,0);
 s.d.getElementById('stageDialog').close();s.d.querySelector('.lead-card').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}));await tick();assert.equal(s.app.state.proposal.target,'qualified');assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('new correspondence preserves the expanded original by identity, not position',async()=>{
 const s=await setup();try{
 let rows=detail(s.board.leads[0]).correspondence;
 s.client.getLeadDetail=async()=>({detail:{...detail(s.board.leads[0]),correspondence:rows}});
 await s.app.readDetail(id(1));const original=s.d.querySelector('.correspondence details');original.open=true;const key=original.dataset.entryKey;
 rows=[{id:id(999),kind:'email_in',occurred_at:'2026-10-01',summary:'Synthetic new entry',detail:'Synthetic original'},...rows];await s.app.refresh();
 assert.equal(s.d.querySelector('.correspondence details').open,false);assert.equal(s.d.querySelector(`[data-entry-key="${key}"]`).open,true);
 }finally{s.close()}
});

test('blocking 2: detail, review and HTTP authorization denial invalidate every private view',async()=>{
 for(const surface of ['detail','review','actor']){
  const s=await setup();try{
   await s.app.readDetail(id(1));
   const denied=async()=>{throw Object.assign(new Error('denied'),{code:surface==='actor'?'tool_error':'not_authenticated',status:401})};
   if(surface==='actor')s.client.getActor=denied;else s.client.getLeadDetail=denied;
   if(surface==='review')await s.app.openReview(id(1),'qualified');else await s.app.refresh();
   assert.equal(s.d.querySelectorAll('.lead-card').length,0,surface);
   assert.equal(s.d.getElementById('leadDetail').open,false,surface);
   assert.equal(s.d.getElementById('stageDialog').open,false,surface);
   assert.equal(s.d.getElementById('detailBody').textContent,'');
   assert.equal(s.app.state.proposal,null);assert.equal(s.app.state.identityReady,false);
  }finally{s.close()}
 }
});

test('blocking 2: shared transport clears private workspace on authorization headers with a stalled body', async () => {
 for (const status of [401, 403]) for (const surface of ['actor', 'workspace', 'detail', 'review', 'mutation']) {
  const board = workspace(); let deny = false, bodyReads = 0;
  const client = createLeadBoardClient({ timeoutMs: 20, fetchImpl: async (_path, init) => {
   const session = _path === '/api/system-work/session';
   const { name, arguments: args } = session ? { name: 'session', arguments: {} } : JSON.parse(init.body).params;
   const denied = deny && (surface === 'mutation' ? name === 'update-lead' : surface === 'actor' ? session :
    name === 'lead-board' && (surface === 'workspace' ? !args.lead_id : Boolean(args.lead_id)));
   if (denied) return { ok: false, status, json: () => { bodyReads++; return new Promise(() => {}); } };
   if (session) return { ok: true, status: 200, json: async () => ({ actor: { slug: 'example-partner' } }) };
   const payload =
    { ...board, ...(args.lead_id ? { detail: detail(board.leads.find(l => l.id === args.lead_id)) } : {}) };
   return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) };
  } });
  const s = await setup(client);
  try {
   await s.app.readDetail(id(1));
   assert.match(s.d.getElementById('detailBody').textContent, /Contact/);
   assert.equal(s.d.querySelectorAll('.lead-card').length, 14);
   if (surface === 'mutation') await s.app.openReview(id(1), 'engaged');
   deny = true;
   if (surface === 'mutation') {
    s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit', { cancelable: true })); await tick();
   } else if (surface === 'review') await s.app.openReview(id(1), 'qualified'); else await s.app.refresh();
   assert.equal(s.d.querySelectorAll('.lead-card').length, 0, `${status}/${surface}`);
   assert.equal(s.d.getElementById('leadDetail').open, false);
   assert.equal(s.d.getElementById('stageDialog').open, false);
   assert.equal(s.d.getElementById('detailBody').textContent, '');
   assert.equal(s.app.state.pending, null); assert.equal(s.app.state.proposal, null);
   assert.equal(s.app.state.identityReady, false); assert.equal(bodyReads, 0);
   assert.match(s.d.getElementById('leadBoardError').textContent, /Sign-in required/);
  } finally { s.close(); }
 }
});

test('blocking 3: failed identity and workspace polls retain actionable recovery and the exact uncertain intent', async () => {
 for (const kind of ['claim', 'stage']) for (const surface of ['getActor', 'getWorkspace']) {
  const s = await setup(); const writes = [];
  try {
   s.client[kind === 'claim' ? 'claimLead' : 'recordStage'] = async (...args) => {
    writes.push(args); throw Object.assign(new Error('uncertain'), { code: 'unknown_outcome' });
   };
   if (kind === 'claim') s.d.querySelector('[data-claim]').click();
   else {
    await s.app.openReview(id(1), 'engaged');
    s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit', { cancelable: true }));
   }
   await tick(); s.d.getElementById('stageDialog').close();
   const pending = s.app.state.pending, read = s.client[surface]; assert.ok(pending);
   s.client[surface] = async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); };
   for (let poll = 0; poll < 2; poll++) {
    await s.app.refresh();
    assert.equal(s.app.state.pending, pending); assert.equal(writes.length, 1);
    const feedback = s.d.getElementById('leadBoardError'); assert.equal(feedback.hidden, false);
    assert.match(feedback.textContent, /Connection interrupted/);
    assert.ok(s.d.getElementById('checkPending'), `${kind}/${surface}`);
   }
   s.client[surface] = read; await s.app.refresh();
   assert.doesNotMatch(s.d.getElementById('leadBoardError').textContent, /Connection interrupted/);
   s.d.getElementById('checkPending').click(); await tick();
   assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  } finally { s.close(); }
 }
});

test('blocking 3: uncertain claim and closed stage review retain visible recovery through every poll',async()=>{
 for(const kind of ['claim','stage']){
 const s=await setup();try{
  const fail=async()=>{throw Object.assign(new Error('uncertain'),{code:'unknown_outcome'})};
  if(kind==='claim'){s.client.claimLead=fail;s.d.querySelector('[data-claim]').click()}
  else{s.client.recordStage=fail;await s.app.openReview(id(1),'engaged');s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}))}
  await tick();s.d.getElementById('stageDialog').close();await s.app.refresh();
  assert.ok(s.app.state.pending);assert.equal(s.d.getElementById('leadBoardError').hidden,false);
  assert.ok(s.d.getElementById('checkPending'));await s.app.refresh();assert.ok(s.d.getElementById('checkPending'));
 }finally{s.close()}
 }
});
test('blocking 3: authoritative refusal feedback survives successful readback',async()=>{
 const s=await setup({claimLead:async()=>{throw Object.assign(new Error('refused'),{code:'version_conflict'})}});try{
 s.d.querySelector('[data-claim]').click();await tick();assert.equal(s.app.state.pending,null);
 assert.equal(s.d.getElementById('leadBoardError').hidden,false);assert.match(s.d.getElementById('leadBoardError').textContent,/Lead updated/);
 }finally{s.close()}
});

test('blocking 4: a failed recovery identity read retains the unresolved exact key and payload',async()=>{
 const writes=[];const s=await setup({recordStage:async(...args)=>{writes.push(args);throw Object.assign(new Error('uncertain'),{code:'unknown_outcome'})}});try{
 await s.app.openReview(id(1),'engaged');s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
 const pending=s.app.state.pending;s.client.getActor=async()=>{throw Object.assign(new Error('offline'),{code:'network_error'})};
 s.d.getElementById('checkPending').click();await tick();assert.equal(writes.length,1);assert.equal(s.app.state.pending,pending);
 s.client.getActor=async()=>pending.actor;await s.app.refresh();s.d.getElementById('checkPending').click();await tick();assert.equal(writes.length,2);assert.equal(writes[1][3],writes[0][3]);assert.deepEqual(writes[1][2],writes[0][2]);
 }finally{s.close()}
});

test('blocking 5: unknown then conflict restores the preserved question draft and permits a fresh confirmation',async()=>{
 const s=await setup();let calls=0;try{
 s.client.recordStage=async(l,stage,review)=>{calls++;if(calls===1)throw Object.assign(new Error(),{code:'unknown_outcome'});if(calls===2){s.board.leads[0].base_version++;throw Object.assign(new Error(),{code:'version_conflict'})}assert.equal(l.base_version,2);assert.equal(review.human_quote,'Synthetic qualification')};
 await s.app.openReview(id(1),'qualified');s.d.querySelector('textarea').value='Synthetic qualification';
 const submit=()=>s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));
 submit();await tick();assert.equal(s.d.querySelector('textarea').disabled,true);submit();await tick();
 assert.equal(s.d.querySelector('textarea').disabled,false);assert.equal(s.d.querySelector('textarea').value,'Synthetic qualification');submit();await tick();assert.equal(calls,3);
 }finally{s.close()}
});

test('blocking 6: initial detail cannot resurrect a lead excluded by the latest board',async()=>{
 for(const change of ['linked','removed','suppressed']){
 const s=await setup();let release;try{
 const stale=detail(s.board.leads[0]);s.client.getLeadDetail=()=>new Promise(r=>release=r);const reading=s.app.readDetail(id(1));
 if(change==='removed')s.board.leads.shift();else if(change==='linked')s.board.leads[0].client_id=id(900);else s.board.leads[0].suppressed=true;
 await s.app.refresh();release({detail:stale});await reading;
 assert.equal(s.d.getElementById('leadDetail').open,change==='removed',change);assert.equal(s.app.state.detail,null);if(change==='removed')assert.match(s.d.getElementById('detailBody').textContent,/Unavailable/);
 }finally{s.close()}
 }
});

test('blocking 7: fresh detail already at the requested stage closes review without a redundant write',async()=>{
 const s=await setup();try{
 s.client.getLeadDetail=async()=>({detail:detail({...s.board.leads[0],stage:'engaged',base_version:2})});
 await s.app.openReview(id(1),'engaged');assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.app.state.proposal,null);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('blocking 8: initial and loaded detail failures recover read-only through polling',async()=>{
 const s=await setup();let calls=0,offline=true;try{
 s.client.getLeadDetail=async()=>{calls++;if(offline)throw Object.assign(new Error('offline'),{code:'network_error'});return{detail:detail(s.board.leads[0])}};
 await s.app.readDetail(id(1));assert.match(s.d.getElementById('detailBody').textContent,/reconnecting/);
 offline=false;await s.app.refresh();assert.equal(calls,2);assert.match(s.d.getElementById('detailBody').textContent,/example@example.test/);
 offline=true;await s.app.refresh();assert.match(s.d.getElementById('detailBody').textContent,/reconnecting/);assert.equal(s.d.querySelector('#detailStage'),null);
 offline=false;await s.app.refresh();assert.ok(s.d.querySelector('#detailStage'));assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('blocking 8: visibility interruption of initial detail preserves its subject for recovery',async()=>{
 const s=await setup();let release;try{
 const original=s.client.getLeadDetail;s.client.getLeadDetail=()=>new Promise(r=>release=r);
 const reading=s.app.readDetail(id(1));Object.defineProperty(s.d,'visibilityState',{value:'hidden',configurable:true});s.d.dispatchEvent(new s.w.Event('visibilitychange'));
 release({detail:detail(s.board.leads[0])});await reading;s.client.getLeadDetail=original;
 Object.defineProperty(s.d,'visibilityState',{value:'visible',configurable:true});await s.app.refresh();assert.ok(s.d.querySelector('#detailStage'));assert.equal(s.writes.length,0);
 }finally{s.close()}
});

test('blocking 9: polling preserves focused lead/action identity and resolves the dialog return target',async()=>{
 const s=await setup();try{
 let card=s.d.querySelector('.lead-card .lead-open');card.focus();await s.app.refresh();assert.equal(s.d.activeElement.dataset.open,id(1));
 const claim=s.d.querySelector('[data-claim]');claim.focus();await s.app.refresh();assert.equal(s.d.activeElement.dataset.claim,claim.dataset.claim);
 card=s.d.querySelector('.lead-card .lead-open');card.focus();await s.app.readDetail(id(1));await s.app.refresh();s.d.getElementById('leadDetail').close();assert.equal(s.d.activeElement.dataset.open,id(1));
 }finally{s.close()}
});

test('blocking 11: removed owner and market selections normalize before filtering the next board',async()=>{
 for(const [filter,key,value] of [['ownerFilter','owner','example-partner'],['marketFilter','market','Mobile, AL']]){
 const s=await setup();try{
 const select=s.d.getElementById(filter);select.value=value;select.dispatchEvent(new s.w.Event('change'));assert.equal(s.d.querySelectorAll('.lead-card').length,1);
 if(key==='owner')s.board.leads.find(l=>l.owner===value).owner=null;else{const l=s.board.leads.find(l=>l.city==='Mobile');l.city='Pensacola';l.state='FL'}
 await s.app.refresh();assert.equal(select.value,'');assert.equal(s.app.state.filters[key],'');assert.equal(s.d.querySelectorAll('.lead-card').length,14);
 }finally{s.close()}
 }
});

test('blocking 12: account transitions clear private queries, filters and closed record text',async()=>{
 const s=await setup();try{
 await s.app.readDetail(id(1));s.d.getElementById('leadDetail').close();await s.app.openReview(id(1),'qualified');s.d.getElementById('stageDialog').close();
 const search=s.d.getElementById('leadSearch');search.value='Distinctive synthetic private query';search.dispatchEvent(new s.w.Event('input'));
 s.setActor('new-example-actor');await s.app.refresh();assert.equal(search.value,'');assert.deepEqual(s.app.state.filters,{search:'',owner:'',stage:'',market:''});
 assert.equal(s.d.getElementById('detailTitle').textContent,'');assert.equal(s.d.getElementById('stageTitle').textContent,'');assert.equal(s.app.state.trigger,null);
 }finally{s.close()}
});

test('blocking 13: malformed board never replaces known-good state or poisons filtering; valid polling recovers',async()=>{
 const s=await setup();try{
 const prior=s.app.state.board;s.client.getWorkspace=async()=>({schema_version:'lead-workspace.v1',leads:[null]});await s.app.refresh();assert.equal(s.app.state.board,prior);
 const search=s.d.getElementById('leadSearch');search.value='Example 1';search.dispatchEvent(new s.w.Event('input'));assert.ok(s.d.querySelectorAll('.lead-card').length>0);
 s.client.getWorkspace=async()=>structuredClone(s.board);await s.app.refresh();assert.equal(s.d.getElementById('leadBoardError').hidden,true);
 }finally{s.close()}
});
test('blocking 13: partial or malformed detail never enables a versioned proposal or leaves an old proposal usable',async()=>{
 const s=await setup();try{
 await s.app.openReview(id(1),'qualified');
 for(const malformed of [{id:id(1)}, {...detail(s.board.leads[0]),correspondence:[null]}, {...detail(s.board.leads[0]),stage_history:[null]}]){
 s.client.getLeadDetail=async()=>({detail:malformed});await s.app.openReview(id(1),'qualified',{updating:true});
 assert.equal(s.app.state.proposal,null);assert.equal(s.d.getElementById('saveStage').disabled,true);assert.equal(s.writes.length,0);
 }
 }finally{s.close()}
});

test('blocking 3: confirmed readback clears pending feedback and recovery once reconciliation succeeds',async()=>{
 const s=await setup({claimLead:async()=>{throw Object.assign(new Error(),{code:'unknown_outcome'})}});try{
 s.d.querySelector('[data-claim]').click();await tick();assert.ok(s.app.state.pending);
 s.board.leads[0].owner='example-partner';await s.app.refresh();assert.equal(s.app.state.pending,null);assert.equal(s.d.getElementById('leadBoardError').hidden,true);assert.equal(s.d.getElementById('checkPending'),null);
 }finally{s.close()}
});

test('resume clears private views before identity responds, restores the same unsigned question, and never replays a pending command',async()=>{
 const s=await setup();let release;try{
  await s.app.openReview(id(1),'qualified');s.d.querySelector('#stageQuestions textarea').value='Synthetic unsigned qualification';
  s.client.getActor=()=>new Promise(resolve=>release=resolve);
  s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
  assert.equal(s.d.querySelectorAll('.lead-card').length,0);assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.d.getElementById('stageContext').textContent,'');
  s.client.getActor=async()=> 'example-partner';release('example-partner');await tick();
  assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.querySelector('#stageQuestions textarea').value,'Synthetic unsigned qualification');assert.equal(s.writes.length,0);
  let attempts=0;s.client.recordStage=async()=>{attempts++;throw Object.assign(new Error('unknown'),{code:'unknown_outcome'})};
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();const pending=s.app.state.pending;
  s.w.dispatchEvent(new s.w.PageTransitionEvent('pagehide',{persisted:true}));s.w.dispatchEvent(new s.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
  assert.equal(s.app.state.pending,pending);assert.equal(attempts,1);assert.equal(s.writes.length,0);
 }finally{release?.('example-partner');s.close()}
});

test('detail polling keeps keyboard focus on the same expanded original entry',async()=>{
 const s=await setup();try{
  await s.app.readDetail(id(1));const original=s.d.querySelector('#detailBody details');original.open=true;original.querySelector('summary').focus();const key=original.dataset.entryKey;s.board.leads[0].score++;
  await s.app.refresh();assert.equal(s.d.activeElement,s.d.querySelector(`[data-entry-key="${key}"] summary`));assert.equal(s.d.querySelector(`[data-entry-key="${key}"]`).open,true);
 }finally{s.close()}
});
test('a failed first read reconnects within seconds without waiting a full poll',async()=>{
 let reads=0;const s=await setup({getWorkspace:async()=>{if(++reads===1)throw Object.assign(new Error('offline'),{code:'network_error'});return structuredClone(workspace())}});
 try{assert.equal(s.d.querySelectorAll('.lead-card').length,0);assert.match(s.d.getElementById('leadBoardError').textContent,/Connection interrupted/);
  await new Promise(r=>setTimeout(r,1_200));assert.equal(reads,2);assert.equal(s.d.querySelectorAll('.lead-card').length,14);assert.equal(s.d.getElementById('leadBoardError').hidden,true);assert.equal(s.writes.length,0);
 }finally{s.close()}
});

for (const surface of ['actor','workspace']) test(`PR129 #1 failed ${surface} verification clears loaded private details`,async()=>{
 const s=await setup();try{await s.app.readDetail(id(1));s.client[surface==='actor'?'getActor':'getWorkspace']=async()=>{throw Object.assign(new Error('Unavailable'),{status:503})};await s.app.refresh();
 assert.equal(s.d.getElementById('leadDetail').open,false);assert.equal(s.d.getElementById('detailBody').textContent,'');if(surface==='actor')assert.equal(s.d.querySelectorAll('.lead-card').length,0);
 }finally{s.close()}
});
test('PR129 #8 an open missing lead recovers with the identical detail on the next successful board',async()=>{
 const s=await setup();try{await s.app.readDetail(id(1));const lead=s.board.leads.shift();await s.app.refresh();assert.equal(s.d.getElementById('leadDetail').open,true);assert.match(s.d.getElementById('detailBody').textContent,/Unavailable/);
 s.board.leads.unshift(lead);await s.app.refresh();assert.equal(s.d.getElementById('leadDetail').open,true);assert.ok(s.d.querySelector('#detailStage'));assert.match(s.d.getElementById('detailBody').textContent,/example@example.test/);
 }finally{s.close()}
});

for (const phase of ['identity', 'workspace']) test(`PR136 #1 resume during pending boot ${phase} immediately replaces the invalidated read`, async () => {
 let actorReads = 0, workspaceReads = 0, release;
 const held = new Promise(resolve => { release = resolve; });
 const s = await setup({
  getActor: async () => { actorReads++; return phase === 'identity' && actorReads === 1 ? held : 'example-partner'; },
  getWorkspace: async () => { workspaceReads++; return phase === 'workspace' && workspaceReads === 1 ? held : structuredClone(workspace()); },
 });
 try {
  assert.equal(s.d.querySelectorAll('.lead-card').length, 0);
  Object.defineProperty(s.d, 'visibilityState', { value: 'hidden', configurable: true });
  s.d.dispatchEvent(new s.w.Event('visibilitychange'));
  Object.defineProperty(s.d, 'visibilityState', { value: 'visible', configurable: true });
  s.d.dispatchEvent(new s.w.Event('visibilitychange'));
  await tick();
  // The client ignores abort: a held transport must not delay replacement.
  assert.equal(actorReads, 2);
  assert.equal(workspaceReads, phase === 'identity' ? 1 : 2);
  assert.equal(s.d.querySelectorAll('.lead-card').length, 14);
  assert.equal(s.d.getElementById('leadBoard').getAttribute('aria-busy'), 'false');
  assert.equal(s.d.getElementById('leadBoardError').hidden, true);
  release(phase === 'identity' ? 'stale-example-partner' : { leads: [] });
  await tick();
  assert.equal(s.app.state.actor, 'example-partner');
  assert.equal(s.d.querySelectorAll('.lead-card').length, 14);
  assert.equal(s.writes.length, 0);
 } finally { release(phase === 'identity' ? 'example-partner' : workspace()); s.close(); }
});

for (const status of [503, 401, 403]) test(`QA008 Leads freshness settles after failed read and retry: ${status}`, async () => {
 let failing = true;
 const s = await setup({ getWorkspace: async () => {
  if (failing) throw Object.assign(new Error('Synthetic board refusal'), { status });
  return structuredClone(workspace());
 } });
 try {
  const freshness = () => s.d.getElementById('boardUpdated');
  assert.equal(freshness().textContent, 'Unavailable');
  assert.equal(freshness().dateTime, '');
  await s.app.refresh();
  assert.equal(freshness().textContent, 'Unavailable');
  failing = false;
  await s.app.refresh();
  assert.match(freshness().textContent, /^Updated .* (AM|PM)$/);
  assert.equal(freshness().dateTime, workspace().generated_at);
  // A later failure that keeps the board keeps that board's time beside the
  // reconnecting line, as Deals does; a sign-in refusal clears both.
  failing = true;
  await s.app.refresh();
  const kept = status === 503;
  assert.equal(s.d.querySelectorAll('.lead-card').length > 0, kept);
  if (kept) assert.match(freshness().textContent, /^Updated .* (AM|PM)$/);
  else assert.equal(freshness().textContent, 'Unavailable');
  assert.equal(freshness().dateTime, kept ? workspace().generated_at : '');
  assert.match(s.d.getElementById('leadBoardError').textContent, kept ? /reconnecting/ : /Sign-in required/);
 } finally { s.close(); }
});

test('QA008 Leads freshness is Unavailable when a failed identity read clears the board', async () => {
 let failing = false;
 const s = await setup({ getActor: async () => {
  if (failing) throw Object.assign(new Error('Synthetic identity outage'), { status: 503 });
  return 'example-partner';
 } });
 try {
  const freshness = () => s.d.getElementById('boardUpdated');
  assert.match(freshness().textContent, /^Updated /);
  failing = true;
  await s.app.refresh();
  assert.equal(s.d.querySelectorAll('.lead-card').length, 0, 'an unverified viewer keeps no private snapshot');
  assert.equal(freshness().textContent, 'Unavailable');
  assert.equal(freshness().dateTime, '');
 } finally { s.close(); }
});

test('a returned prospect can be activated from Leads using its fresh client version',async()=>{
 const s=await setup();try{
  const row=s.board.leads.find(l=>l.stage==='nurture_drip');
  Object.assign(row,{client_id:'synthetic-client',is_client:true,is_deal:true,prospect_client_id:'synthetic-client',prospect_client_version:7,prospect_engagement_status:'inactive'});
  s.client.setProspectEngagementStatus=async args=>{s.writes.push(args);row.prospect_engagement_status='active';return{ok:true}};
  await s.app.refresh();s.d.querySelector(`[data-lead-id="${row.id}"]`).click();await tick();
  const form=s.d.getElementById('activateProspect');assert.ok(form);
  form.querySelector('[name="reason"]').value='Synthetic renewed interest';
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(s.writes.length,1);assert.equal(s.writes[0].client_id,'synthetic-client');assert.equal(s.writes[0].base_version,7);
  assert.equal(s.writes[0].status,'active');assert.equal(s.writes[0].reason,'Synthetic renewed interest');
  assert.equal(s.d.querySelector(`[data-lead-id="${row.id}"]`),null);
 }finally{s.close()}
});

test('uncertain Leads activation preserves each prospect request without blocking another prospect',async()=>{
 const s=await setup();try{
  const rows=s.board.leads.slice(0,2);
  rows.forEach((row,index)=>Object.assign(row,{client_id:`synthetic-client-${index}`,is_client:true,is_deal:true,
   prospect_client_id:`synthetic-client-${index}`,prospect_client_version:7,prospect_engagement_status:'inactive'}));
  s.client.setProspectEngagementStatus=async args=>{s.writes.push(structuredClone(args));throw Object.assign(new Error('Uncertain'),{code:'unknown_outcome'})};
  await s.app.refresh();
  const submit=async(row,reason)=>{
   s.d.getElementById('leadDetail').close();await s.app.readDetail(row.id);
   const form=s.d.getElementById('activateProspect');assert.ok(form);
   form.elements.reason.value=reason;
   form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  };
  await submit(rows[0],'Synthetic first renewed interest');
  await submit(rows[1],'Synthetic second renewed interest');
  assert.equal(s.writes.length,2,'each prospect submits its own activation');
  assert.deepEqual(s.writes.map(args=>args.client_id),['synthetic-client-0','synthetic-client-1']);
  assert.notEqual(s.writes[0].idempotency_key,s.writes[1].idempotency_key);
  await s.app.refresh();assert.equal(s.writes.length,2,'polling never resends an uncertain write');
  await submit(rows[0],'Synthetic edited reason must not replace the request');
  assert.equal(s.writes.length,3);assert.deepEqual(s.writes[2],s.writes[0],'retry preserves the complete original request');
  rows[0].prospect_engagement_status='active';rows[0].prospect_client_version++;
  await s.app.refresh();assert.equal(s.writes.length,3,'committed read-back never replays');
  await submit(rows[1],'Synthetic second edited reason');
  assert.equal(s.writes.length,4);assert.deepEqual(s.writes[3],s.writes[1],'reconciling one client retains the other request');
 }finally{s.close()}
});

for (const failure of ['internal_error','unclassified_error']) test(`Leads activation retains an identical replay after ${failure}`,async()=>{
 const board=workspace(),row=board.leads[0],writes=[];
 Object.assign(row,{client_id:'synthetic-client',is_client:true,is_deal:true,prospect_client_id:'synthetic-client',
  prospect_client_version:7,prospect_engagement_status:'inactive'});
 const client=createLeadBoardClient({docContext:false,fetchImpl:async(_path,init)=>{
  if (_path === '/api/system-work/session') return Response.json({actor:{slug:'example-partner'}});
  const {name,arguments:args}=JSON.parse(init.body).params;
  let payload,isError=false;
  if(name==='set-prospect-engagement-status'){
   writes.push(args);
   if(writes.length===1){payload={ok:false,error:failure};isError=true}
   else{row.prospect_engagement_status='active';row.prospect_client_version++;payload={ok:true}}
  }else payload={...board,...(args.lead_id?{detail:detail(row)}:{})};
  return new Response(JSON.stringify({result:{isError,content:[{type:'text',text:JSON.stringify(payload)}]}}));
 }});
 const s=await setup(client);try{
  await s.app.readDetail(row.id);
  let form=s.d.getElementById('activateProspect');form.elements.reason.value='Synthetic renewed interest';
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(writes.length,1);
  form=s.d.getElementById('activateProspect');
  assert.equal(form.querySelector('button').textContent,'Check outcome','unclassified errors preserve recovery');
  assert.equal(form.elements.reason.readOnly,true);
  await s.app.refresh();assert.equal(writes.length,1,'read-back never resends');
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
  assert.equal(s.d.getElementById('leadDetail').open,false);
  assert.equal(s.d.getElementById('leadBoardError').hidden,true);
 }finally{s.close()}
});

test('Leads activation allows another client in flight and isolates recovery when the actor changes',async()=>{
 const s=await setup(),releases=[];try{
  const rows=s.board.leads.slice(0,3);
  rows.forEach((row,index)=>Object.assign(row,{client_id:`synthetic-client-${index%2}`,is_client:true,is_deal:true,
   prospect_client_id:`synthetic-client-${index%2}`,prospect_client_version:7,prospect_engagement_status:'inactive'}));
  s.client.setProspectEngagementStatus=args=>{s.writes.push(structuredClone(args));return new Promise((resolve,reject)=>releases.push({resolve,reject}))};
  await s.app.refresh();
  const submit=async row=>{
   s.d.getElementById('leadDetail').close();await s.app.readDetail(row.id);
   const form=s.d.getElementById('activateProspect');form.elements.reason.value='Synthetic renewed interest';
   form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  };
  await submit(rows[0]);await submit(rows[2]);
  assert.equal(s.writes.length,1,'two leads for the same client share one in-flight request');
  assert.equal(s.d.querySelector('#activateProspect button').disabled,true);
  await submit(rows[1]);assert.equal(s.writes.length,2,'another client does not wait for the first response');
  for(const release of releases)release.reject(Object.assign(new Error('Uncertain'),{code:'unknown_outcome'}));
  await tick();
  assert.equal(s.d.querySelectorAll('[data-check-engagement]').length,2);
  s.setActor('another-example-partner');await s.app.refresh();
  assert.equal(s.d.querySelectorAll('[data-check-engagement]').length,0);
  await submit(rows[0]);assert.equal(s.writes.length,3);
  assert.notEqual(s.writes[2].idempotency_key,s.writes[0].idempotency_key,'another actor gets a separate request');
  assert.equal(s.writes[2].expected_actor,'another-example-partner');
 }finally{for(const release of releases)release.resolve({ok:true});await tick();s.close()}
});

test('rendered Leads recovery survives remount with a new client and storage restores the request',async()=>{
 const row=workspace().leads[0],sent=[];
 Object.assign(row,{client_id:'synthetic-refresh-client',is_client:true,is_deal:true,prospect_client_id:'synthetic-refresh-client',prospect_client_version:7,prospect_engagement_status:'inactive'});
 const board={...workspace(),leads:[row]};
 const overrides={getWorkspace:async()=>structuredClone(board),getLeadDetail:async()=>({detail:detail(row)}),setProspectEngagementStatus:async args=>{sent.push(structuredClone(args));throw Object.assign(new Error('Synthetic lost reply'),{code:'internal_error'})}};
 const s=await setup(overrides);let remounted;
 try{
  await s.app.readDetail(row.id);
  let form=s.d.getElementById('activateProspect');form.elements.reason.value='Synthetic original reason';
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  s.app.dispose();
  remounted=mountLeadsWorkspace(s.d,{...s.client},{mapFactory:async()=>({update(){},dispose(){}})});await tick();
  await remounted.readDetail(row.id);form=s.d.getElementById('activateProspect');
  assert.equal(form.querySelector('button').textContent,'Check outcome');
  assert.equal(form.elements.reason.value,'Synthetic original reason');
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(sent[1],sent[0]);
 }finally{remounted?.dispose();s.close()}
});

test('Leads recovery reports the retained inactive target from pipeline',async()=>{
 const s=await setup();try{
  const row=s.board.leads[0];Object.assign(row,{client_id:'synthetic-cross-page',is_client:true,is_deal:true,prospect_client_id:'synthetic-cross-page',prospect_client_version:7,prospect_engagement_status:'inactive'});
  s.client.setProspectEngagementStatus=async args=>{s.writes.push(args);if(s.writes.length===1)throw new Error('Synthetic lost deferral');return {ok:true}};
  const {engagementWriterFor}=await import('../js/prospect-engagement.mjs');
  await assert.rejects(engagementWriterFor(s.client,s.w.sessionStorage)({client_id:'synthetic-cross-page',base_version:7,status:'inactive',reason:'Synthetic original deferral',human_quote:'Synthetic original deferral',expected_actor:'example-partner'}));
  await s.app.refresh();await s.app.readDetail(row.id);
  const form=s.d.getElementById('activateProspect');form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(s.d.getElementById('moveAnnouncement').textContent,'Prospect returned to Leads');
  assert.deepEqual(s.writes[1],s.writes[0]);
 }finally{s.close()}
});

test('authenticated session controls claim identity and clears owner scope across sessions', async () => {
 let actor = 'example-partner';
 const board = { ...workspace(), actor: 'untrusted-board-actor' }, calls = [];
 const client = createLeadBoardClient({ docContext: false, fetchImpl: async (path, init) => {
  if (path === '/api/system-work/session') return Response.json({ actor: { slug: actor } });
  const request = JSON.parse(init.body).params;
  calls.push(request);
  assert.notEqual(request.name, 'deal-room-board');
  if (request.name === 'claim-lead') {
   board.leads.find(row => (row.registry_ref || row.id) === request.arguments.lead).owner = request.arguments.expected_actor;
   return Response.json({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  }
  const payload = { ...board, ...(request.arguments.lead_id ? { detail: detail(board.leads.find(row => row.id === request.arguments.lead_id)) } : {}) };
  return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
 } });
 const s = await setup(client);
 try {
  assert.equal(s.app.state.actor, actor);
  const owner = s.d.getElementById('ownerFilter');
  owner.value = actor; owner.dispatchEvent(new s.w.Event('change'));
  assert.equal(s.d.querySelectorAll('.lead-card').length, 1);
  assert.equal(s.d.querySelector('.lead-card').dataset.leadId, id(20));
  actor = 'another-example-partner';
  await s.app.refresh();
  assert.equal(s.app.state.actor, actor);
  assert.equal(s.app.state.filters.owner, '');
  assert.equal(owner.value, '');
  s.d.querySelector(`[data-claim="${id(1)}"]`).click();
  await tick();
  const writes = calls.filter(call => call.name === 'claim-lead');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].arguments.expected_actor, actor);
  assert.equal(board.leads.find(row => row.id === id(1)).owner, actor);
 } finally { s.close(); }
});
test('S2 submit rereads the reviewed lead and asks for review instead of overwriting a newer version',async()=>{
 const s=await setup();try{
  await s.app.openReview(id(1),'engaged');
  const prior=s.app.state.proposal.lead.base_version;
  s.board.leads[0].base_version++;
  s.board.leads[0].notes='Newer partner context';
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(s.writes.length,0);
  assert.equal(s.app.state.pending,null);
  assert.equal(s.app.state.proposal.lead.base_version,prior+1);
  assert.match(s.d.getElementById('stageError').textContent,/changed.*review/i);
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(s.writes.length,1);assert.equal(s.writes[0].l.base_version,prior+1);
 }finally{s.close()}
});

test('S2 an unknown lead write retries the original version and key without refreshing its material',async()=>{
 let reads=0,attempts=[];
 const s=await setup({recordStage:async(l,stage,review,key)=>{attempts.push(structuredClone({l,stage,review,key}));if(attempts.length===1)throw Object.assign(new Error('lost reply'),{code:'unknown_outcome'});return{ok:true}}});
 try{
  const original=s.client.getLeadDetail;s.client.getLeadDetail=async lead=>{reads++;return original(lead)};
  await s.app.openReview(id(1),'engaged');
  s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(reads,2,'review read plus pre-submit read');
  s.board.leads[0].base_version++;
  const before=reads;s.d.getElementById('checkPending').click();await tick();
  assert.equal(reads,before,'unknown replay does not fetch a replacement base version');
  assert.deepEqual(attempts[1],attempts[0]);
 }finally{s.close()}
});

test('S2 prospect activation checks the fresh client version before preparing an engagement request',async()=>{
 const s=await setup();try{
  const row=s.board.leads.find(l=>l.stage==='nurture_drip');Object.assign(row,{client_id:'synthetic-client',is_client:true,is_deal:true,prospect_client_id:'synthetic-client',prospect_client_version:7,prospect_engagement_status:'inactive'});
  s.client.setProspectEngagementStatus=async args=>{s.writes.push(args);return{ok:true}};
  await s.app.refresh();await s.app.readDetail(row.id);
  const form=s.d.getElementById('activateProspect');form.elements.reason.value='Synthetic reviewed reason';row.prospect_client_version++;
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(s.writes.length,0);assert.match(s.d.getElementById('leadBoardError').textContent,/changed.*review/i);
 }finally{s.close()}
});

for (const code of ['network_error', 'read_timeout']) test(`Slice A initial identity ${code} offers connection Retry without sign-in or writes`, async () => {
 let failing = true, workspaceReads = 0;
 const s = await setup({
  getActor: async () => { if (failing) throw Object.assign(new Error('Synthetic connection failure'), { code }); return 'example-partner'; },
  getWorkspace: async () => { workspaceReads++; return structuredClone(workspace()); },
 });
 try {
  const box = s.d.getElementById('leadBoardError');
  assert.match(box.textContent, /connection/i);
  assert.doesNotMatch(box.textContent, /sign.in/i);
  assert.equal(box.querySelector('a[href*="/auth/login"]'), null);
  assert.equal(s.app.state.identityReady, false);
  assert.equal(workspaceReads, 0);
  assert.equal(s.d.querySelectorAll('.lead-card').length, 0);
  failing = false;
  const retry = [...box.querySelectorAll('button')].find(button => button.textContent === 'Retry');
  assert.ok(retry, 'the failed read offers a local Retry action');
  retry.click(); await tick();
  assert.equal(s.app.state.identityReady, true);
  assert.ok(s.d.querySelectorAll('.lead-card').length > 0);
  assert.equal(box.hidden, true);
  assert.equal(s.writes.length, 0);
 } finally { s.close(); }
});

test('Chicago timestamps retain the business day and date-only move evidence never shifts',async()=>{
 const s=await setup({getWorkspace:async()=>{const b=workspace();b.last_search_at='2026-10-24T01:00:00Z';b.leads[0].last_stage_move={automatic:true,from:'new',to:b.leads[0].stage,event_id:'demo-move',evidence_date:'2026-10-24',reason:'demo evidence'};return b;}});
 try{
  assert.match(s.d.getElementById('searchUpdated').textContent,/Oct 23, 8:00 PM/);
  assert.match(s.d.querySelector('.auto-move').textContent,/10\/24/);
  s.client.getLeadDetail=async()=>({detail:{...detail(s.board.leads[0]),correspondence:[{id:'demo-evening',kind:'email_in',occurred_at:'2026-01-24T01:00:00Z',summary:'Demo winter correspondence'}]}});
  await s.app.readDetail(id(1));assert.match(s.d.querySelector('.correspondence time').textContent,/Jan 23, 7:00 PM/);
 }finally{s.close();}
});

test('midnight occurrence timestamps convert to Chicago while midnight DATE evidence retains its date',async()=>{
 const s=await setup({getWorkspace:async()=>{const b=workspace();b.leads[0].last_stage_move={automatic:true,from:'new',to:b.leads[0].stage,event_id:'demo-midnight',occurred_at:'2026-10-24T00:00:00Z',reason:'demo midnight event'};b.leads[1].last_stage_move={automatic:true,from:'qualified',to:b.leads[1].stage,event_id:'demo-date',evidence_date:'2026-10-24T00:00:00.000Z',reason:'demo DATE evidence'};return b;}});
 try{const moves=[...s.d.querySelectorAll('.auto-move')].map(node=>node.textContent);assert.ok(moves.some(text=>/demo midnight event 10\/23/.test(text)));assert.ok(moves.some(text=>/demo DATE evidence 10\/24/.test(text)));}finally{s.close();}
});
