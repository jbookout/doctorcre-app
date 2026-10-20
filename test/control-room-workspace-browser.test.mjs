import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,waitForAsync} from './browser-harness.mjs';
import {createFixtureClient} from '../js/fixture-client.js';
import axe from 'axe-core';
import hierarchy from './fixtures/progress-board-hierarchy.json' with {type:'json'};
import {atlasFixtureResponse} from '../scripts/atlas-fixture.mjs';
import { routeContract as routes } from "../js/routes.js";
import { BOARD_ROUTE, boardIdFromPath } from '../js/progress-board-route.js';
const root=new URL('../',import.meta.url);
const reads={'list-feature-switches':'listFeatureSwitches','list-doc-suggestions':'listDocSuggestions','read-progress-board':'readProgressBoard','list-progress-boards':'listProgressBoards','unfinished-work':'unfinishedWork','incident-board':'incidentBoard','governance-queue':'governanceQueue','schedule-board':'scheduleBoard','work-request-card':'workRequestCard','deal-room-board':'getBoard','today-triage':'todayTriage','notification-feed':'notificationFeed','read-room-queue':'roomQueue','read-room':'roomTurns','read-session-identity':'sessionIdentity','list-my-codex-sessions':'codexSessions','current-work-item':'currentWorkItem','list-notifications':'listNotifications'};
async function open(t,{width=1440,height=width===1440?1000:844,path='/control-room?mode=live&tab=boards',connectionsBad=false,countIncidentClicks=false,unboundBoard=false,boardUnpublished=false,emptyIncidents=false,extraBoard=false,theme='dark',snapshotData}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height},timezoneId:'UTC',reducedMotion:'reduce'});
 await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
 if(countIncidentClicks)await page.addInitScript(()=>{
  window.incidentClickCallbacks={filters:0,incidents:0};
  const add=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type,listener,options){
   const kind=type==='click'&&this instanceof Element
    ?this.matches('#severityChips, #severityChips [data-severity]')?'filters'
     :this.matches('#incidentGroups, #incidentGroups [data-incident]')?'incidents':null
    :null;
   return add.call(this,type,kind&&typeof listener==='function'?function(event){
    window.incidentClickCallbacks[kind]++;
    return listener.call(this,event);
   }:listener,options);
  };
 });
 await page.clock.install({time:new Date('2026-10-02T12:00:00Z')});
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 const errors=[],calls=[];const state={pr:17,title:'Demo dashboard refresh',spend:12.34,denied:false,approvalFailure:null,incidentState:'investigating',removeJobs:false,connectionsBad,dealStates:false,liveItems:[],boardFailure:null,scheduleFailure:false,scheduleUnknown:false,partialSchedule:false,duplicateJobs:false,bindingOnly:false,boardUnpublished,emptyAgents:false,emptySessions:false};page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/mcp'){
   const rpc=request.postDataJSON().params;calls.push(rpc.name);if(state.denied)return route.fulfill({status:401,body:'{}'});
   if(rpc.name==='read-progress-board'&&state.boardFailure)return route.fulfill({status:state.boardFailure,body:'{}'});
   if(rpc.name==='schedule-board'&&state.scheduleFailure)return route.fulfill({status:503,body:'{}'});
   if(rpc.name==='governance-queue'&&state.approvalFailure==='http')return route.fulfill({status:503,body:'{}'});
   let payload={};if(snapshotData&&rpc.name==='work-request-card')payload={ok:true,human_ref:rpc.arguments.work_request};
   else if(reads[rpc.name]&&fixture[reads[rpc.name]])payload=await fixture[reads[rpc.name]](rpc.arguments);
   if(rpc.name==='read-room-queue'&&state.emptyAgents)payload={ok:true,room:'partner-line',live:false,projected_at:null,events:[]};
   if(rpc.name==='read-session-identity'&&state.emptySessions)payload={ok:true,total_seen:0,total_returned:0,permission_filtered:false,sessions:[]};
   if(rpc.name==='governance-queue'&&state.approvalFailure==='invalid')payload={ok:true};
   if(rpc.name==='read-progress-board'&&snapshotData)payload.snapshot.snapshot_json=snapshotData;
   if(rpc.name==='read-progress-board'&&unboundBoard&&payload.snapshot)for(const task of Object.values(payload.snapshot.snapshot_json.tasks)){delete task.work_request;delete task.work_request_ref;delete task.human_ref;task.related=[];}
   if(rpc.name==='list-progress-boards'&&extraBoard)payload.boards.push({...payload.boards[0],board_id:'demo-project',title:'Demo project board'});
   if(rpc.name==='read-progress-board'&&state.boardUnpublished)payload.snapshot=null;
   if(rpc.name==='incident-board'){if(emptyIncidents)Object.assign(payload,{incidents:[],count:0,by_severity:{},ready_to_close:0});else payload.incidents[0].state=state.incidentState;}
   if(rpc.name==='schedule-board'&&state.scheduleUnknown){payload.overall_state='unknown';payload.jobs=[];payload.sources=payload.sources.map(row=>({...row,state:'unknown',count:null}));}
   if(rpc.name==='schedule-board'&&state.partialSchedule){payload.jobs=payload.jobs.filter(job=>job.owner===payload.sources[0].owner);payload.sources=payload.sources.map((source,i)=>i===0?source:{...source,state:'unknown',count:null});}
   if(rpc.name==='schedule-board'&&state.duplicateJobs){payload.jobs=payload.jobs.map((job,i)=>({...job,key:'same',next_due_at:payload.jobs[0].next_due_at,next_due_basis:payload.jobs[0].next_due_basis}));}
   if(rpc.name==='schedule-board'&&state.removeJobs){payload.jobs=[];payload.sources=payload.sources.map(source=>({...source,state:'unknown',count:null}));}
   if(rpc.name==='deal-room-board'&&state.dealStates)payload={...payload,actor:'joe',deals:['active','closed','inactive','completed'].map((state,i)=>({id:`demo-deal-${i}`,name:`Demo ${state}`,owner:'joe',attention:true,next_step:'Confirm synthetic step',next_date:'2026-09-30',phase:state==='closed'?'closed':'pending',operating_state:['active','closed'].includes(state)?'active':state}))};
   if(rpc.name==='unfinished-work'&&state.bindingOnly)for(const row of payload.items||[]){row.work_request_ref='WR-000999';row.human_ref=null;row.work_request=null;row.related=[];row.pr_url='https://github.com/example/demo/pull/88';row.pr=null;}
   if(rpc.name==='unfinished-work')for(const row of payload.items||[]){row.pr=state.pr;row.title=state.title;if(state.cardDetails)Object.assign(row,{summary:"Keep distinct acceptance details.",provider:"OpenAI",model:"gpt-6-sol",effort:"high"});}
   if(rpc.name==='unfinished-work'&&extraBoard)payload.items.forEach((row,i)=>row.repo=i%2?'example/second-project':'example/demo');
   if(rpc.name==='unfinished-work'&&rpc.arguments.live_library)payload.items=state.liveItems;
   if(rpc.name==='read-resource-dashboard'){payload=await fixture.readResourceDashboard();payload.connections=await fixture.readConnections();payload.connections.providers[0].spend.amount=state.spend;if(state.connectionsBad){payload.connections.providers.push(null);payload.connections.devices.items.push(null);}}
   if(rpc.name==='work-request-card')payload.desired_outcome='Demo acceptance summary';
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}})});
  }
  if(url.pathname==='/api/v1/atlas-graph'){const result=atlasFixtureResponse(url,'GET');
   if(state.largeAtlas&&!url.searchParams.has('layer')&&!url.searchParams.has('q')){
    const payload=result.body,verb=payload.nodes.find(node=>node.class==='verb');
    const extra=Array.from({length:500-payload.nodes.length},(_,i)=>({...verb,id:`verb:demo-extra-${i}`,key:`demo-extra-${i}`,unlinked:true}));
    payload.nodes.push(...extra);payload.index.declared.verb.push(...extra.map(node=>node.id));payload.limit=500;
    payload.coverage.find(row=>row.source_ref==='mcp-server/src/tools.js').node_count+=extra.length;
   }
   if(state.longAtlasLabels&&result.body.nodes?.[0])Object.assign(result.body.nodes[0],{key:'demo-accept-portfolio-revision',title:'Demo human-only review: accept one exact immutable portfolio revision and preserve its current approval history.'});return route.fulfill({status:result.status,contentType:'application/json',body:JSON.stringify(result.body)});}
  if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-test-token'})});
  if(url.pathname==='/app-release'&&state.denied)return route.fulfill({status:503,body:'{}'});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
  const file=routes.routes[boardIdFromPath(url.pathname)?BOARD_ROUTE:url.pathname]||url.pathname.slice(1);
  try{const body=await readFile(new URL(file,root));return route.fulfill({body,contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(`http://localhost${path}`);
 await page.waitForFunction(()=>document.querySelector('#selfAvatar')?.textContent==='J');
 if(new URL(page.url()).pathname==='/control-room')await waitForRoom(page);
 else await page.locator('.hierarchy-breadcrumbs').waitFor();
 return {page,state,calls,errors};
}
// Polls finish over the network after virtual time stops. Await the complete
// room read before advancing again, so the next timer is already scheduled.
async function waitForRoom(page, after=0) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const ready=await page.evaluate(async after=>{const {view}=await import('/js/control-room.js');return view.status==='ready'&&view.sequence>after;},after);
  if(ready)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Control Room read did not settle');
}
async function advanceRoom(page, ms) {
 await waitForRoom(page);
 const sequence=await page.evaluate(async()=> (await import('/js/control-room.js')).view.sequence);
 await page.clock.runFor(ms);
 await waitForRoom(page,sequence);
}
// The V2 section nav lives in the workspace sidebar, which is a drawer on a phone.
async function section(page,id){const tab=page.locator(`#${id}`);if(!(await tab.isVisible()))await page.locator('#appSidebarToggle').click();await tab.click();await page.waitForFunction(id=>document.getElementById(id).getAttribute('aria-selected')==='true',id);}
async function capture(page,name){await mkdir(new URL('out/test-artifacts/w7/',root),{recursive:true});await page.screenshot({path:new URL(`out/test-artifacts/w7/${name}.png`,root).pathname,fullPage:true});}
for(const width of [1440,390,320])test(`W7 shared room, cards and wide popup fit ${width}px`,async t=>{
 const {page,calls,errors}=await open(t,{width});await page.waitForSelector('[data-task-id="work_request:WR-000901"]');
 assert.equal(await page.locator('#appLayout').count(),1);assert.equal(await page.locator('#appSidebarSlot #controlRoomTabs').count(),1);assert.equal(await page.locator('#panelDashboard #board-directory').count(),1);
 assert.equal(await page.locator('.board-card[data-task-id^="governance:"]').count(),4);
 assert.equal(await page.locator('#panelDashboard [id="operationsBlocks"],#resourceDashboard,#headerCoverage').count(),0);
 assert.match(await page.locator('[data-task-id="work_request:WR-000901"]').textContent(),/WR-000901.*#17/);
 assert.equal(await page.locator('#board-retry').getAttribute('aria-label'),'Refresh');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const populatedStages=await page.locator('#board-stages .column').evaluateAll(columns=>columns.map(column=>({stage:column.dataset.stage,cards:column.querySelectorAll('.board-card').length})));
 assert.ok(populatedStages.every(column=>column.cards>0),'empty stages never precede actionable work');
 assert.deepEqual(populatedStages.map(column=>column.stage),['queued','build','review','ci','merged','live','recorded'].filter(stage=>populatedStages.some(column=>column.stage===stage)),'populated stages preserve lifecycle order');
 assert.equal(await page.locator('#board-stages [data-stage="live"] .board-card').count(),0);
 assert.equal(await page.locator('#live-library').textContent(),'Completed records');
 assert.equal(await page.locator('#board-stages .board-card').evaluateAll(cards=>cards.every(card=>card.scrollWidth<=card.clientWidth+1)),true,'all task cards fit inside their stage');
 if(width!==320)await capture(page,`board-${width}`);
 const card=page.locator('[data-task-id="work_request:WR-000901"]');await card.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);
 await page.locator('.job-summary').getByText('Demo acceptance summary',{exact:true}).waitFor();assert.ok((await page.locator('#jobDialog').boundingBox()).width>=Math.min(900,width-40));
 assert.equal(await page.locator('#jobBody details').evaluate(e=>e.open),false);await page.locator('#jobBody summary').click();
 assert.match(await page.locator('#jobBody pre').textContent(),/Demo acceptance summary/);assert.doesNotMatch(await page.locator('#jobBody pre').textContent(),/projection_state|next_human_action/);
 if(width!==320)await capture(page,`popup-${width}`);
 await page.locator('#jobClose').click();assert.equal(await card.evaluate(e=>document.activeElement===e),true);
 await page.locator('.board-card[data-task-id^="governance:"]').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobBody summary').click();assert.match(await page.locator('#jobBody pre').textContent(),/Demo rule/);await page.locator('#jobClose').click();
 await page.locator('.work-card').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobClose').click();
 await section(page,'tabConnections');await page.locator('[data-connection="claude"] a').waitFor();assert.equal(await page.locator('[data-device]').count(),2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width!==320)await capture(page,`connections-${width}`);
 assert.ok(calls.every(name=>Object.keys(reads).includes(name)||name==='read-resource-dashboard'||name==='morning-brief'),calls.join(', '));assert.deepEqual(errors,[]);
});

for(const width of [1440,390])test(`Recorded work refresh preserves task focus and handles removal at ${width}px`,async t=>{
 const {page,state,errors}=await open(t,{width});
 const refresh=()=>page.locator('#system-work-coverage button').evaluate(button=>button.click());
 state.liveItems=[{id:'demo-live',kind:'progress_task',source:'demo',title:'Demo live task',summary:'First summary',completed:true,state:'measured',evidence:'Synthetic verification',age:0,last_activity_at:'2026-10-02T12:00:00Z',available_triage_actions:[]}];
 await page.locator('#system-work-coverage button').waitFor();await refresh();
 const card=page.locator('#completed-list [data-task-id="progress_task:demo-live"]');
 await card.waitFor();assert.equal(await card.getAttribute('data-stage'),'recorded');
 assert.match(await card.getAttribute('aria-label'),/Recorded/);
 assert.match(await card.textContent(),/Recorded progress task state: measured/);
 assert.equal(await page.locator('#completed-count').textContent(),'0 LIVE · 1 RECORDED');
 await capture(page,`recorded-history-${width}`);
 await card.focus();
 state.liveItems[0].summary='Updated summary';await refresh();
 await page.waitForFunction(()=>document.querySelector('#completed-list .card-summary')?.textContent==='Updated summary');
 assert.equal(await card.evaluate(node=>node===document.activeElement),true);
 // A separate control must keep focus when recorded work changes in the background.
 const outside=page.locator('#board-retry');await outside.focus();
 state.liveItems[0].summary='Another summary';await refresh();
 await page.waitForFunction(()=>document.querySelector('#completed-list .card-summary')?.textContent==='Another summary');
 assert.equal(await outside.evaluate(node=>node===document.activeElement),true);
 await card.focus();state.liveItems=[];await refresh();
 await page.waitForFunction(()=>document.querySelector('#completed-count').textContent==='0 LIVE · 0 RECORDED');
 assert.equal(await page.locator('#board-title').evaluate(node=>node===document.activeElement),true);
 assert.match(await page.locator('#completed-list').textContent(),/No completed records yet/);
 assert.deepEqual(errors,[]);
});
for(const width of [1440,390])test(`W7 Action Items rows open the same wide popup at ${width}px`,async t=>{
 const {page,errors}=await open(t,{width});await section(page,'tabViews');
 const row=page.locator('#incidentGroups [data-incident]').first();await row.waitFor();
 const title=await row.locator('h3').textContent();await capture(page,`action-items-${width}`);await row.locator('h3').click();
 await page.waitForFunction(()=>document.querySelector('#jobDialog').open);assert.equal(await page.locator('#jobTitle').textContent(),title);
 assert.ok((await page.locator('#jobDialog').boundingBox()).width>=Math.min(900,width-40));await page.locator('#jobClose').click();assert.deepEqual(errors,[]);
});
test('W7 automatic refresh updates PR, provider spend and open details without losing focus',async t=>{
 const {page,state}=await open(t);const card=page.locator('.work-card h4 a').first();await card.click();await page.locator('.job-summary').getByText('Demo acceptance summary',{exact:true}).waitFor();await page.locator('#jobBody summary').click();
 state.pr=23;state.title='Demo updated dashboard';state.spend=18.50;await advanceRoom(page,16001);
 await page.waitForFunction(()=>document.querySelector('#jobBody').textContent.includes('PR #23'));
 assert.equal(await page.locator('#jobDialog').evaluate(e=>e.open),true);assert.equal(await page.locator('#jobBody details').evaluate(e=>e.open),true);assert.equal(await page.locator('#jobBody summary').evaluate(e=>e===document.activeElement),true);
 await page.locator('#jobClose').click();await section(page,'tabConnections');await page.getByText('$18.50 · October 2026',{exact:true}).first().waitFor();
 assert.equal(await page.locator('[data-connection="grok"]').getAttribute('data-state'),'needs_reconnect');assert.equal(await page.locator('[data-device]').count(),2);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='full');assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'none');assert.equal(await page.locator('[data-connection="grok"] .connection-dot').evaluate(e=>getComputedStyle(e).borderRadius),'1px');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 state.denied=true;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='unknown');assert.equal(await page.locator('[data-device]').count(),0);assert.match(await page.locator('#devicesState').textContent(),/unavailable/);
});
for(const width of [1440,390])test(`W7 calendar defaults and integrated automation list at ${width}px`,async t=>{
 const {page,errors}=await open(t,{width});await section(page,'tabAutomations');await page.waitForSelector('.calendar-day');assert.equal(await page.locator('.calendar-day').count(),31);
 if(width===390){const marker=page.locator('.calendar-day .automation-job').first();assert.ok((await marker.boundingBox()).height<=28);assert.equal(await page.locator('#automationAgenda .automation-job').count(),1);await marker.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobClose').click();}
 await capture(page,`calendar-${width}`);await page.getByRole('button',{name:'Next month'}).click();assert.match(await page.locator('#automationMonth').textContent(),/November/);await page.getByRole('button',{name:'Previous month'}).click();
 await page.goto('http://localhost/control-room?tab=automations&mode=live');await waitForRoom(page);
 assert.equal(await page.locator('#automationUndated .automation-job').count(),2);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await capture(page,`list-${width}`);await page.locator('#automationUndated .automation-job').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);assert.deepEqual(errors,[]);
});

