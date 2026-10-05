import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import {mountLeadsWorkspace} from '../js/leads-workspace-app.js';import {workspace,detail,id} from './leads-workspace-fixture.mjs';
import {createLeadBoardClient} from '../js/leads-client.js';
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
   const { name, arguments: args } = JSON.parse(init.body).params;
   const denied = deny && (surface === 'mutation' ? name === 'update-lead' : surface === 'actor' ? name === 'deal-room-board' :
    name === 'lead-board' && (surface === 'workspace' ? !args.lead_id : Boolean(args.lead_id)));
   if (denied) return { ok: false, status, json: () => { bodyReads++; return new Promise(() => {}); } };
   const payload = name === 'deal-room-board' ? { actor: 'example-partner' } :
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
 let card=s.d.querySelector('.lead-card');card.focus();await s.app.refresh();assert.equal(s.d.activeElement.dataset.leadId,id(1));
 const claim=s.d.querySelector('[data-claim]');claim.focus();await s.app.refresh();assert.equal(s.d.activeElement.dataset.claim,claim.dataset.claim);
 card=s.d.querySelector('.lead-card');card.focus();await s.app.readDetail(id(1));await s.app.refresh();s.d.getElementById('leadDetail').close();assert.equal(s.d.activeElement.dataset.leadId,id(1));
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
