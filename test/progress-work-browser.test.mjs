import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import routes from '../contracts/app-routes.v1.json' with {type:'json'};
import fixture from './fixtures/progress-work.synthetic.json' with {type:'json'};
import { canonicalFixture, multiEnvelopeCanonicalFixture, equalReviewCanonicalFixture } from './fixtures/progress-work.synthetic.mjs';
import { scopedTurn, scopedQueueCard, canonicalPassport, workScope, workDetailUrl } from '../js/progress-work-model.js';
import { passportProjectionDigest, validEngineeringPassport } from '../js/job-passport.js';

const NOW = new Date('2026-08-24T12:20:00Z');
const taskId = 't_demo0001';
const taskPath = `/control-room/progress/work?board=demo-project&task=${taskId}`;
const kinds = {projection:'observatory_projection',portfolio:'eval_portfolio',spatial:'spatial_surface',elapsed:'telemetry_measurement',cost:'telemetry_measurement',engineering:'engineering_passport',activation:'attempt_receipt'};
async function assertEventually(predicate) {
  for(let attempt=0;attempt<100;attempt++) { if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20)); }
  assert.equal(predicate(),true,'Expected the asynchronous mock read to finish');
}
function receipts() {
  return Object.entries(kinds).map(([key,kind],i)=>({seq:i+1,msg_id:`synthetic-${i}`,at:NOW.toISOString(),sponsor:'joe',seat:'codex',kind:'receipt',body:JSON.stringify({job_passport:{schema_version:'job-passport-wire.v1',kind,payload:fixture[key]}})}));
}