for(const failure of ['http','invalid'])test(`finding 5: ${failure} governance read retains labeled last-known approvals`,async t=>{
 const {page,state}=await open(t);await page.waitForFunction(()=>document.querySelectorAll('.board-card[data-task-id^="governance:"]').length===4);
 state.approvalFailure=failure;await advanceRoom(page,16001);
 await page.waitForFunction(()=>document.querySelector('#roomLive').textContent.includes('unavailable'));
 assert.equal(await page.locator('.board-card[data-task-id^="governance:"]').count(),4);assert.match(await page.locator('#governanceState').textContent(),/unavailable.*last.known/i);
 state.approvalFailure=null;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('#governanceState').hidden);
});
test('finding 6: open incident reconciles with its source while unrelated reads leave it open',async t=>{
 const {page,state}=await open(t);await section(page,'tabViews');await page.locator('#incidentGroups [data-incident-open]').first().click();await page.locator('#jobBody summary').click();
 state.incidentState='monitoring';await advanceRoom(page,16001);await page.waitForFunction(()=>document.querySelector('.job-summary').textContent.includes('monitoring'));
 assert.equal(await page.locator('#jobDialog').evaluate(e=>e.open),true);
 await page.locator('#jobClose').click();await section(page,'tabAutomations');await page.locator('.calendar-day .automation-job').first().click();state.removeJobs=true;await advanceRoom(page,15001);
 await page.waitForFunction(()=>/no longer|removed/.test(document.querySelector('#jobBody').textContent));
});
for(const initial of [false,true])test(`finding 7: malformed Connections ${initial?'initial':'poll'} render unavailable and polling continues`,async t=>{
 const {page,state,errors}=await open(t,{connectionsBad:initial});await section(page,'tabConnections');await page.waitForSelector('[data-connection="claude"]');
 if(!initial){await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='connected');state.connectionsBad=true;await advanceRoom(page,16001);}
 await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='unknown');assert.equal(await page.locator('[data-device]').count(),0);assert.match(await page.locator('[data-connection="claude"]').textContent(),/—/);
 state.connectionsBad=false;await advanceRoom(page,16001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='connected');assert.deepEqual(errors,[]);
});
test('finding 8: poll preserves calendar, management and popup activity focus plus current card return',async t=>{
 const {page,state}=await open(t);await section(page,'tabAutomations');const job=page.locator('.calendar-day .automation-job').first();await job.focus();state.spend=20;await advanceRoom(page,16001);assert.equal(await job.evaluate(e=>e===document.activeElement),true);
 await section(page,'tabConnections');const manage=page.locator('[data-connection="claude"] a');await manage.focus();state.spend=30;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').textContent.includes('$30.00'));assert.equal(await page.evaluate(()=>document.querySelector('[data-connection="claude"] a')===document.activeElement),true);
 await section(page,'tabDashboard');const card=page.locator('.work-card h4 a').first();await card.click();await page.locator('.job-summary').getByText('Demo acceptance summary',{exact:true}).waitFor();await page.locator('#jobBody summary').click();const activity=page.locator('#jobBody details a');await activity.focus();state.pr=77;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('#jobBody').textContent.includes('PR #77'));assert.equal(await activity.evaluate(e=>e===document.activeElement),true);
 await page.locator('#jobClose').click();await page.waitForFunction(()=>document.querySelector('.work-card h4 a')===document.activeElement);
});
test('finding 9: persisted pagehide/pageshow continues Control Room polling',async t=>{
 const {page,state}=await open(t);await section(page,'tabViews');await page.waitForSelector('#incidentGroups [data-incident]');
 const incidentRead=()=>page.waitForResponse(response=>new URL(response.url()).pathname==='/mcp'
  && response.request().postDataJSON()?.params?.name==='incident-board');
 const showsState=state=>page.waitForFunction(expected=>document.querySelector('#incidentGroups [data-incident] .work-meta')?.textContent.includes(expected),state);
 // Consume the resume read before advancing past a read deadline. Otherwise
 // the virtual clock can time out a network response that has not arrived yet.
 state.incidentState='monitoring';const resumed=incidentRead();
 await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
 await (await resumed).finished();await showsState('monitoring');
 state.incidentState='investigating';const polled=incidentRead();await advanceRoom(page,15001);
 await (await polled).finished();await showsState('investigating');
});
test('finding 10: System Map restores selected node on initial load and history navigation',async t=>{
 const {page}=await open(t,{path:'/control-room?mode=live&tab=system-map&node=service%3Ademo-worker'});
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.status==='ready');assert.equal(await page.evaluate(async()=> (await import('/js/atlas.js')).view.selected),'service:demo-worker');
 await page.evaluate(()=>{history.pushState({},'', '/control-room?mode=live&tab=system-map&node=service%3Ademo-exporter');dispatchEvent(new PopStateEvent('popstate'));});
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.selected==='service:demo-exporter');
});
test('finding 11: sidebar overdue scope excludes adapter-normalized Closed and inactive states',async t=>{
 const {page,state}=await open(t);state.dealStates=true;await page.locator('#appSyncRefresh').click();
 await page.waitForFunction(()=>document.querySelector('#appTodayNeeds').textContent.includes('Demo active'));
 for(const id of ['appTodayNeeds','appWorkingList']){assert.deepEqual(await page.locator(`#${id} [data-layout-deal] strong`).allTextContents(),['Demo active']);}
});
test('incident filters and details dispatch once per click after retained and replaced renders',async t=>{
 const {page,state,errors}=await open(t,{countIncidentClicks:true});await section(page,'tabViews');
 const all=page.locator('#severityChips [data-severity="all"]');await all.waitFor();await all.focus();
 for(const sequence of [2,3]){
  await advanceRoom(page,15001);
  await waitForAsync(page,async sequence=>{const {view}=await import('/js/control-room.js');return view.sequence===sequence&&view.reads.incidents.state==='read';},sequence);
 }
 assert.equal(await all.evaluate(node=>node===document.activeElement),true);
 for(let click=1;click<=3;click++){
  await all.click();
  assert.equal(await page.evaluate(()=>window.incidentClickCallbacks.filters),click);
 }
 const incident=page.locator('#incidentGroups [data-incident]').first();
 await incident.locator('h3').click();
 assert.equal(await page.evaluate(()=>window.incidentClickCallbacks.incidents),1);
 assert.equal(await page.locator('#jobDialog').evaluate(node=>node.open),true);
 await page.locator('#jobClose').click();
 // A changed poll and severity selection replace rows; the same handlers must
 // still serve the new nodes, including clicks on children and keyboard clicks.
 state.incidentState='monitoring';await advanceRoom(page,15001);
 await page.waitForFunction(()=>document.querySelector('#incidentGroups .work-meta').textContent.includes('monitoring'));
 const severity=await incident.evaluate(node=>node.closest('[data-group]').dataset.group);
 await page.locator(`#severityChips [data-severity="${severity}"]`).click();
 assert.equal(await page.evaluate(()=>window.incidentClickCallbacks.filters),4);
 await incident.locator('[data-incident-open]').focus();await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>window.incidentClickCallbacks.incidents),2);
 assert.equal(await page.locator('#jobDialog').evaluate(node=>node.open),true);
 await page.locator('#jobClose').click();
 assert.equal(await incident.locator('[data-incident-open]').evaluate(node=>node===document.activeElement),true);
 await all.click();assert.equal(await page.evaluate(()=>window.incidentClickCallbacks.filters),5);
 assert.deepEqual(errors,[]);
});

