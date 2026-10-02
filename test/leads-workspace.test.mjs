import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import {mountLeadsWorkspace} from '../js/leads-workspace-app.js';import {workspace,detail,id} from './leads-workspace-fixture.mjs';
const tick=()=>new Promise(r=>setTimeout(r,10));
async function setup(overrides={}){
 const dom=new JSDOM(await readFile(new URL('../leads.html',import.meta.url),'utf8'),{url:'https://example.test/leads',pretendToBeVisual:true});const w=dom.window,d=w.document;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){if(this.open){this.open=false;this.dispatchEvent(new w.Event('close'))}};
 let board=workspace(),actor='example-partner',writes=[];
 const client={getActor:async()=>actor,getWorkspace:async()=>structuredClone(board),getLeadDetail:async l=>({detail:detail(board.leads.find(x=>x.id===l.id))}),
 recordStage:async(l,stage,review,key)=>{writes.push({l,stage,review,key});let r=board.leads.find(x=>x.id===l.id);r.stage=stage;r.base_version++;r.last_stage_move={idempotency_key:key};return{ok:true}},
 linkClient:async(l,clientId,key)=>{writes.push({l,clientId,key});board.leads.find(x=>x.id===l.id).client_id=clientId;return{ok:true}},
 claimLead:async(l,key)=>{writes.push({l,key});board.leads.find(x=>x.id===l.id).owner=actor;return{ok:true}},...overrides};
 const app=mountLeadsWorkspace(d,client,{mapFactory:async()=>({update(){},dispose(){}})});await tick();
 return{dom,w,d,app,client,board,writes,setActor:a=>{actor=a},close:()=>{app.dispose();w.close()}};
}
test('board renders six full columns, five hottest, quiet IDs/scores and timestamps; filter-only archive',async()=>{
 const s=await setup();try{assert.equal(s.d.querySelectorAll('[data-stage]').length,6);assert.equal(s.d.querySelectorAll('.hot-row').length,5);assert.equal(s.d.querySelectorAll('.lead-card').length,14);
 assert.match(s.d.getElementById('searchUpdated').textContent,/Oct 1/);assert.match(s.d.querySelector('.party-id').textContent,/30000000/);assert.match(s.d.querySelector('.auto-move').textContent,/Moved by Doc: reply received 10\/1/);
 const select=s.d.getElementById('stageFilter');select.value='archived';select.dispatchEvent(new s.w.Event('change'));assert.equal(s.d.querySelectorAll('[data-stage]').length,0);assert.equal(s.d.querySelectorAll('.lead-card').length,1);
 }finally{s.close()}
});
test('card opens wide details with original entries; polling preserves expanded details',async()=>{
 const s=await setup();try{s.d.querySelector('.lead-card').click();await tick();assert.equal(s.d.getElementById('leadDetail').open,true);assert.match(s.d.getElementById('detailBody').textContent,/Contact.*Market.*Vertical.*Plans.*Correspondence.*Stage history/s);
 const original=s.d.querySelector('#detailBody details');original.open=true;await s.app.refresh();assert.equal(s.d.querySelector('#detailBody details').open,true);
 }finally{s.close()}
});
test('drag opens short evidence prompt, does not write before confirmation, commits exact version and evidence IDs',async()=>{
 const s=await setup();try{const card=s.d.querySelector('.lead-card');const start=new s.w.Event('dragstart',{bubbles:true});start.dataTransfer={setData(){}};card.dispatchEvent(start);
 s.d.querySelector('[data-stage="engaged"]').dispatchEvent(new s.w.Event('drop',{bubbles:true,cancelable:true}));await tick();assert.equal(s.writes.length,0);assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.d.querySelector('#stageQuestions textarea'),null);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(s.writes[0].stage,'engaged');assert.equal(s.writes[0].l.base_version,1);assert.deepEqual(s.writes[0].review.evidence_ids,[id(600),id(601)]);
 }finally{s.close()}
});
test('missing evidence asks one question; changed record refreshes the unsigned prompt without writing',async()=>{
 const s=await setup();try{await s.app.openReview(id(1),'qualified');assert.equal(s.d.querySelectorAll('#stageQuestions textarea').length,1);s.d.querySelector('textarea').value='Synthetic timing and space need confirmed';
 s.board.leads[0].base_version++;await s.app.refresh();assert.equal(s.d.getElementById('saveStage').disabled,false);assert.equal(s.app.state.proposal.lead.base_version,2);assert.equal(s.d.querySelector('textarea').value,'Synthetic timing and space need confirmed');assert.equal(s.writes.length,0);
 s.d.getElementById('stageForm').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.equal(s.writes[0].l.base_version,2);
 }finally{s.close()}
});
test('Undo, Link, and Claim are one-tap record operations; link removes card, claim preserves New stage',async()=>{
 const s=await setup();try{s.d.querySelector('[data-undo]').click();await tick();assert.equal(s.writes[0].stage,'outreach_active');assert.equal(s.writes[0].review.undo_event_id,id(500));
 s.d.querySelector('[data-link]').click();await tick();assert.equal(s.d.querySelector(`#leadBoard [data-lead-id="${id(19)}"]`),null);
 s.d.querySelector('[data-claim]').click();await tick();assert.equal(s.board.leads[0].stage,'new');assert.equal(s.board.leads[0].owner,'example-partner');assert.equal(s.d.querySelector(`#hotLeads [data-lead-id="${id(1)}"]`),null);
 }finally{s.close()}
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
 const card=s.d.querySelector('.lead-card'),handle=card.querySelector('[data-drag-handle]');
 const pointer=(type,x,y)=>{const e=new s.w.Event(type,{bubbles:true});Object.assign(e,{pointerId:1,clientX:x,clientY:y});handle.dispatchEvent(e)};
 s.d.elementFromPoint=()=>s.d.querySelector('[data-stage="engaged"]');
 pointer('pointerdown',0,0);pointer('pointermove',50,50);assert.ok(s.d.querySelector('[data-drop-active]'));pointer('pointercancel',50,50);pointer('pointerup',50,50);await tick();assert.equal(s.d.getElementById('stageDialog').open,false);assert.equal(s.writes.length,0);
 pointer('pointerdown',0,0);pointer('pointerup',50,50);await tick();assert.equal(s.d.getElementById('stageDialog').open,true);assert.equal(s.app.state.proposal.target,'engaged');assert.equal(s.writes.length,0);
 s.d.getElementById('stageDialog').close();card.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}));await tick();assert.equal(s.app.state.proposal.target,'qualified');assert.equal(s.writes.length,0);
 }finally{s.close()}
});
test('new correspondence preserves the expanded original by identity, not position',async()=>{
 const s=await setup();try{
 let rows=detail(s.board.leads[0]).correspondence;
 s.client.getLeadDetail=async()=>({detail:{...detail(s.board.leads[0]),correspondence:rows}});
 await s.app.readDetail(id(1));const original=s.d.querySelector('.correspondence details');original.open=true;const key=original.dataset.entryKey;
 rows=[{id:id(999),occurred_at:'2026-10-01',summary:'Synthetic new entry',detail:'Synthetic original'},...rows];await s.app.refresh();
 assert.equal(s.d.querySelector('.correspondence details').open,false);assert.equal(s.d.querySelector(`[data-entry-key="${key}"]`).open,true);
 }finally{s.close()}
});
