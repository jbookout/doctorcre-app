import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,waitForAsync} from './browser-harness.mjs';
import {createFixtureClient} from '../js/fixture-client.js';
import {atlasFixtureResponse} from '../scripts/atlas-fixture.mjs';
import routes from '../contracts/app-routes.v1.json' with {type:'json'};
const root=new URL('../',import.meta.url);
const reads={'list-doc-suggestions':'listDocSuggestions','read-progress-board':'readProgressBoard','list-progress-boards':'listProgressBoards','unfinished-work':'unfinishedWork','incident-board':'incidentBoard','governance-queue':'governanceQueue','schedule-board':'scheduleBoard','work-request-card':'workRequestCard','deal-room-board':'getBoard','today-triage':'todayTriage','notification-feed':'notificationFeed','list-notifications':'listNotifications'};
async function open(t,{width=1440,path='/control-room?mode=live',connectionsBad=false,countIncidentClicks=false,unboundBoard=false}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},timezoneId:'UTC',reducedMotion:'reduce'});
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
 const errors=[],calls=[];const state={pr:17,title:'Demo dashboard refresh',spend:12.34,denied:false,approvalFailure:null,incidentState:'investigating',removeJobs:false,connectionsBad,dealStates:false,liveItems:[],boardFailure:null,scheduleFailure:false,scheduleUnknown:false,partialSchedule:false,duplicateJobs:false,bindingOnly:false,boardUnpublished:false};page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/mcp'){
   const rpc=request.postDataJSON().params;calls.push(rpc.name);if(state.denied)return route.fulfill({status:401,body:'{}'});
   if(rpc.name==='read-progress-board'&&state.boardFailure)return route.fulfill({status:state.boardFailure,body:'{}'});
   if(rpc.name==='schedule-board'&&state.scheduleFailure)return route.fulfill({status:503,body:'{}'});
   if(rpc.name==='governance-queue'&&state.approvalFailure==='http')return route.fulfill({status:503,body:'{}'});
   let payload={};if(reads[rpc.name]&&fixture[reads[rpc.name]])payload=await fixture[reads[rpc.name]](rpc.arguments);
   if(rpc.name==='governance-queue'&&state.approvalFailure==='invalid')payload={ok:true};
   if(rpc.name==='read-progress-board'&&unboundBoard&&payload.snapshot)for(const task of Object.values(payload.snapshot.snapshot_json.tasks)){delete task.work_request;delete task.work_request_ref;delete task.human_ref;task.related=[];}
   if(rpc.name==='read-progress-board'&&state.boardUnpublished)payload.snapshot=null;
   if(rpc.name==='incident-board')payload.incidents[0].state=state.incidentState;
   if(rpc.name==='schedule-board'&&state.scheduleUnknown){payload.overall_state='unknown';payload.jobs=[];payload.sources=payload.sources.map(row=>({...row,state:'unknown',count:null}));}
   if(rpc.name==='schedule-board'&&state.partialSchedule){payload.jobs=payload.jobs.filter(job=>job.owner===payload.sources[0].owner);payload.sources=payload.sources.map((source,i)=>i===0?source:{...source,state:'unknown',count:null});}
   if(rpc.name==='schedule-board'&&state.duplicateJobs){payload.jobs=payload.jobs.map((job,i)=>({...job,key:'same',next_due_at:payload.jobs[0].next_due_at,next_due_basis:payload.jobs[0].next_due_basis}));}
   if(rpc.name==='schedule-board'&&state.removeJobs){payload.jobs=[];payload.sources=payload.sources.map(source=>({...source,state:'unknown',count:null}));}
   if(rpc.name==='deal-room-board'&&state.dealStates)payload={...payload,actor:'joe',deals:['active','closed','inactive','completed'].map((state,i)=>({id:`demo-deal-${i}`,name:`Demo ${state}`,owner:'joe',attention:true,phase:state==='closed'?'closed':'pending',operating_state:['active','closed'].includes(state)?'active':state}))};
   if(rpc.name==='unfinished-work'&&state.bindingOnly)for(const row of payload.items||[]){row.work_request_ref='WR-000999';row.human_ref=null;row.work_request=null;row.related=[];row.pr_url='https://github.com/example/demo/pull/88';row.pr=null;}
   if(rpc.name==='unfinished-work')for(const row of payload.items||[]){row.pr=state.pr;row.title=state.title;}
   if(rpc.name==='unfinished-work'&&rpc.arguments.live_library)payload.items=state.liveItems;
   if(rpc.name==='read-resource-dashboard'){payload=await fixture.readResourceDashboard();payload.connections=await fixture.readConnections();payload.connections.providers[0].spend.amount=state.spend;if(state.connectionsBad){payload.connections.providers.push(null);payload.connections.devices.items.push(null);}}
   if(rpc.name==='work-request-card')payload.desired_outcome='Demo acceptance summary';
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}})});
  }
  if(url.pathname==='/api/v1/atlas-graph'){const result=atlasFixtureResponse(url,'GET');return route.fulfill({status:result.status,contentType:'application/json',body:JSON.stringify(result.body)});}
  if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-test-token'})});
  if(url.pathname==='/app-release'&&state.denied)return route.fulfill({status:503,body:'{}'});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
  const file=routes.routes[url.pathname]||url.pathname.slice(1);
  try{const body=await readFile(new URL(file,root));return route.fulfill({body,contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(`http://localhost${path}`);
 await page.waitForFunction(()=>document.querySelector('#selfAvatar')?.textContent==='J');
 await waitForRoom(page);
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
async function capture(page,name){await mkdir(new URL('out/test-artifacts/w7/',root),{recursive:true});await page.screenshot({path:new URL(`out/test-artifacts/w7/${name}.png`,root).pathname,fullPage:true});}
for(const width of [1440,390,320])test(`W7 shared room, cards and wide popup fit ${width}px`,async t=>{
 const {page,calls,errors}=await open(t,{width});await page.waitForSelector('[data-task-id="work_request:WR-000901"]');
 assert.equal(await page.locator('#appLayout').count(),1);assert.equal(await page.locator('#appTabsSlot #controlRoomTabs').count(),1);assert.equal(await page.locator('#appSidebarSlot #board-directory').count(),1);
 assert.equal(await page.locator('.board-card[data-task-id^="governance:"]').count(),4);
 assert.equal(await page.locator('#panelDashboard [id="operationsBlocks"],#resourceDashboard,#headerCoverage').count(),0);
 assert.match(await page.locator('[data-task-id="work_request:WR-000901"]').textContent(),/WR-000901.*#17/);
 assert.equal(await page.locator('#board-retry').getAttribute('aria-label'),'Refresh');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(await page.locator('#board-stages .column').evaluateAll(columns=>columns.map(column=>column.dataset.stage)),['queued','build','review','ci','merged','live','recorded']);
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
 await page.locator('#tabConnections').click();await page.locator('[data-connection="claude"] a').waitFor();assert.equal(await page.locator('[data-device]').count(),2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width!==320)await capture(page,`connections-${width}`);
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
 const {page,errors}=await open(t,{width});await page.locator('#tabAttention').click();
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
 await page.locator('#jobClose').click();await page.locator('#tabConnections').click();await page.getByText('$18.50 · October 2026',{exact:true}).first().waitFor();
 assert.equal(await page.locator('[data-connection="grok"]').getAttribute('data-state'),'needs_reconnect');assert.equal(await page.locator('[data-device]').count(),2);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='full');assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'connection-breathe');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 state.denied=true;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='unknown');assert.equal(await page.locator('[data-device]').count(),0);assert.match(await page.locator('#devicesState').textContent(),/unavailable/);
});
for(const width of [1440,390])test(`W7 calendar defaults and dedicated automation list at ${width}px`,async t=>{
 const {page,errors}=await open(t,{width});await page.locator('#tabAutomations').click();await page.waitForSelector('.calendar-day');assert.equal(await page.locator('.calendar-day').count(),31);
 if(width===390){const marker=page.locator('.calendar-day .automation-job').first();assert.ok((await marker.boundingBox()).height<=28);assert.equal(await page.locator('#automationAgenda .automation-job').count(),1);await marker.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobClose').click();}
 await capture(page,`calendar-${width}`);await page.getByRole('button',{name:'Next month'}).click();assert.match(await page.locator('#automationMonth').textContent(),/November/);await page.getByRole('button',{name:'Previous month'}).click();
 const link=page.locator('#panelAutomations').getByRole('link',{name:'List',exact:true});assert.equal(await link.getAttribute('href'),'/control-room/automations');await link.click();await page.waitForURL('**/control-room/automations');await page.waitForSelector('#automationList .automation-job');
 assert.equal(await page.locator('#appTabsSlot').getByRole('link',{name:'List',exact:true}).getAttribute('aria-current'),'page');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await capture(page,`list-${width}`);await page.locator('#automationList .automation-job').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);assert.deepEqual(errors,[]);
});
test('W7 retains distinct before and after renders at desktop and phone width',async()=>{
 for(const width of [1440,390]){
  const before=await readFile(new URL(`test-artifacts/w7/before-${width}.png`,root));
  const after=await readFile(new URL(`out/test-artifacts/w7/board-${width}.png`,root));
  assert.equal(before.readUInt32BE(16),width);assert.equal(after.readUInt32BE(16),width);assert.notDeepEqual(before,after);
 }
});

for(const failure of ['http','invalid'])test(`finding 5: ${failure} governance read retains labeled last-known approvals`,async t=>{
 const {page,state}=await open(t);await page.waitForFunction(()=>document.querySelectorAll('.board-card[data-task-id^="governance:"]').length===4);
 state.approvalFailure=failure;await advanceRoom(page,16001);
 await page.waitForFunction(()=>document.querySelector('#roomLive').textContent.includes('unavailable'));
 assert.equal(await page.locator('.board-card[data-task-id^="governance:"]').count(),4);assert.match(await page.locator('#governanceState').textContent(),/unavailable.*last.known/i);
 state.approvalFailure=null;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('#governanceState').hidden);
});
test('finding 6: open incident reconciles with its source while unrelated reads leave it open',async t=>{
 const {page,state}=await open(t);await page.locator('#tabAttention').click();await page.locator('#incidentGroups [data-incident-open]').first().click();await page.locator('#jobBody summary').click();
 state.incidentState='monitoring';await advanceRoom(page,16001);await page.waitForFunction(()=>document.querySelector('.job-summary').textContent.includes('monitoring'));
 assert.equal(await page.locator('#jobDialog').evaluate(e=>e.open),true);
 await page.locator('#jobClose').click();await page.locator('#tabAutomations').click();await page.locator('.calendar-day .automation-job').first().click();state.removeJobs=true;await advanceRoom(page,15001);
 await page.waitForFunction(()=>/no longer|removed/.test(document.querySelector('#jobBody').textContent));
});
for(const initial of [false,true])test(`finding 7: malformed Connections ${initial?'initial':'poll'} render unavailable and polling continues`,async t=>{
 const {page,state,errors}=await open(t,{connectionsBad:initial});await page.locator('#tabConnections').click();await page.waitForSelector('[data-connection="claude"]');
 if(!initial){await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='connected');state.connectionsBad=true;await advanceRoom(page,16001);}
 await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='unknown');assert.equal(await page.locator('[data-device]').count(),0);assert.match(await page.locator('[data-connection="claude"]').textContent(),/Spend unavailable/);
 state.connectionsBad=false;await advanceRoom(page,16001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='connected');assert.deepEqual(errors,[]);
});
test('finding 8: poll preserves calendar, management and popup activity focus plus current card return',async t=>{
 const {page,state}=await open(t);await page.locator('#tabAutomations').click();const job=page.locator('.calendar-day .automation-job').first();await job.focus();state.spend=20;await advanceRoom(page,16001);assert.equal(await job.evaluate(e=>e===document.activeElement),true);
 await page.locator('#tabConnections').click();const manage=page.locator('[data-connection="claude"] a');await manage.focus();state.spend=30;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').textContent.includes('$30.00'));assert.equal(await page.evaluate(()=>document.querySelector('[data-connection="claude"] a')===document.activeElement),true);
 await page.locator('#tabDashboard').click();const card=page.locator('.work-card h4 a').first();await card.click();await page.locator('.job-summary').getByText('Demo acceptance summary',{exact:true}).waitFor();await page.locator('#jobBody summary').click();const activity=page.locator('#jobBody details a');await activity.focus();state.pr=77;await advanceRoom(page,15001);await page.waitForFunction(()=>document.querySelector('#jobBody').textContent.includes('PR #77'));assert.equal(await activity.evaluate(e=>e===document.activeElement),true);
 await page.locator('#jobClose').click();await page.waitForFunction(()=>document.querySelector('.work-card h4 a')===document.activeElement);
});
test('finding 9: persisted pagehide/pageshow continues Control Room polling',async t=>{
 const {page,state}=await open(t);await page.locator('#tabAttention').click();await page.waitForSelector('#incidentGroups [data-incident]');
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
test('finding 11: sidebar shares active-deal scope including adapter-normalized Closed and inactive states',async t=>{
 const {page,state}=await open(t);state.dealStates=true;await page.locator('#appSyncRefresh').click();
 await page.waitForFunction(()=>document.querySelector('#appTodayNeeds').textContent.includes('Demo active'));
 for(const id of ['appTodayNeeds','appWorkingList']){assert.deepEqual(await page.locator(`#${id} [data-layout-deal]`).allTextContents(),['Demo active']);}
});
test('incident filters and details dispatch once per click after retained and replaced renders',async t=>{
 const {page,state,errors}=await open(t,{countIncidentClicks:true});await page.locator('#tabAttention').click();
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
 const {page,state}=await open(t,{path:'/control-room?mode=live&board=demo-project',unboundBoard:true});
 const card=page.locator('#board-stages .board-card').first();await card.waitFor();await card.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);
 assert.match(await page.locator('#jobBody').textContent(),/Work Request unavailable/);
 if(failure==='unpublished')state.boardUnpublished=true;else state.boardFailure=failure;await page.locator('#board-retry').evaluate(button=>button.click());await page.waitForFunction(()=>document.querySelector('#board-error').hidden===false);
 if(failure!==503){assert.equal(await page.locator('#jobDialog').evaluate(node=>node.open),false);assert.equal(await page.locator('#jobBody').textContent(),'');}
 else {assert.match(await page.locator('#jobBody').textContent(),/Source unavailable.*Last-known/);await page.locator('#jobClose').click();await card.click();assert.match(await page.locator('#jobBody').textContent(),/Source unavailable.*Last-known/);}
});
for(const partial of [false,true])test(`PR132 #4: ${partial?'partial':'unknown'} schedule observations remain visible in calendar and List`,async t=>{
 const {page,state}=await open(t);state[partial?'partialSchedule':'scheduleUnknown']=true;await advanceRoom(page,16001);await page.locator('#tabAutomations').click();
 assert.match(await page.locator('#panelAutomations').textContent(),partial?/unavailable.*source|source.*unavailable/i:/Automations unavailable/);
 const calendar=page.locator('#automationCalendar');assert.equal(await calendar.locator('[role="status"]').evaluate(node=>getComputedStyle(node).gridColumn),'1 / -1');
 const grid=await calendar.boundingBox(),sunday=await calendar.locator('.calendar-weekday').first().boundingBox();assert.ok(sunday.x<grid.x+grid.width/7,'Sunday occupies the first calendar column');
 await page.getByRole('link',{name:'List',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#automationListState').textContent.includes('unavailable'));
 assert.match(await page.locator('#automationListState').textContent(),/unavailable/i);assert.doesNotMatch(await page.locator('#automationListState').textContent(),/No automations/);
});
test('PR132 #3: failed List read retains unavailable selection state',async t=>{
 const {page,state}=await open(t);await page.goto('http://localhost/control-room/automations?mode=live');await page.locator('#automationList .automation-job').first().waitFor();
 state.scheduleFailure=true;await page.clock.runFor(15001);await page.waitForFunction(()=>document.querySelector('#automationListState').textContent.includes('unavailable'));
 await page.locator('#automationList .automation-job').first().click();assert.match(await page.locator('#jobBody').textContent(),/Source unavailable.*Last-known/);
});
test('PR132 #5: paused configured jobs have an unknown next time in both surfaces',async t=>{
 const {page}=await open(t);await page.locator('#tabAutomations').click();
 const paused=page.locator('#automationUndated [data-state="paused"]');await paused.waitFor();assert.doesNotMatch(await paused.textContent(),/Unscheduled/);assert.match(await paused.textContent(),/unknown.*paused/i);
 assert.doesNotMatch(await page.locator('#automationUndated h3').textContent(),/Unscheduled/);
 await page.getByRole('link',{name:'List',exact:true}).click();await page.locator('#automationList [data-state="paused"]').waitFor();assert.match(await page.locator('#automationList [data-state="paused"]').textContent(),/unknown.*paused/i);
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