for(const failure of [503,403,'unpublished'])test(`PR132 #1: board ${failure} reconciles shared detail state`,async t=>{
 const {page,state}=await open(t,{path:'/control-room?mode=live&tab=boards&board=demo-project',unboundBoard:true});
 const card=page.locator('#board-stages .board-card').first();await card.waitFor();await card.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);
 assert.match(await page.locator('#jobBody').textContent(),/Work Request unavailable/);
 if(failure==='unpublished')state.boardUnpublished=true;else state.boardFailure=failure;await page.locator('#board-retry').evaluate(button=>button.click());await page.waitForFunction(failure=>failure==='unpublished'?document.querySelector('#board-meta').dataset.readState==='unpublished':document.querySelector('#board-error').hidden===false,failure);
 if(failure!==503){assert.equal(await page.locator('#jobDialog').evaluate(node=>node.open),false);assert.equal(await page.locator('#jobBody').textContent(),'');}
 else {assert.match(await page.locator('#jobBody').textContent(),/Source unavailable.*Last-known/);await page.locator('#jobClose').click();await card.click();assert.match(await page.locator('#jobBody').textContent(),/Source unavailable.*Last-known/);}
});
for(const partial of [false,true])test(`PR132 #4: ${partial?'partial':'unknown'} schedule observations remain visible in calendar and List`,async t=>{
 const {page,state}=await open(t);state[partial?'partialSchedule':'scheduleUnknown']=true;await advanceRoom(page,16001);await section(page,'tabAutomations');
 assert.match(await page.locator('#panelAutomations').textContent(),partial?/unavailable.*source|source.*unavailable/i:/Automations unavailable/);
 assert.match(await page.locator('#automationState').textContent(),/unavailable/i);
 assert.equal(await page.locator('.calendar-day').count(),partial?31:0);
 if(partial){const calendar=page.locator('#automationCalendar');const grid=await calendar.boundingBox(),sunday=await calendar.locator('.calendar-weekday').first().boundingBox();assert.ok(sunday.x<grid.x+grid.width/7,'Sunday occupies the first calendar column');}
 assert.doesNotMatch(await page.locator('#automationState').textContent(),/No automations/);
});
test('PR132 #3: failed automation read clears calendar and keeps source state explicit',async t=>{
 const {page,state}=await open(t);await page.goto('http://localhost/control-room?tab=automations&mode=live');await waitForRoom(page);await page.locator('#automationUndated .automation-job').first().waitFor();
 state.scheduleFailure=true;await advanceRoom(page,16001);await page.waitForFunction(()=>document.querySelector('#automationState').textContent.includes('unavailable'));
 assert.equal(await page.locator('.calendar-day').count(),0);assert.equal(await page.locator('#automationUndated .automation-job').count(),0);
});
test('PR132 #5: paused configured jobs have an unknown next time in both surfaces',async t=>{
 const {page}=await open(t);await section(page,'tabAutomations');
 const paused=page.locator('#automationUndated [data-state="paused"]');await paused.waitFor();assert.doesNotMatch(await paused.textContent(),/Unscheduled/);assert.match(await paused.textContent(),/unknown.*paused/i);
 assert.doesNotMatch(await page.locator('#automationUndated h3').textContent(),/Unscheduled/);

});
test('PR132 #7: healthy room seeds coverage-only Status fallback before an outage',async t=>{
 const {page,state}=await open(t);const snapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('doctorcre.status-snapshot.v1')));
 assert.ok(snapshot);assert.ok(snapshot.reads.some(row=>row.id==='incidents'&&row.state==='read'));assert.doesNotMatch(JSON.stringify(snapshot),/Demo|WR-|INC-/);
 state.denied=true;await page.goto('http://localhost/status?mode=live');await page.locator('#lastKnownBlock').waitFor();
 assert.match(await page.locator('#lastKnownChips').textContent(),/Incidents/);
});
test('PR132 #8: explicit binding fields are visible on pipeline cards as in details',async t=>{
 const {page,state}=await open(t);state.bindingOnly=true;await page.locator('#system-work-coverage button').click();
 await page.waitForFunction(()=>document.querySelector('.work-card-links')?.textContent.includes('WR-000999'));
 const card=page.locator('#board-stages .board-card[data-task-id^="work_request:"]').first();assert.match(await card.textContent(),/WR-000999.*PR #88/);
});

for(const width of [1440,390])test(`C6 compact support tabs at ${width}px`,async t=>{
 const {page,state,errors}=await open(t,{width,connectionsBad:true});
 state.emptyAgents=true;state.emptySessions=true;state.scheduleUnknown=true;await advanceRoom(page,16001);
 await section(page,'tabModelRoom');
 await page.waitForFunction(()=>document.querySelector('#modelRoomFreshness').dataset.state==='never');
 assert.equal(await page.locator('#modelRoomTitle').textContent(),'Agents');
 assert.doesNotMatch(await page.locator('[data-section="model_room_assignments"]').textContent(),/projector|projected/i);
 assert.equal(await page.locator('#modelRoomMoveTarget').isVisible(),false);
 assert.equal(await page.locator('#modelRoomAssignmentsEmpty').isVisible(),false);
 assert.ok((await page.locator('#modelRoomComposerText').boundingBox()).y<500,'Composer appears before the mobile footer');
 await section(page,'tabAtlas');
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.status==='ready');
 assert.equal(await page.locator('#atlasTitle').textContent(),'System map');
 const index=await page.locator('#atlasIndex').boundingBox();
 assert.ok(index.y<550,'Map content appears in the initial phone work area');
 assert.ok(await page.locator('#atlasIndex').evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('#atlasCoverageHeading'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 await section(page,'tabConnections');
 assert.equal((await page.locator('#panelConnections').textContent()).match(/Status unavailable/g)?.length||0,0);
 assert.match(await page.locator('#connectionsState').textContent(),/status and spend.*unavailable/i);
 assert.equal(await page.locator('[data-connection]').count(),10);
 assert.ok((await page.locator('[data-connection]').first().boundingBox()).height<=64,'Providers use compact rows');
 await section(page,'tabSessions');
 await page.waitForFunction(()=>document.querySelector('#sessionsCounts').dataset.state==='read');
 assert.equal(await page.locator('#sessionsCounts').textContent(),'0 shown · 0 visible · 0 total');
 assert.ok(await page.locator('#sessionsCounts').evaluate(node=>node.closest('[data-section="sessions"]')!==null));
 assert.equal(await page.locator('#sessionsEmpty').isVisible(),true);
 await section(page,'tabAutomations');
 assert.equal(await page.locator('.calendar-day').count(),0);
 assert.match(await page.locator('#automationState').textContent(),/unavailable/i);
 assert.equal(await page.locator('#automationPrev').isVisible(),false);
 assert.deepEqual(errors,[]);
});

for(const width of [1440,390])for(const theme of ['dark','light'])test(`C6 review blockers at ${width}px ${theme}`,async t=>{
 const {page,state,errors}=await open(t,{width,height:width===1440?1000:844,connectionsBad:true,theme});

 state.emptyAgents=true;state.emptySessions=true;state.partialSchedule=true;state.longAtlasLabels=true;await advanceRoom(page,16001);
 await section(page,'tabModelRoom');
 await page.waitForFunction(()=>document.querySelector('#modelRoomFreshness').dataset.state==='never');
 assert.equal(await page.locator('[data-section="model_room_context"]').isVisible(),false,'Empty Context does not displace room activity');
 assert.equal(await page.locator('#modelRoomCounts').textContent(),'0 shown · 0 visible · 0 total');
 assert.ok((await page.locator('#modelRoomParticipantsTitle').boundingBox()).y<600,'Existing activity appears in the first work area');
 const inputs=await page.evaluate(()=>['modelRoomDispatchQuery','sessionsLookup'].map(id=>{const css=getComputedStyle(document.getElementById(id));return {background:css.backgroundColor,border:css.borderRadius};}));
 assert.deepEqual(inputs[0],inputs[1],'Session lookup uses the shared themed input');
 const out=new URL('out/test-artifacts/c6-review/',root);await mkdir(out,{recursive:true});
 const shots=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:new URL(`${name}-${width}-${theme}.png`,out).pathname});await page.screenshot({path:new URL(`${name}-${width}-${theme}-full.png`,out).pathname,fullPage:true});};
 await shots('agents');
 await section(page,'tabAtlas');await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.status==='ready');
 const node=page.locator('.atlas-node').first(),select=node.locator('[data-atlas-select]');
 assert.ok((await node.boundingBox()).height<=160,'Component rows fit a compact list');
 assert.ok((await select.boundingBox()).height<=48,'Select is a compact control');
 assert.ok((await node.boundingBox()).x-(await page.locator('#atlasIndex').boundingBox()).x<=8,'Nested frames do not consume the list width');
 await select.click();assert.equal(await node.getAttribute('data-selected'),'true');
 await shots('system-map');
 await section(page,'tabConnections');
 assert.equal(await page.locator('.connection-columns').getByText('Spend',{exact:true}).isVisible(),true,'Spend keeps its own visible heading');
 const provider=page.locator('[data-connection]').first();
 const status=await provider.locator('.connection-state').boundingBox(),spend=await provider.locator('.connection-spend').boundingBox();
 assert.ok(Math.abs(status.y-spend.y)<3,'Status and Spend remain distinct columns');
 await shots('connections');
 await section(page,'tabSessions');await page.waitForFunction(()=>document.querySelector('#sessionsCounts').dataset.state==='read');await shots('sessions');
 await section(page,'tabAutomations');await shots('automations');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
});

