import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import routes from '../contracts/app-routes.v1.json' with {type:'json'};
import fixture from './fixtures/progress-work.synthetic.json' with {type:'json'};
import { scopedTurn, workScope, workDetailUrl } from '../js/progress-work-model.js';
import { passportProjectionDigest } from '../js/job-passport.js';

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
async function open(t,{width=390,path=taskPath,empty=false,stale=false,history=0}={}) {
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:900}}); page.setDefaultTimeout(7000); await page.clock.install({time:NOW});
  const errors=[],calls=[],posts=[]; page.on('pageerror',error=>errors.push(error.message));
  const state={offline:false,authLost:false,postFailure:false,turns:empty?[]:receipts(),queueReads:0,turnReads:0};
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
      const payload=rpc.name==='read-progress-board'?{ok:true,snapshot:{board_id:rpc.arguments.board_id,version:1,updated_at:stale?'2026-08-20T12:00:00Z':NOW.toISOString(),snapshot_json:{title:rpc.arguments.board_id==='carr-v5'?'System progress':'Demo project',tasks:empty?{}:{[taskId]:{title:'Demo work detail',status:'review',work_request:'WR-900'}}}},questions:[]}
        :rpc.name==='list-progress-boards'?{schema:'progress-board-directory.v1',boards:[{board_id:'carr-v5',title:'System progress',updated_at:NOW.toISOString(),task_counts:{}},{board_id:'demo-project',title:'Demo project',updated_at:NOW.toISOString(),task_counts:{review:1}}]}
        :rpc.name==='read-session-identity'?{sessions:empty?[]:[{canonical_session_id:'session:fresh',display_name:'Demo builder',surface:'codex',work_state:'working'},{canonical_session_id:'session:other',display_name:'Other builder',surface:'codex'}],permission_filtered:false}
        :rpc.name==='read-dispatch-history'?{events:[{stage:rpc.arguments.cursor?'acted':'sent',evidence:'synthetic dispatch',session_id:'session:fresh',attempt_ref:'attempt:a',work_request_ref:taskId}],more:!rpc.arguments.cursor,next_cursor:rpc.arguments.cursor?null:'synthetic-cursor'}
        :rpc.name==='engineering-passport'?(()=>{const read={...fixture.engineering,current_receipts:fixture.engineering.receipts,current_reviewer_facts:fixture.engineering.reviewer_facts};read.projection_digest=passportProjectionDigest(read);return read;})()
        :rpc.name==='work-request-card'?{ok:true,human_ref:'WR-900',title:'Demo work request',state:'needs_revision',version:1,desired_outcome:'Synthetic acceptance',acting_identity:[{act:'review',performed_by:'actor:builder'}]}
        :rpc.name==='unfinished-work'?{schema:'unfinished-work.v1',items:[],coverage:[],census_complete:true}:{};
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
      const events=empty?[]:[{v:1,board:'carr-build',event_id:1,event:'created',task_id:taskId,card:{title:'Demo research',target:'dot',effective_model:'Synthetic researcher',status:'ready',priority:'P1',cap:'read',updated_at:NOW.toISOString(),source_seq:8},summary:'Synthetic research job',projected_at:NOW.toISOString()}];
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

test('exact work references never join similar titles or shared seats',()=>{
  const scope=workScope('?task=t_demo');
  assert.equal(scopedTurn({body:'t_demo-more',seat:'codex'},scope),false);
  assert.equal(scopedTurn({body:'Same title',seat:'codex'},scope),false);
  assert.equal(scopedTurn({body:'Review t_demo.',seat:'codex'},scope),true);
  assert.equal(scopedTurn({body:JSON.stringify({job_passport:{payload:{work_request_id:'t_demo'}}})},scope),true);
  assert.match(workDetailUrl({board:'demo',task:'t_demo'}),/board=demo&task=t_demo/);
});

test('board → project → task uses one tap each and breadcrumbs return to the parent',async t=>{
  const {page,errors}=await open(t,{path:'/control-room/progress'});
  await page.locator('[data-board-id="demo-project"]').click();
  await page.waitForURL('**/control-room/progress?board=demo-project');
  await page.locator(`[data-task-id="${taskId}"]`).first().click();
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
  await page.clock.runFor(5100);assert.ok(state.queueReads>1);assert.ok(state.turnReads>1);
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
  const {page,state,errors}=await open(t,{path:'/control-room/progress/work?board=demo-project&view=tasks'});
  await page.waitForSelector('.queue-card');await page.waitForSelector('[data-session-id="session:fresh"]');
  await page.locator('[data-session-id="session:fresh"]').click();await page.waitForFunction(()=>!document.querySelector('#workDispatchMore').hidden);
  state.authLost=true;await page.clock.runFor(5100);
  await page.waitForFunction(()=>document.querySelector('#queueLive').textContent==='Sign in');
  assert.equal(await page.locator('.queue-card').count(),0);
  for(const id of ['workSessionList','workDispatchHistory','workReviewList','workDotList'])assert.match(await page.locator('#'+id).textContent(),/Sign in/);
  assert.equal(await page.locator('#workDispatchMore').isVisible(),false);assert.deepEqual(errors,[]);
});

for(const [old,view] of [['/room.html','wire'],['/queue.html','tasks'],['/control-room/agents/queue','tasks'],['/agent-room','wire']])test(`legacy deep link ${old} opens matching Progress view`,async t=>{
  const {page}=await open(t,{path:`${old}?board=demo-project&task=${taskId}#jobPassport`});const url=new URL(page.url());assert.equal(url.pathname,'/control-room/progress/work');assert.equal(url.searchParams.get('view'),view);assert.equal(url.searchParams.get('task'),taskId);assert.equal(url.hash,'#jobPassport');
});