async function open(t,{width=390,path=taskPath,empty=false,stale=false,history=0,sessions,rpcReply}={}) {
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:900}}); page.setDefaultTimeout(7000); await page.clock.install({time:NOW});
  const errors=[],calls=[],posts=[]; page.on('pageerror',error=>errors.push(error.message));
  const state={rpcReply,offline:false,authLost:false,postFailure:false,turns:empty?[]:receipts(),queueReads:0,turnReads:0};
  if(!empty) state.turns.push({seq:8,msg_id:'review',at:NOW.toISOString(),sponsor:'joe',seat:'human',kind:'turn',body:`${taskId} Fix round one; independent review requested.`},
    {seq:9,msg_id:'other',at:NOW.toISOString(),sponsor:'dell',seat:'human',kind:'turn',body:'Unrelated synthetic task'},
    {seq:10,msg_id:'heartbeat',at:NOW.toISOString(),sponsor:'joe',seat:'hermes',kind:'receipt',body:JSON.stringify({heartbeat:{cycle_at:NOW.toISOString(),cursor:10,desks:[{name:'Synthetic desk',seat:'codex',live:true,last_seen:NOW.toISOString(),auth:false}],profiles:[{key:'doc',name:'Doc',model:'codex',desk:'Synthetic desk',status:'active'},{key:'builder',name:'Builder',model:'codex',desk:null,status:'active'}]}})});
  if(!empty) {
    const add=(kind,body,seat='codex',at=NOW.toISOString())=>state.turns.push({seq:state.turns.at(-1).seq+1,msg_id:`synthetic-extra-${state.turns.length}`,at,sponsor:'joe',seat,kind,body:typeof body==='string'?body:JSON.stringify(body)});
    const wrap=(kind,payload)=>({job_passport:{schema_version:'job-passport-wire.v1',kind,payload}});
    add('receipt',wrap('activation_reliability_projection',{canonical_binding:{...fixture.activation.knowledge_activation.canonical_binding,attempt_id:fixture.activation.attempt_id},canonical_revision:{authority_fact_count:0,learning_event_count:0,outcome_horizon_mature:false},learning:{lifecycle:'proposed',candidate_refs:['candidate:synthetic']},telemetry:[],reliability:{state:'insufficient_evidence',reasons:['reason:canonical-coverage'],derived_by:'canonical_authority_evaluation',outcome_horizon_state:'immature',outcome_horizon_not_before:'2026-08-31T12:00:00Z'}}));
    add('receipt',wrap('telemetry_measurement',{...fixture.elapsed,measurement_id:'synthetic-estimate',metric_kind:'session_tokens',value:{kind:'estimate',amount:10,estimate_method:'synthetic_method',uncertainty:'synthetic range'}}));
    add('receipt',{session_status:{name:'Demo context',context_pct:82,claimed:taskId}},'hermes','2026-08-24T11:30:00Z');
    add('receipt',{assignment:{seat:'dot',verb:'assign',ref:taskId,title:'Demo research worker',by:'joe'}},'hermes');
    add('system',`WORKER SPAWNED — seat dot, a backend worker. Mission: research ${taskId}. Executor: synthetic isolated worker.`,'dot');
    for(let i=0;i<history;i++)add('turn',`Unrelated synthetic historical turn ${i}`,'human');
  }
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
    if(url.pathname==='/mcp'){
      const rpc=route.request().postDataJSON().params;calls.push(rpc);
      if(state.authLost)return route.fulfill({status:401,body:'{}'});
      if(state.offline)return route.fulfill({status:503,body:'Synthetic offline'});
      let payload=rpc.name==='read-progress-board'?{ok:true,snapshot:{board_id:rpc.arguments.board_id,version:1,updated_at:stale?'2026-08-20T12:00:00Z':NOW.toISOString(),snapshot_json:{title:rpc.arguments.board_id==='carr-v5'?'System progress':'Demo project',tasks:empty?{}:{[taskId]:{title:'Demo work detail',status:'review',work_request:'WR-900'}}}},questions:[]}
        :rpc.name==='list-progress-boards'?{schema:'progress-board-directory.v1',boards:[{board_id:'carr-v5',title:'System progress',updated_at:NOW.toISOString(),task_counts:{}},{board_id:'demo-project',title:'Demo project',updated_at:NOW.toISOString(),task_counts:{review:1}}]}
        :rpc.name==='read-session-identity'?{sessions:sessions || (empty?[]:[{canonical_session_id:'session:fresh',display_name:'Demo builder',surface:'codex',work_state:'working'},{canonical_session_id:'session:other',display_name:'Other builder',surface:'codex'}]),permission_filtered:false}
        :rpc.name==='read-dispatch-history'?{events:[{event_id:rpc.arguments.cursor?2:1,stage:rpc.arguments.cursor?'acted':'sent',evidence:'synthetic dispatch',session_id:'session:fresh',attempt_ref:'attempt:a',work_request_ref:taskId}],more:!rpc.arguments.cursor,next_cursor:rpc.arguments.cursor?null:'synthetic-cursor'}
        :rpc.name==='engineering-passport'?canonicalFixture()
        :rpc.name==='work-request-card'?{ok:true,human_ref:'WR-900',title:'Demo work request',state:'needs_revision',version:1,desired_outcome:'Synthetic acceptance',acting_identity:[{act:'review',performed_by:'actor:builder'}]}
        :rpc.name==='unfinished-work'?{schema:'unfinished-work.v1',items:[],coverage:[],census_complete:true}:{};
      if (state.rpcReply) payload=await state.rpcReply(rpc,payload);
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}})});
    }
    if(url.pathname==='/api/room/turns'){
      state.turnReads++;if(state.offline)return route.fulfill({status:503,body:'{}'});
      const from=Number(url.searchParams.get('after_seq')||0),limit=Number(url.searchParams.get('limit')||200);
      const turns=state.turns.filter(turn=>turn.seq>from).slice(0,limit);
      return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,turns,latest_seq:turns.at(-1)?.seq||from,more:state.turns.some(turn=>turn.seq>(turns.at(-1)?.seq||from)),csrf_token:'synthetic-csrf',actor:{slug:'joe'}})});
    }
    if(url.pathname==='/api/room/queue'){
      state.queueReads++;if(state.authLost)return route.fulfill({status:401,body:'{}'});if(state.offline)return route.fulfill({status:503,body:'{}'});
      if(state.queueWait)await state.queueWait;
      const events=state.queueEmpty||empty?[]:[{v:1,board:'carr-build',event_id:1,event:'created',task_id:taskId,card:{title:'Demo research',target:'dot',effective_model:'Synthetic researcher',status:'ready',priority:'P1',cap:'read',updated_at:NOW.toISOString(),source_seq:8},summary:'Synthetic research job',projected_at:NOW.toISOString()}];
      return route.fulfill({contentType:'application/json',body:JSON.stringify({live:!stale,projected_at:stale?'2026-08-20T12:00:00Z':NOW.toISOString(),events})});
    }
    if(url.pathname==='/api/room/turn'){
      posts.push({body:route.request().postDataJSON(),csrf:route.request().headers()['x-carr-csrf']});
      if(state.postFailure)return route.fulfill({status:502,contentType:'application/json',body:'{}'});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,seq:11,msg_id:'synthetic-post'})});
    }
    if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
    const legacy=routes.redirects[url.pathname]?.startsWith('/control-room/progress/work');
    const file=legacy ? (url.pathname.includes('queue')?'queue.html':'room.html') : routes.routes[url.pathname]||url.pathname.slice(1);
    try{const body=await readFile(new URL('../'+file,import.meta.url));return route.fulfill({body,contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost${path}`);await page.waitForFunction(()=>document.getElementById('workTitle')?.textContent!=='Work detail');
  return {page,state,errors,calls,posts};
}

test('published task without a repository shows its PR as plain text', async t => {
  const {page,errors} = await open(t,{rpcReply:(rpc,payload)=> {
    if (rpc.name === 'read-progress-board')
      Object.assign(payload.snapshot.snapshot_json.tasks[taskId], {pr:100, executor:'orchestrator'});
    return payload;
  }});
  const task = page.locator('#workMetadata article').filter({has:page.getByRole('heading',{name:'Published task',exact:true})});
  await task.waitFor();
  assert.equal(await task.locator('a[href*="/pull/100"]').count(), 0);
  const repo = task.locator('.work-detail-fields > div').filter({has:page.locator('dt',{hasText:/^repo$/})});
  assert.equal(await repo.locator('dd').textContent(), 'Not recorded');
  assert.equal(await task.locator('p').filter({hasText:/^PR #100$/}).count(), 1);
  const provider = task.locator('.work-detail-fields > div').filter({has:page.locator('dt',{hasText:/^provider$/})});
  const model = task.locator('.work-detail-fields > div').filter({has:page.locator('dt',{hasText:/^model$/})});
  assert.equal(await provider.locator('dd').textContent(), 'Unknown');
  assert.equal(await model.locator('dd').textContent(), 'Not recorded');
  assert.deepEqual(errors, []);
});

test('published task PR links retain the recorded repository and head', async t => {
  const {page,errors} = await open(t,{rpcReply:(rpc,payload)=> {
    if (rpc.name === 'read-progress-board')
      Object.assign(payload.snapshot.snapshot_json.tasks[taskId], {pr:100, repo:'jbookout/doctorcre-app', pr_head:'synthetic-head'});
    return payload;
  }});
  const anchor = page.locator('#workMetadata a[href="https://github.com/jbookout/doctorcre-app/pull/100"]');
  await anchor.waitFor();
  assert.equal(await anchor.textContent(), 'jbookout/doctorcre-app · PR #100 · synthetic-head');
  assert.equal(await anchor.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await anchor.getAttribute('target'), '_blank');
  assert.deepEqual(errors, []);
});

test('exact work references never join similar titles or shared seats',()=>{
  const scope=workScope('?task=t_demo');
  assert.equal(scopedTurn({body:'t_demo-more',seat:'codex'},scope),false);
  assert.equal(scopedTurn({body:'Same title',seat:'codex'},scope),false);
  assert.equal(scopedTurn({body:'Review t_demo.',seat:'codex'},scope),true);
  assert.equal(scopedTurn({body:JSON.stringify({job_passport:{payload:{work_request_id:'t_demo'}}})},scope),true);
  assert.match(workDetailUrl({board:'demo',task:'t_demo'}),/board=demo&task=t_demo/);
});

test('only explicit bindings and valid source sequences join execution evidence', async t => {
  const scope = workScope('?task=t_demo');
  const unrelated = {seq:undefined,task_id:'other-task',session_id:'session:other',body:JSON.stringify({title:'t_demo',session_id:'session:other'})};
  assert.equal(scopedTurn(unrelated,scope),false);
  for(const seq of [undefined,null,'',NaN,-1,1.5,Infinity])assert.equal(scopedQueueCard({task_id:'other',source_seq:seq},{...scope,sourceSeqs:[NaN]}),false);
  assert.equal(scopedQueueCard({task_id:'other',source_seq:8},{...scope,sourceSeqs:[8]}),true);
  const {page,state}=await open(t);
  state.turns.push({seq:100,msg_id:'mention-only',session_id:'session:other',seat:'human',kind:'turn',at:NOW.toISOString(),body:`Discuss ${taskId}.`});
  await page.clock.runFor(5100);
  assert.doesNotMatch(await page.locator('#workSessionList').textContent(),/Other builder/);
});

test('canonical current-generation Passport validates typed evidence before accepting its seal', () => {
  const valid = canonicalFixture();
  valid.projection_digest = passportProjectionDigest(valid);
  assert.equal(canonicalPassport(valid),true);
  const reseal = value => {value.projection_digest=passportProjectionDigest(value);return value;};
  const forged=structuredClone(valid);
  Object.assign(forged,{slice_plan:null,accepted_plan_revision:null,plan_digest:'invalid',operator_receipt:true,closure_state:'complete'});
  for(const key of ['slices','execution_envelopes','receipts','reviewer_facts','current_receipts','current_reviewer_facts','qa_facts'])forged[key]=[];
  for(const disposition of Object.values(forged.closure))Object.assign(disposition,{state:'invented',evidence_refs:[]});
  assert.equal(canonicalPassport(reseal(forged)),false);
  for(const change of [
    value => value.current_receipts[0].attempt_id='attempt:unbound',
    value => value.current_reviewer_facts.push({attempt_id:'attempt:unbound'}),
    value => value.receipts[0].checks[0].state='invented',
    value => value.slice_plan.work_request.id='wr:unbound',
    value => value.slices[0].dependency_refs=['slice:unbound'],
    value => {value.receipts[0].attribution.session_ref='session:unbound';value.current_receipts=structuredClone(value.receipts);},
    value => value.closure.proof.evidence_refs=[{...value.receipts[0].evidence_refs[0],ref:'evidence:unbound'}],
  ]) { const malformed=structuredClone(valid);change(malformed);assert.equal(canonicalPassport(reseal(malformed)),false); }
});

test('canonical Passport retains job-local attempts across envelope generations',()=>{
  for (const reviewed of [false, true]) {
    const value = multiEnvelopeCanonicalFixture({ reviewed });
    assert.equal(value.receipts.length, 2);
    assert.equal(value.current_receipts.length, 1);
    assert.equal(value.receipts[0].attempt_id, value.receipts[1].attempt_id);
    assert.notEqual(value.receipts[0].envelope_digest, value.receipts[1].envelope_digest);
    assert.equal(canonicalPassport(value), true, 'Historical and current receipt lineage must coexist');
    assert.equal(value.closure_state, reviewed ? 'complete' : 'blocked');
    const reversed = structuredClone(value);
    reversed.receipts.reverse();
    reversed.projection_digest = passportProjectionDigest(reversed);
    assert.equal(canonicalPassport(reversed), true, 'Historical order cannot select receipt authority');
  }
});

test('canonical Passport refuses duplicate, unbound and self-reviewed receipt lineage',()=>{
  const reseal = value => { value.projection_digest = passportProjectionDigest(value); return value; };
  for (const change of [
    value => value.receipts.push(structuredClone(value.receipts[0])),
    value => value.current_receipts[0].envelope_digest = 'sha256:' + 'f'.repeat(64),
    value => value.current_receipts[0].artifact_refs = ['artifact:unbound'],
    value => value.reviewer_facts[0].slice_ref = 'slice:unbound',
    value => value.reviewer_facts[0].attempt_id = 'attempt:unbound',
    value => { value.reviewer_facts[0].session_ref = value.receipts[0].attribution.session_ref; },
    value => { value.current_reviewer_facts = [structuredClone(value.reviewer_facts[0])]; },
  ]) {
    const value = multiEnvelopeCanonicalFixture();
    change(value);
    assert.equal(canonicalPassport(reseal(value)), false);
  }
});

test('canonical Passport preserves equal public reviews from distinct receipt generations',()=>{
  const value = equalReviewCanonicalFixture();
  assert.equal(value.receipts.length, 2);
  assert.notEqual(value.receipts[0].envelope_digest, value.receipts[1].envelope_digest);
  assert.deepEqual(value.reviewer_facts[0], value.reviewer_facts[1]);
  assert.equal(value.current_reviewer_facts.length, 1);
  assert.equal(value.closure_state, 'complete');
  assert.equal(canonicalPassport(value), true);
  for (const change of [
    projection => { projection.current_reviewer_facts = []; },
    projection => projection.current_reviewer_facts.push(structuredClone(projection.current_reviewer_facts[0])),
    projection => { projection.reviewer_facts[0].state = 'invented'; },
    projection => {
      // This fact can review the historical receipt, but cannot review its own
      // current execution even when it also appears in historical facts.
      projection.current_reviewer_facts[0].session_ref = projection.current_receipts[0].attribution.session_ref;
      projection.reviewer_facts[0] = structuredClone(projection.current_reviewer_facts[0]);
    },
  ]) {
    const malformed = structuredClone(value);
    change(malformed);
    malformed.projection_digest = passportProjectionDigest(malformed);
    assert.equal(canonicalPassport(malformed), false);
  }
});

test('equal public historical reviews keep complete canonical work available',async t=>{
  const {page,errors} = await open(t,{sessions:[
    {canonical_session_id:'session:second',display_name:'Second-generation builder'},
  ],rpcReply:(rpc,payload)=>rpc.name==='engineering-passport'?equalReviewCanonicalFixture():payload});
  await page.waitForFunction(()=>document.querySelector('#workCanonicalBody').textContent.includes('Closure: complete'));
  assert.doesNotMatch(await page.locator('#workCanonicalBody').textContent(),/unavailable/i);
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Second-generation builder'));
  assert.deepEqual(errors, []);
});

test('multi-envelope canonical Passport remains available and links its current session',async t=>{
  const {page}=await open(t,{sessions:[
    {canonical_session_id:'session:second',latest_attempt_ref:'attempt:1',display_name:'Second-generation builder'},
  ],rpcReply:(rpc,payload)=>rpc.name==='engineering-passport'?multiEnvelopeCanonicalFixture():payload});
  await page.waitForFunction(()=>document.querySelector('#workCanonicalBody').textContent.includes('Closure: blocked'));
  assert.doesNotMatch(await page.locator('#workCanonicalBody').textContent(),/unavailable/i);
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Second-generation builder'));
});

test('canonical completion requires an independent pass for the selected current receipt',()=>{
  const value=canonicalFixture();
  const evidence=structuredClone(value.receipts[0].evidence_refs);
  const pass={slice_ref:'slice:a',attempt_id:'attempt:a',reviewer_ref:'actor:reviewer',session_ref:'session:reviewer',state:'passed',evidence_refs:evidence,is_independent:true,reviewed_deviation_refs:[],resolved_deviation_refs:[]};
  value.current_reviewer_facts=[pass];value.reviewer_facts=[pass];value.slices[0].state='verified_complete';value.operator_receipt.remaining_risk=[];
  for(const key of ['work','proof','explanation','release'])value.closure[key]={state:'complete',evidence_refs:evidence,note:'Bound independently verified receipt'};
  value.closure_state='complete';value.projection_digest=passportProjectionDigest(value);
  assert.equal(canonicalPassport(value),true);
  value.current_reviewer_facts=[];value.projection_digest=passportProjectionDigest(value);
  assert.equal(canonicalPassport(value),false);
});

test('canonical Passport accepts the pinned repository execution envelope while wire stays read-only',()=>{
  const value=canonicalFixture();
  const envelope=value.execution_envelopes[0];
  Object.assign(envelope.server_binding.authority,{read_only:false,environment:'rehearsal',capability_profile:'capability:engineering-repository-write'});
  envelope.server_binding.adapter.adapter_id='adapter:codex-desktop';
  envelope.request.allowed_actions=['repository:create-worktree','repository:create-branch','repository:write-declared-scope','repository:run-checks','repository:commit','repository:push-branch','repository:open-pr'];
  value.receipts[0].envelope_digest=passportProjectionDigest(envelope);
  value.receipts[0].attribution.adapter_ref='adapter:codex-desktop';
  value.current_receipts=structuredClone(value.receipts);
  value.projection_digest=passportProjectionDigest(value);
  assert.equal(canonicalPassport(value),true);
  const wire=structuredClone(value);delete wire.current_receipts;delete wire.current_reviewer_facts;wire.projection_digest=passportProjectionDigest(wire);
  assert.equal(validEngineeringPassport(wire),false);
});

test('linked sessions join pinned native host and latest attempt fields',async t=>{
  const {page}=await open(t,{sessions:[
    {canonical_session_id:'session:attempt-linked',latest_attempt_ref:'attempt:a',native_host_id:'host:a',display_name:'Attempt-linked builder'},
    {canonical_session_id:'session:native-linked',native_host_id:'fresh',display_name:'Native-linked builder'},
    {canonical_session_id:'session:unrelated',latest_attempt_ref:'attempt:other',display_name:'Unrelated builder'},
  ]});
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Attempt-linked builder'));
  assert.match(await page.locator('#workSessionList').textContent(),/Native-linked builder/);
  assert.doesNotMatch(await page.locator('#workSessionList').textContent(),/Unrelated builder/);
});

test('native adapter reference joins its exact producer host id',async t=>{
  const {page}=await open(t,{path:'/control-room/progress/work?board=demo-project&session=native:codex:host-linked',sessions:[
    {canonical_session_id:'session:host-linked',native_host_id:'host-linked',display_name:'Host-bound builder'},
    {canonical_session_id:'session:unrelated',native_host_id:'other-host',display_name:'Other host'},
  ]});
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Host-bound builder'));
  assert.doesNotMatch(await page.locator('#workSessionList').textContent(),/Other host/);
});

test('late Engineering success stays withheld after another protected read loses authentication',async t=>{
  let release,started=false;const gate=new Promise(resolve=>release=resolve);
  const {page,state}=await open(t,{rpcReply:async(rpc,payload)=>{if(rpc.name==='engineering-passport'){started=true;await gate;}return payload;}});
  await assertEventually(()=>started);state.authLost=true;await page.clock.runFor(5100);
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Sign in');
  release();await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await page.locator('.passport-card').count(),0);
  for(const id of ['workCanonicalBody','workReviewList','workDotList'])assert.match(await page.locator('#'+id).textContent(),/Sign in/);
  assert.equal(await page.locator('#workTitle').textContent(),'Work detail');
});

test('latest session lookup wins and refresh retains its query',async t=>{
  const {page,state,calls}=await open(t);
  await page.waitForSelector('[data-session-id="session:fresh"]');
  let release, oldStarted=false;
  const old=new Promise(resolve=>release=resolve);
  state.rpcReply=async (rpc,payload)=>{
    if(rpc.name!=='read-session-identity')return payload;
    if(rpc.arguments.query==='old'){oldStarted=true;await old;}
    return {sessions:[{canonical_session_id:`session:${rpc.arguments.query || 'default'}`,display_name:`Result ${rpc.arguments.query || 'default'}`}],permission_filtered:false};
  };
  await page.locator('#workSessionQuery').fill('old');await page.locator('#workSessionSearch').evaluate(form=>form.requestSubmit());
  await assertEventually(()=>oldStarted);
  await page.locator('#workSessionQuery').fill('new');await page.locator('#workSessionSearch').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Result new'));
  release();await new Promise(resolve=>setTimeout(resolve,100));
  assert.doesNotMatch(await page.locator('#workSessionList').textContent(),/Result old/);
  await page.clock.runFor(5100);await assertEventually(()=>calls.filter(call=>call.name==='read-session-identity'&&call.arguments.query==='new').length>=2);
  assert.match(await page.locator('#workSessionList').textContent(),/Result new/);
});

for (const stalled of ['engineering-passport','read-session-identity'])test(`stalled ${stalled} expires, labels evidence stale and resumes refresh`,async t=>{
  let stalledReads=0;
  const never=new Promise(()=>{});
  const {page,calls}=await open(t,{rpcReply:(rpc,payload)=>rpc.name===stalled?(stalledReads++,never):payload});
  await assertEventually(()=>stalledReads>0);
  await page.clock.runFor(11000);
  await page.waitForFunction(()=>document.querySelector('#workReadState').dataset.state==='stale');
  assert.match(await page.locator('#workReadState').textContent(),/unavailable|stale/i);
  await page.clock.runFor(55000);
  await assertEventually(()=>calls.filter(call=>call.name==='read-progress-board').length>1);
});

test('stalled queue expires and recovers instead of remaining live',async t=>{
  const {page,state}=await open(t);await page.waitForSelector('.queue-card',{state:'attached'});
  state.queueWait=new Promise(()=>{});
  await page.clock.runFor(5100);await assertEventually(()=>state.queueReads>1);
  await page.clock.runFor(11000);
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Offline');
  state.queueWait=null;
  await page.clock.runFor(5100);
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Live');
});

test('concurrent Earlier dispatches clicks append one stable event and preserve cursor',async t=>{
  const {page,state,calls}=await open(t);await page.waitForSelector('[data-session-id="session:fresh"]');
  await page.locator('[data-session-id="session:fresh"]').click();await page.waitForFunction(()=>!document.querySelector('#workDispatchMore').hidden);
  let release, pending=0;const gate=new Promise(resolve=>release=resolve);
  state.rpcReply=async(rpc,payload)=>{if(rpc.name==='read-dispatch-history'&&rpc.arguments.cursor){pending++;await gate;return {...payload,events:[...payload.events,...payload.events]};}return payload;};
  await page.locator('#workDispatchMore').evaluate(button=>{button.click();button.click();});
  await assertEventually(()=>pending>0);
  t.after(()=>release());
  const actedEvent=page.locator('#workDispatchHistory .work-record > h3').filter({hasText:/^acted$/});
  assert.equal(await actedEvent.count(),0);
  assert.equal(await page.locator('#workDispatchMore').isDisabled(),true);
  assert.equal(calls.filter(call=>call.name==='read-dispatch-history'&&call.arguments.cursor==='synthetic-cursor').length,1);
  release();
  await actedEvent.waitFor({state:'visible'});
  assert.equal(await actedEvent.count(),1);
  assert.equal(await page.locator('#workDispatchMore').isVisible(),false);
});

test('fresh queue absence removes projected task metadata and sequence binding',async t=>{
  const {page,state}=await open(t,{rpcReply:(rpc,payload)=>rpc.name==='read-progress-board'?{...payload,snapshot:{...payload.snapshot,snapshot_json:{title:'Demo project',tasks:{}}}}:payload});
  await page.clock.runFor(5100);await page.waitForFunction(()=>document.querySelector('#workMetadata').textContent.includes('Projected task'));
  state.queueEmpty=true;
  await page.clock.runFor(5100);await assertEventually(()=>state.queueReads>=3);
  await page.clock.runFor(5100);await page.waitForFunction(()=>!document.querySelector('#workMetadata').textContent.includes('Projected task'));
  assert.doesNotMatch(await page.locator('#workTitle').textContent(),/Demo research/);
  assert.doesNotMatch(await page.locator('#workMetadata').textContent(),/Demo research/);
  assert.equal(await page.locator('#queueLive').textContent(),'Live');
  state.turns.push({seq:100,msg_id:'removed-binding',seat:'dot',kind:'turn',at:NOW.toISOString(),body:'Unrelated task after removal'});
  await page.clock.runFor(5100);
  assert.doesNotMatch(await page.locator('#workDotList').textContent(),/Unrelated task after removal/);
});

test('late canonical binding restores receipts discarded before the rescan',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const {page,state}=await open(t,{rpcReply:async(rpc,payload)=>{if(rpc.name==='engineering-passport')await gate;return payload;}});
  await assertEventually(()=>state.turnReads>=1);
  for(let poll=0;poll<6;poll++){
    for(let i=0;i<500;i++)state.turns.push({seq:state.turns.at(-1).seq+1,msg_id:`late-${poll}-${i}`,kind:'turn',seat:'human',at:NOW.toISOString(),body:'Unrelated synthetic retained-window turn'});
    const before=state.turnReads;await page.clock.runFor(5100);await assertEventually(()=>state.turnReads>before);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await page.locator('.passport-card').count(),0);
  release();await page.clock.runFor(16000);
  await page.waitForFunction(()=>document.querySelector('#workCanonicalBody').textContent.includes('Closure: blocked'));
  await page.clock.runFor(5100);await page.waitForSelector('.passport-card');
  assert.match(await page.locator('.passport-card').textContent(),/Grounding/);
});

test('board → project → task preview → work detail retains breadcrumbs to the parent',async t=>{
  const {page,errors}=await open(t,{path:'/control-room/progress'});
  await page.locator('[data-board-id="demo-project"]').click();
  await page.waitForURL('**/control-room/progress?board=demo-project');
  await page.locator(`.board-card[data-card-id="${taskId}"]`).first().click();
  await page.getByRole('link',{name:'Open work detail'}).click();
  await page.waitForURL('**/control-room/progress/work?**');
  await page.waitForFunction(()=>document.querySelector('#workTitle').textContent==='Demo work detail');
  await page.locator('#workBreadcrumbs a').nth(1).click();
  await page.waitForURL('**/control-room/progress?board=demo-project');assert.deepEqual(errors,[]);
});

test('task detail exposes sessions, reviews, Dot jobs, dispatch pages and every Passport section',async t=>{
  const {page,errors,calls}=await open(t);
  await page.waitForSelector('.passport-card');
  for(const selector of ['.passport-staffing','.passport-map','.passport-alignment','.passport-timeline','.passport-telemetry','.passport-eval','.passport-eval-matrix','.passport-eval-frontier','.passport-home-zone','.passport-spatial-list','.passport-engineering','.passport-detail']) assert.ok(await page.locator(selector).count(),selector);
  for(const label of ['Grounding','Route & Agent Topology','Evaluation & Outcome','Learning'])assert.ok((await page.locator('.passport-card').textContent()).includes(label),label);
  await page.getByRole('button',{name:'Show semantic detail'}).click();assert.equal(await page.locator('.passport-home-detail').count(),1);
  await page.locator('.passport-node').first().click();assert.equal(await page.locator('.passport-detail').getAttribute('open'),'');
  await page.locator('.passport-home-action').first().click();assert.equal(await page.locator('.passport-work').evaluate(node=>node===document.activeElement),true);
  await page.waitForFunction(()=>document.querySelector('#workSessionList').textContent.includes('Demo builder'));
  assert.doesNotMatch(await page.locator('#workSessionList').textContent(),/Other builder/);
  await page.locator('[data-session-id="session:fresh"]').click();await page.waitForFunction(()=>!document.querySelector('#workDispatchMore').hidden);
  await page.locator('#workDispatchMore').click();await page.waitForFunction(()=>document.querySelector('#workDispatchHistory').textContent.includes('acted'));
  await page.clock.runFor(5100);assert.match(await page.locator('#workDispatchHistory').textContent(),/acted/);
  assert.match(await page.locator('#workReviewList').textContent(),/slice:a|Fix round/);
  assert.match(await page.locator('#workDotList').textContent(),/Demo research/);
  assert.match(await page.locator('#workCanonicalBody').textContent(),/Closure: blocked/);
  assert.match(await page.locator('.passport-telemetry').textContent(),/actual.*unavailable.*estimate|actual.*estimate.*unavailable/);
  assert.match(await page.locator('.passport-card').textContent(),/Canonical learning lifecycle: proposed/);
  await page.locator('#railToggle').click();assert.match(await page.locator('#sessionList').textContent(),/82%/);assert.equal(await page.locator('.session-row.is-stale').count(),1);
  await page.locator('#viewEverything').click();assert.doesNotMatch(await page.locator('#wireFeed').textContent(),/Unrelated synthetic task/);
  assert.ok(calls.some(call=>call.name==='work-request-card'));assert.ok(calls.some(call=>call.name==='engineering-passport'));assert.deepEqual(errors,[]);
});

test('shared activity retains stage, desks, presence, wire filters, composers and queue controls',async t=>{
  const {page,state,errors,posts}=await open(t,{path:'/control-room/progress/work?board=demo-project&view=tasks',width:390});
  await page.waitForSelector('.stage-node');
  await page.clock.runFor(1000);
  assert.ok(await page.locator('.stage-node.is-moon').count());assert.ok(await page.locator('.stage-node-worker').count());
  await page.locator('#viewEverything').click();
  const stageNode=page.locator('.stage-node[data-node="desk:Synthetic desk"]');
  await stageNode.dispatchEvent('pointerenter');assert.equal(await page.locator('#stageTooltip').isVisible(),true);
  assert.ok(await page.locator('#wireFeed .is-highlight').count());await stageNode.dispatchEvent('pointerleave');
  await stageNode.press('Enter');assert.equal(await page.locator('#seatChips').getByRole('button',{name:'codex',exact:true}).getAttribute('aria-pressed'),'true');
  await stageNode.press('Enter');
  await page.locator('#queueStatus').selectOption('running');assert.equal(await page.locator('.queue-card').count(),0);
  await page.locator('#queueStatus').selectOption('');await page.locator('#queueTarget').selectOption('dot');assert.equal(await page.locator('.queue-card').count(),1);
  for(const id of ['stageSvg','roomDesks','roomPresence','roomHealth','sessionList','assignmentList','wireFeed','viewConversation','viewEverything','kindTurns','kindSystem','kindReceipts','kindHeartbeats','wireSearch','wireResume','roomComposer','queueColumns','queueTarget','queueStatus','queueComposer'])assert.equal(await page.locator(`#${id}`).count(),1,id);
  await page.locator('#desksToggle').click();await page.locator('#desksToggle').click();
  await page.locator('#desksToggle').click();await page.locator('.desk-card .assignment-badge').click();
  assert.equal(posts[0].body.control.action,'login');assert.equal(posts[0].body.control.desk,'Synthetic desk');
  await page.locator('#viewEverything').click();await page.locator('#kindReceipts').click();assert.equal(await page.locator('#kindReceipts').getAttribute('aria-pressed'),'false');await page.locator('#kindReceipts').click();
  await page.locator('#wireSearch').fill('Unrelated');assert.match(await page.locator('#wireFeed').textContent(),/Unrelated synthetic task/);await page.locator('#wireSearch').fill('');
  await page.locator('#composerInput').fill('Synthetic room draft');await page.locator('#composerInput').press('Shift+Enter');await page.locator('#composerInput').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#composerInput').value==='');
  await page.locator('#enqueueTitle').fill('Demo enqueue');await page.locator('#queueComposer button').click();await page.waitForFunction(()=>document.querySelector('#queueNotice').textContent.includes('submitted'));
  assert.equal(posts.length,3);assert.ok(posts.every(post=>post.csrf==='synthetic-csrf'));assert.equal(posts[2].body.body,'@queue enqueue target=sol cap=read :: Demo enqueue');
  await page.clock.runFor(5100);await assertEventually(()=>state.queueReads>1 && state.turnReads>1);
  await page.locator('.queue-card').click();await page.waitForURL('**/control-room/progress/work?board=demo-project&task=**');assert.deepEqual(errors,[]);
});

test('baseline Observatory controls all remain mounted in layer 3',async()=>{
  const before=await readFile(new URL('../_to_delete/room.html',import.meta.url),'utf8');
  const after=await readFile(new URL('../progress-work.html',import.meta.url),'utf8');
  const ids=source=>[...source.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);
  const relocated=new Set(['openTaskBoard','taskBoardDialog','taskBoardTitle','closeTaskBoard']);
  assert.deepEqual(ids(before).filter(id=>!relocated.has(id)&&!ids(after).includes(id)),[]);
  assert.match(after,/id="workTasks"/);assert.match(after,/id="queueColumns"/);
});

test('older task passports survive the current global wire window',async t=>{
  const {page,state,errors}=await open(t,{history:2000});
  await page.waitForSelector('.passport-card');assert.ok(state.turnReads>=11);
  assert.match(await page.locator('#workDotList').textContent(),/Observed Dot turn/);
  await page.locator('#viewEverything').click();assert.doesNotMatch(await page.locator('#wireFeed').textContent(),/Unrelated synthetic historical/);
  for(let i=0;i<2000;i++)state.turns.push({seq:state.turns.at(-1).seq+1,msg_id:`later-${i}`,kind:'turn',seat:'human',at:NOW.toISOString(),body:`Unrelated synthetic later turn ${i}`});
  await page.clock.runFor(5100);await page.waitForSelector('.passport-card');
  assert.deepEqual(errors,[]);
});

test('wire and queue polling switch between visible and hidden cadence',async t=>{
  const {page,state}=await open(t);await page.waitForSelector('.passport-card');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const hidden={queue:state.queueReads,wire:state.turnReads};await page.clock.runFor(6000);
  assert.equal(state.queueReads,hidden.queue);assert.equal(state.turnReads,hidden.wire);
  await page.clock.runFor(25000);await page.waitForFunction(()=>document.querySelector('#queueSync').textContent.startsWith('Synced'));
  await assertEventually(()=>state.queueReads>hidden.queue && state.turnReads>hidden.wire);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  const visible=state.queueReads;await page.clock.runFor(5100);await assertEventually(()=>state.queueReads>visible);
});

test('malformed and conflicting Passport updates stay withheld in task detail',async t=>{
  const {page,state,errors}=await open(t);await page.waitForSelector('.passport-card');
  const conflict=structuredClone(fixture.projection);conflict.source_state.canonical_record_digest='sha256:'+'b'.repeat(64);
  const add=payload=>state.turns.push({seq:state.turns.at(-1).seq+1,msg_id:`conflict-${state.turns.length}`,kind:'receipt',at:NOW.toISOString(),sponsor:'joe',seat:'codex',body:JSON.stringify({job_passport:{schema_version:'job-passport-wire.v1',kind:'observatory_projection',payload}})});
  add(conflict);add({work_request_id:fixture.projection.work_request_id});await page.clock.runFor(5100);
  await page.waitForFunction(()=>document.querySelector('.passport-card').dataset.status==='unknown_partial');
  assert.match(await page.locator('#jobPassportSummary').textContent(),/withheld/);assert.deepEqual(errors,[]);
});

test('wire history, pause, missed-count and Resume live work through the new page',async t=>{
  const {page,state,errors}=await open(t,{path:'/control-room/progress/work?board=demo-project'});
  await page.locator('#viewEverything').click();
  for(let seq=16;seq<=515;seq++)state.turns.push({seq,msg_id:`history-${seq}`,at:NOW.toISOString(),sponsor:'joe',seat:'human',kind:'turn',body:`Synthetic history turn ${seq}`});
  await page.clock.runFor(5100);await page.waitForSelector('.wire-earlier');
  await page.locator('#wireFeed').evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
  state.turns.push({seq:516,msg_id:'history-new',at:NOW.toISOString(),sponsor:'joe',seat:'human',kind:'turn',body:'Synthetic latest turn'});
  await page.clock.runFor(5100);await page.waitForFunction(()=>document.querySelector('#wireResume').textContent.includes('new'));
  await page.locator('.wire-earlier').click();await page.waitForFunction(()=>document.querySelector('#wireFeed').textContent.includes('Synthetic history turn 157'));
  await page.locator('#wireResume').click();await page.waitForFunction(()=>document.querySelector('#wireFeed').textContent.includes('Synthetic latest turn'));
  assert.deepEqual(errors,[]);
});

test('composer failure offers draft restoration and preserves the 20k cap',async t=>{
  const {page,state,errors}=await open(t);state.postFailure=true;
  await page.locator('#composerInput').fill('Synthetic failed draft');await page.locator('#composerInput').press('Enter');
  await page.locator('#roomToast button').click();assert.equal(await page.locator('#composerInput').inputValue(),'Synthetic failed draft');
  await page.locator('#composerInput').fill('x'.repeat(20001));assert.equal(await page.locator('#composerSend').isDisabled(),true);assert.deepEqual(errors,[]);
});

for(const width of [320,390,1440])test(`work detail has no horizontal scroll at ${width}px and respects reduced motion`,async t=>{
  const {page,errors}=await open(t,{width});await page.waitForSelector('.passport-card');
  await page.clock.runFor(1000);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#roomWireSection')).opacity==='1');
  if(process.env.PROGRESS_CAPTURE) {
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.screenshot({path:`out/progress-work-${width}.png`,fullPage:true});
    await page.locator('#roomWireSection').scrollIntoViewIfNeeded();
    await page.screenshot({path:`out/progress-wire-${width}.png`});
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('#composerSend').evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.work-flow line').first().evaluate(node=>getComputedStyle(node).animationName),'none');assert.deepEqual(errors,[]);
});

test('empty, stale and offline states stay legible without inventing work',async t=>{
  const {page,state,errors}=await open(t,{empty:true,stale:true,path:'/control-room/progress/work?board=demo-project&view=tasks'});
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Stale');
  assert.match(await page.locator('#workSessionList').textContent(),/No linked native session/);assert.match(await page.locator('#jobPassportSummary').textContent(),/No validated Job Passport/);
  assert.match(await page.locator('#workReviewList').textContent(),/No linked review/);assert.match(await page.locator('#workReadState').textContent(),/Stale publication/);
  state.offline=true;await page.clock.runFor(5100);await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Offline');assert.match(await page.locator('#roomBanner').textContent(),/last-known/);assert.deepEqual(errors,[]);
});

test('confirmed authentication loss clears protected queue and work evidence',async t=>{
  const {page,state,errors}=await open(t);
  await page.waitForSelector('.queue-card',{state:'attached'});await page.waitForSelector('.passport-card');await page.waitForSelector('[data-session-id="session:fresh"]');
  await page.locator('[data-session-id="session:fresh"]').click();await page.waitForFunction(()=>!document.querySelector('#workDispatchMore').hidden);
  state.authLost=true;await page.clock.runFor(5100);
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Sign in');
  assert.equal(await page.locator('.queue-card').count(),0);
  for(const id of ['workSessionList','workDispatchHistory','workReviewList','workDotList'])assert.match(await page.locator('#'+id).textContent(),/Sign in/);
  assert.equal(await page.locator('#workDispatchMore').isVisible(),false);
  await page.clock.runFor(11000); // successful independent wire reads must remain withheld
  assert.equal(await page.locator('.passport-card,.stage-node-worker,.desk-card,.assignment-row,.session-row').count(),0);
  for(const id of ['wireFeed','jobPassportList','roomDesks','assignmentList','sessionList','stageTooltip'])assert.doesNotMatch(await page.locator('#'+id).textContent(),/Demo|Synthetic desk|Fix round/);
  assert.doesNotMatch(await page.locator('#workTitle').textContent(),/Demo/);
  assert.doesNotMatch(await page.locator('#workBreadcrumbs').textContent(),/demo-project|Demo/);
  assert.doesNotMatch(await page.title(),/Demo/);
  state.authLost=false;await page.clock.runFor(11000);
  await page.waitForSelector('.passport-card');
  await page.waitForFunction(()=>document.querySelector('#workTitle').textContent==='Demo work detail');
  for(const id of ['roomStage','figCycle','figBridge','figDesks'])assert.equal(await page.locator('#'+id).evaluate(node=>node.hidden),false);
  assert.deepEqual(errors,[]);
});

for(const [old,view] of [['/room.html','wire'],['/queue.html','tasks'],['/control-room/agents/queue','tasks'],['/agent-room','wire']])test(`legacy deep link ${old} opens matching Progress view`,async t=>{
  const {page}=await open(t,{path:`${old}?board=demo-project&task=${taskId}#jobPassport`});const url=new URL(page.url());assert.equal(url.pathname,'/control-room/progress/work');assert.equal(url.searchParams.get('view'),view);assert.equal(url.searchParams.get('task'),taskId);assert.equal(url.hash,'#jobPassport');
});


test('published task detail retains summary, model, safe PR links and related answers', async t => {
  const {page,errors} = await open(t,{rpcReply:(rpc,payload)=>{
    if(rpc.name !== 'read-progress-board')return payload;
    payload.snapshot.snapshot_json.tasks[taskId] = {title:'Synthetic detail',status:'running',work_request:'WR-900',summary:'Synthetic task summary.',executor:'Codex gpt-6-sol high',
      repo:'demo/example',pr:12,pr_head:'a'.repeat(40),pr_links:[{repo:'demo/other',number:3,head_sha:'b'.repeat(40)},{repo:'invalid',number:4}],
      evidence:'https://example.com/synthetic-evidence',question_ids:['synthetic-choice'],stage_history:[{stage:'build',status:'running',at:NOW.toISOString()}]};
    payload.questions=[{question_id:'synthetic-choice',prompt:'Synthetic choice?',answer_text:'Proceed with synthetic fixture',status:'Applied'},
      {question_id:'unrelated',prompt:'Unrelated question',answer_text:'Unrelated answer'}];return payload;
  }});
  await page.waitForFunction(()=>document.querySelector('#workMetadata').textContent.includes('Demo work request'));
  const detail=page.locator('#workMetadata');
  assert.match(await detail.textContent(),/Codex.*gpt-6-sol.*high/s);
  assert.equal(await detail.locator('a[href="https://github.com/demo/example/pull/12"]').count(),1);
  assert.equal(await detail.locator('a[href="https://github.com/demo/other/pull/3"]').count(),1);
  assert.equal(await detail.locator('a[href="https://example.com/synthetic-evidence"]').count(),1);
  assert.match(await detail.textContent(),/Synthetic choice.*Proceed with synthetic fixture.*Stage history/s);
  assert.doesNotMatch(await detail.textContent(),/Unrelated answer/);
  assert.deepEqual(errors,[]);
});