for(const width of [1440,390])for(const theme of ['dark','light']){
 test(`C5 Boards pipeline and data mode are visible on first screen at ${width}px ${theme}`,async t=>{
  const {page,errors}=await open(t,{width,theme,boardUnpublished:true});
  await advanceRoom(page,16001);
  await page.locator('#board-stages .board-card').first().waitFor();
  await page.locator('#board-meta[data-read-state="unpublished"]').waitFor();
  if(process.env.C5_CAPTURE_PHASE){const dir=new URL(`out/test-artifacts/c5/${process.env.C5_CAPTURE_PHASE}/`,root);await mkdir(dir,{recursive:true});await page.screenshot({path:new URL(`boards-${width}-${theme}.png`,dir).pathname});}
  assert.equal(await page.locator('.directory-panel').evaluate(n=>n.open),true);
  assert.ok(await page.locator('#board-directory a').count()>0);
  const first=await page.locator('#board-stages .board-card').first().boundingBox();
  const bottom=await page.locator(width===390?'#appShell':'.app-layout-status').boundingBox();
  assert.ok(first.y+Math.min(first.height,80)<bottom.y,`pipeline card starts at ${first.y}, content ends at ${bottom.y}`);
  assert.equal(await page.locator('#board-data-mode').count(),1,'data mode is labeled beside board state');
  assert.match(await page.locator('#board-data-mode').textContent(),/Live work.*pipeline/i);
  assert.match(await page.locator('.cr-board-state').textContent(),/No published snapshot/);
  assert.equal(await page.locator('#board-error').isVisible(),false);
  assert.equal(new URL(page.url()).searchParams.get('tab'),'boards');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
 });
 test(`C5 Views uses compact ledger and empty state at ${width}px ${theme}`,async t=>{
  const {page,errors}=await open(t,{width,theme,emptyIncidents:true,path:'/control-room?mode=live&tab=views'});
  const empty=page.locator('#incidentGroups [data-state="empty"]');await empty.waitFor();
  if(process.env.C5_CAPTURE_PHASE){const dir=new URL(`out/test-artifacts/c5/${process.env.C5_CAPTURE_PHASE}/`,root);await mkdir(dir,{recursive:true});await page.screenshot({path:new URL(`views-${width}-${theme}.png`,dir).pathname});}
  assert.ok((await empty.boundingBox()).height<=48,'empty ledger stays a compact row');
  assert.ok(await page.locator('#attentionTitle').evaluate(n=>getComputedStyle(n).fontSize===getComputedStyle(document.querySelector('.cr-views li')).fontSize),'ledger heading matches view summary scale');
  const box=await empty.boundingBox(),bottom=await page.locator(width===390?'#appShell':'.app-layout-status').boundingBox();
  assert.ok(box.y+box.height<bottom.y,'empty ledger fits first screen');
  assert.equal(await empty.evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
 });
}

test('C5 two expanded published boards leave the live pipeline on the first phone screen',async t=>{
 const {page}=await open(t,{width:390,boardUnpublished:true,extraBoard:true});
 await advanceRoom(page,16001);await page.locator('#board-stages .board-card').first().waitFor();
 assert.equal(await page.locator('#board-directory a').count(),2);
 assert.equal(await page.locator('#filter-repo').isVisible(),true);
 if(process.env.C5_CAPTURE_PHASE)await page.screenshot({path:new URL('out/test-artifacts/c5/after/boards-two-390.png',root).pathname});
 const first=await page.locator('#board-stages .board-card').first().boundingBox();
 const footer=await page.locator('#appShell').boundingBox();
 assert.ok(first.y+80<footer.y,`pipeline starts at ${first.y}, content ends at ${footer.y}`);
});

for(const width of [1440,390])for(const theme of ['dark','light'])test(`C5 round 2 Boards removes empty card metadata at ${width}px ${theme}`,async t=>{
 const {page,errors}=await open(t,{width,theme,boardUnpublished:true,extraBoard:true});
 await advanceRoom(page,16001);await page.locator('#board-stages .board-card').first().waitFor();
 if(process.env.C5_ROUND2_CAPTURE){const dir=new URL(`out/test-artifacts/c5-round2/${process.env.C5_ROUND2_CAPTURE}/`,root);await mkdir(dir,{recursive:true});await page.screenshot({path:new URL(`boards-${width}-${theme}.png`,dir).pathname});}
 const cards=page.locator('#board-stages .board-card');
 for(const card of await cards.all()){
  const title=(await card.locator('.card-title').textContent()).replace(/\.+$/, '');
  for(const summary of await card.locator('.card-summary').all())assert.notEqual((await summary.textContent()).replace(/\.+$/, ''),title,'title appears only once');
  assert.doesNotMatch(await card.textContent(),/Work Request unavailable|No PR|Unknown|Not recorded|\bunknown\b/,'missing metadata adds no visible row');
 }
 assert.match(await page.locator('[data-task-id="work_request:WR-000901"] .card-meta').textContent(),/WR-000901.*demo #17/,'known bindings remain visible');
 assert.equal(await page.locator('.directory-panel').evaluate(n=>n.open),true);
 assert.match(await page.locator('#board-data-mode').textContent(),/Live work.*pipeline/);
 if(width===390)assert.ok((await cards.first().boundingBox()).y<510,'phone header and filters form a compact group');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
});

for(const theme of ['dark','light'])test(`C6 phone map opens with components at 390px ${theme}`,async t=>{
 const {page,state,errors}=await open(t,{width:390,height:844,theme});
 state.largeAtlas=true;
 await section(page,'tabAtlas');await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.status==='ready');
 assert.equal(await page.locator('.atlas-node').count(),500,'The large inventory reproduces anatomical guidance');
 assert.match(await page.locator('#atlasRendererNote').textContent(),/too many components/);
 const first=await page.locator('.atlas-node h3').first().boundingBox();
 assert.ok(first.y<=260,`First component starts at ${first.y}px, within the opening 260px`);
 const out=new URL('out/test-artifacts/c6-review-r3/',root);await mkdir(out,{recursive:true});
 await page.screenshot({path:new URL(`system-map-390-${theme}.png`,out).pathname});
 const toggle=page.getByRole('button',{name:'Filters and view',exact:true});
 assert.equal(await page.locator('#atlasSearch').isVisible(),false);
 assert.equal(await page.locator('#atlasRendererNote').isVisible(),false);
 await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');
 assert.equal(await page.locator('#atlasRendererNote').isVisible(),true,'Guidance remains available with its view controls');
 await page.locator('#atlasLayerFilters [data-layer="declared"]').click();
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.payload?.layer.join(',')==='declared');
 await page.locator('#atlasRetired').check();
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.payload?.include_retired===true);
 await page.locator('#atlasSearch').fill('demo-add-loop');await page.clock.runFor(300);
 await waitForAsync(page,async()=> (await import('/js/atlas.js')).view.payload?.q==='demo-add-loop');
 await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 await page.evaluate(()=>scrollTo(0,0));
 assert.ok((await page.locator('.atlas-node h3').first().boundingBox()).y<=260,'Filtered components stay in the opening work area');
 await page.locator('.atlas-node [data-atlas-select]').first().click();
 assert.equal(await page.locator('.atlas-node').first().getAttribute('data-selected'),'true');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
});

test('C5 round 2 Boards keeps meaningful descriptions and recorded model metadata',async t=>{
 const {page,state}=await open(t);state.cardDetails=true;await advanceRoom(page,16001);
 const card=page.locator('#board-stages .board-card').first();
 assert.equal(await card.locator('.card-summary').textContent(),'Keep distinct acceptance details.');
 assert.equal(await card.locator('.card-model').textContent(),'OpenAI · gpt-6-sol · high');
});


test('hierarchy browser history keeps the full Control Room in Boards', async t => {
 const {page,errors}=await open(t,{snapshotData:hierarchy});
 const card=id=>page.locator(`[data-hierarchy-id="${id}"] > button`);
 await card('WR14').click();
 await card('WR14.S2').click();
 await card('WR14.S2.J1.app#316').click();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.goBack();
 assert.equal(await page.locator('#jobDialog').isVisible(),false);
 assert.equal(await page.locator('#panelDashboard').isVisible(),true);
 assert.equal(await page.locator('#tabDashboard').getAttribute('aria-selected'),'true');
 assert.equal(new URL(page.url()).pathname,'/control-room');
 assert.equal(new URL(page.url()).searchParams.get('card'),'WR14.S2');
 await page.goForward();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#panelDashboard').isVisible(),true);
 assert.deepEqual(errors,[]);
});

test('hierarchy history leaves Connections and Automations free of retained board dialogs', async t => {
 const {page,errors}=await open(t,{snapshotData:hierarchy});
 for (const id of ['WR14','WR14.S2','WR14.S2.J1.app#316']) {
  await page.locator(`[data-hierarchy-id="${id}"] > button`).click();
 }
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.locator('#jobClose').click();
 await section(page,'tabConnections');
 await section(page,'tabAutomations');
 await page.goBack();
 assert.equal(await page.locator('#tabConnections').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#jobDialog').isVisible(),false);
 await page.goForward();
 assert.equal(await page.locator('#tabAutomations').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#jobDialog').isVisible(),false);
 await page.goBack();
 await page.goBack();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#tabDashboard').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#jobTitle').textContent(),'Board navigation');
 await page.goForward();
 assert.equal(await page.locator('#tabConnections').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#jobDialog').isVisible(),false);
 assert.deepEqual(errors,[]);
});

test('hierarchy refresh reconciles an open job after PR and slice rekeys', async t => {
 const snapshot=structuredClone(hierarchy);
 let id='WR14.S2.J1';
 const original=snapshot.tasks['WR14.S2.J1.app#316'];
 delete snapshot.tasks[original.id];
 delete original.pr;
 original.id=id;
 snapshot.tasks[id]=original;
 snapshot.hierarchy.slices['WR14.S2'].cards=[id];
 snapshot.hierarchy.aliases={};
 const {page,errors}=await open(t,{snapshotData:snapshot});
 await page.locator('[data-hierarchy-id="WR14"] > button').click();
 await page.locator('[data-hierarchy-id="WR14.S2"] > button').click();
 await page.locator(`[data-hierarchy-id="${id}"] > button`).click();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.locator('#jobBody summary').click();
 for (const [next,parent,title] of [
  ['WR14.S2.J1.app#317','WR14.S2','Job now has a PR'],
  ['WR14.S1.J2.app#317','WR14.S1','Job moved to another slice'],
 ]) {
  const job=snapshot.tasks[id];
  delete snapshot.tasks[id];
  snapshot.hierarchy.slices[job.parent_id].cards=snapshot.hierarchy.slices[job.parent_id].cards.filter(card=>card!==id);
  Object.assign(job,{id:next,parent_id:parent,pr:317,card_title:title});
  snapshot.tasks[next]=job;
  snapshot.hierarchy.slices[parent].cards.push(next);
  snapshot.hierarchy.aliases[id]=next;
  id=next;
  await page.locator('#board-retry').evaluate(button=>button.click());
  await page.locator(`[data-hierarchy-id="${id}"] > button`).waitFor();
  assert.equal(await page.locator('#jobTitle').textContent(),title);
  assert.equal(await page.locator('#jobBody a[data-job-control="pr"]').getAttribute('href'),'https://github.com/jbookout/doctorcre-app/pull/317');
  assert.doesNotMatch(await page.locator('#jobBody').textContent(),/Source entry is no longer present/);
  assert.equal(await page.locator('#jobBody details').evaluate(node=>node.open),true);
  assert.equal(await page.locator('#jobBody summary').evaluate(node=>node===document.activeElement),true);
 }
 await page.locator('#jobClose').click();
 await page.clock.runFor(50);
 await page.waitForFunction(()=>document.activeElement.matches('[data-hierarchy-id] > button'));
 assert.equal(await page.locator(`[data-hierarchy-id="${id}"] > button`).evaluate(node=>node===document.activeElement),true,await page.evaluate(()=>document.activeElement.outerHTML.slice(0,500)));
 snapshot.tasks[id].card_title='Updated while closed';
 await page.locator('#board-retry').evaluate(button=>button.click());
 await page.getByRole('button',{name:'Updated while closed',exact:true}).waitFor();
 assert.equal(await page.locator('#jobDialog').isVisible(),false);
 assert.deepEqual(errors,[]);
});


test('hierarchy drill-down focuses headings and history restores the originating job control', async t => {
 const {page,errors}=await open(t,{snapshotData:hierarchy});
 const card=id=>page.locator(`[data-hierarchy-id="${id}"] > button`);
 await card('WR14').focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('#pipeline-title').evaluate(node=>node===document.activeElement),true);
 await card('WR14.S2').focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('#pipeline-title').evaluate(node=>node===document.activeElement),true);
 await card('WR14.S2.J1.app#316').focus();
 await page.keyboard.press('Enter');
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.goBack();
 await page.waitForFunction(()=>!document.querySelector('#jobDialog').open);
 assert.equal(await card('WR14.S2.J1.app#316').evaluate(node=>node===document.activeElement),true);
 await page.goForward();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 await page.clock.runFor(50);

 assert.equal(await card('WR14.S2.J1.app#316').evaluate(node=>node===document.activeElement),true);
 assert.deepEqual(errors,[]);
});


test('blocked hierarchy jobs expose their status and next action without opening details', async t => {
 const snapshot=structuredClone(hierarchy);
 const job=snapshot.tasks['WR14.S2.J1.app#316'];
 Object.assign(job,{status:'blocked',stage:'review',next_action:'Check the keyboard focus before resuming review.'});
 const {page,errors}=await open(t,{snapshotData:snapshot});
 await page.locator('[data-hierarchy-id="WR14"] > button').click();
 await page.locator('[data-hierarchy-id="WR14.S2"] > button').click();
 const card=page.locator('[data-hierarchy-id="WR14.S2.J1.app#316"]');
 assert.equal(await card.locator('details').getAttribute('open'),null);
 assert.equal(await card.getByText('Blocked',{exact:true}).isVisible(),true);
 assert.equal(await card.getByText('Next action: Check the keyboard focus before resuming review.',{exact:true}).isVisible(),true);
 assert.deepEqual(errors,[]);
});

function hierarchyTasteFixture() {
 const snapshot=structuredClone(hierarchy);
 const parent=snapshot.hierarchy.slices['WR14.S2'];
 const sample=snapshot.tasks['WR14.S2.J1.app#316'];
 for(const [id,fields] of [
  ['WR14.S2.J2.app#320',{pr:320,card_title:'Keyboard navigation',card_description:'Keep focus on the work when moving between requests, slices, and jobs.',status:'blocked',stage:'review',next_action:'Check keyboard focus before resuming review.'}],
  ['WR14.S2.J3.carr#1971',{pr:1971,repo:'jbookout/carr-system',card_title:'History checks',card_description:'Verify that browser history returns to the selected work.',status:'running',stage:'build'}],
 ]) {snapshot.tasks[id]={...sample,...fields,id};parent.cards.push(id);}
 parent.pr_counts={build:1,review:2};parent.status='blocked';
 snapshot.hierarchy.work_requests.WR14.status='blocked';
 snapshot.hierarchy.work_requests.WR14.counts={done:1,active:0,blocked:1,failed:0};
 return snapshot;
}

for(const route of ['room','standalone'])for(const width of [320,390,1280])for(const theme of ['light','dark'])test(`hierarchy occlusion journey ${route} ${width}px ${theme}`,async t=>{
 const path=route==='room'?'/control-room?mode=live&tab=boards&card=WR14.S2':'/control-room/progress/board/carr-v5?card=WR14.S2';
 const snapshot=hierarchyTasteFixture();
 snapshot.hierarchy.slices['WR14.S2'].cards=['WR14.S2.J2.app#320','WR14.S2.J1.app#316','WR14.S2.J3.carr#1971'];
 for(const card of Object.values(snapshot.tasks)){
  card.card_description='Keep reviewed changes moving so partners can find the work that needs them.';
  card.executor='Synthetic review desk';
 }
 const {page,errors}=await open(t,{path,width,height:900,theme,snapshotData:snapshot});
 const blocked=page.locator('[data-hierarchy-id="WR14.S2.J2.app#320"]');
 await blocked.locator('summary').click();
 // Try the reported document scroll, then sweep each job title through the
 // fixed chrome boundary. A protected scrollport keeps document scroll at zero.
 const checks=[];
 await page.evaluate(y=>window.scrollTo(0,y),width===320?46:width===390?7:197);
 for(const id of ['WR14.S2.J2.app#320','WR14.S2.J1.app#316']){
  const title=page.locator(`[data-hierarchy-id="${id}"] > button`);
  await title.scrollIntoViewIfNeeded();
  const check=await title.evaluate(node=>{
   const boundary=document.querySelector(innerWidth<761?'#appShell':'.app-layout-status').getBoundingClientRect().top;
   let r=node.getBoundingClientRect();
   window.scrollBy(0,r.top+r.height/2-boundary-2);
   r=node.getBoundingClientRect();
   const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
   return {title:node.textContent,scrollY,centre:r.top+r.height/2,boundary,hit:hit?.tagName,uncovered:node.contains(hit)};
  });
  checks.push(check);
 }
 const out=new URL('out/test-artifacts/taste-317-round2/',root);await mkdir(out,{recursive:true});
 await writeFile(new URL(`${route}-${width}-${theme}-occlusion.json`,out),JSON.stringify(checks,null,2));
 await page.screenshot({path:new URL(`${route}-${width}-${theme}.png`,out).pathname});
 assert.ok(checks.every(check=>check.uncovered),JSON.stringify(checks));
 assert.deepEqual(errors,[]);
});

for(const width of [320,390,1280])for(const theme of ['light','dark'])test(`hierarchy taste journey ${width}px ${theme}`,async t=>{
 const {page,errors}=await open(t,{width,height:900,theme,snapshotData:hierarchyTasteFixture()});
 const card=id=>page.locator(`[data-hierarchy-id="${id}"] > button`);
 const out=new URL('out/test-artifacts/taste-317/',root);await mkdir(out,{recursive:true});
 const screenshot=state=>page.screenshot({path:new URL(`${width}-${theme}-${state}.png`,out).pathname});
 await card('WR14').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#pipeline-title').evaluate(n=>n===document.activeElement),true);
 await screenshot('slices');
 await card('WR14.S2').click();
 assert.equal(await page.locator('.hierarchy-breadcrumbs [aria-current="page"]').textContent(),'Board navigation');
 assert.equal(await page.locator('#hierarchy-jump input').isVisible(),false);
 const blocked=page.locator('[data-hierarchy-id="WR14.S2.J2.app#320"]');
 assert.equal(await blocked.getByText('Blocked',{exact:true}).isVisible(),true);
 assert.equal(await blocked.getByText('Next action: Check keyboard focus before resuming review.',{exact:true}).isVisible(),true);
 await screenshot('jobs');
 await page.addScriptTag({content:axe.source});
 const violations=await page.evaluate(async()=> (await axe.run('.pipeline-panel')).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));
 assert.deepEqual(violations,[]);
 const columns=await page.locator('#board-stages .columns').evaluate(node=>({tracks:getComputedStyle(node).gridTemplateColumns.split(' ').filter(w=>parseFloat(w)>0).length,count:node.children.length,widths:[...node.children].map(c=>c.getBoundingClientRect().width)}));
 if(width===1280){
  assert.equal(columns.tracks,columns.count);
  assert.equal(columns.count,2);
  assert.ok(columns.widths.every(w=>w>=300),JSON.stringify(columns));
  assert.ok(await page.evaluate(()=>document.querySelector('.app-layout-center').clientWidth>document.querySelector('#appSidebar').clientWidth+document.querySelector('#appToday').clientWidth));
  assert.ok(await page.evaluate(()=>document.querySelector('.app-layout-center').getBoundingClientRect().bottom<=document.querySelector('.app-layout-status').getBoundingClientRect().top));
 }
 await card('WR14.S2.J1.app#316').focus();await page.keyboard.press('Enter');
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await screenshot('dialog');
 await page.goBack();
 assert.equal(await page.locator('#panelDashboard').isVisible(),true);
 assert.equal(await card('WR14.S2.J1.app#316').evaluate(n=>n===document.activeElement),true);
 await screenshot('dialog-back');
 await page.goForward();await page.locator('#jobDialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#panelDashboard').isVisible(),true);
 await page.keyboard.press('Escape');await page.clock.runFor(50);
 assert.equal(await card('WR14.S2.J1.app#316').evaluate(n=>n===document.activeElement),true);
 if(width<761){
  await blocked.locator('summary').click();
  const occlusion=await page.evaluate(()=>{
   const region=document.querySelector('.app-layout-center');region.scrollTop=211;
   const bounds=region.getBoundingClientRect(),nav=document.querySelector('#appShell').getBoundingClientRect();
   const top=document.querySelector('.app-layout-tabbar').getBoundingClientRect().bottom;
   const controls=[...document.querySelectorAll('#board-stages button,#board-stages summary')].filter(n=>{if(!n.checkVisibility())return false;const r=n.getBoundingClientRect();return r.top+r.height/2>top&&r.top+r.height/2<bounds.bottom;});
   return {bottom:bounds.bottom,navTop:nav.top,checked:controls.length,covered:controls.filter(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !n.contains(hit);}).map(n=>n.textContent)};
  });
  assert.ok(occlusion.bottom<=occlusion.navTop,JSON.stringify(occlusion));
  assert.ok(occlusion.checked>0);
  assert.deepEqual(occlusion.covered,[]);
  await writeFile(new URL(`${width}-${theme}-occlusion.json`,out),JSON.stringify(occlusion,null,2));
  await screenshot('scroll');
  await blocked.scrollIntoViewIfNeeded();
  await screenshot('blocked');
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
});

test('completed hierarchy jobs restore a visible originating control on dialog close',async t=>{
 const {page}=await open(t,{snapshotData:hierarchy});
 await page.locator('[data-hierarchy-id="WR14"] > button').click();
 await page.locator('#hierarchy-completed > details > summary').click();
 await page.locator('[data-hierarchy-id="WR14.S1"] > button').click();
 await page.locator('#hierarchy-completed > details > summary').click();
 const job=page.locator('[data-hierarchy-id="WR14.S1.J1.carr#1960"] > button');
 await job.click();
 await page.locator('#jobDialog').waitFor({state:'visible'});
 await page.keyboard.press('Escape');await page.clock.runFor(50);
 assert.equal(await job.isVisible(),true);
 assert.equal(await job.evaluate(n=>n===document.activeElement),true);
});
