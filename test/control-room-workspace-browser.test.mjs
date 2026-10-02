import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createFixtureClient} from '../js/fixture-client.js';
import routes from '../contracts/app-routes.v1.json' with {type:'json'};
const root=new URL('../',import.meta.url);
const reads={'read-progress-board':'readProgressBoard','list-progress-boards':'listProgressBoards','unfinished-work':'unfinishedWork','incident-board':'incidentBoard','governance-queue':'governanceQueue','schedule-board':'scheduleBoard','work-request-card':'workRequestCard','deal-room-board':'getBoard','today-triage':'todayTriage','notification-feed':'notificationFeed','list-notifications':'listNotifications'};
async function open(t,{width=1440}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},timezoneId:'UTC',reducedMotion:'reduce'});page.setDefaultTimeout(5000);
 await page.clock.install({time:new Date('2026-10-02T12:00:00Z')});
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 const errors=[],calls=[];const state={pr:17,title:'Demo dashboard refresh',spend:12.34,denied:false};page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/mcp'){
   const rpc=request.postDataJSON().params;calls.push(rpc.name);if(state.denied)return route.fulfill({status:401,body:'{}'});
   let payload={};if(reads[rpc.name]&&fixture[reads[rpc.name]])payload=await fixture[reads[rpc.name]](rpc.arguments);
   if(rpc.name==='unfinished-work')for(const row of payload.items||[]){row.pr=state.pr;row.title=state.title;}
   if(rpc.name==='read-resource-dashboard'){payload=await fixture.readResourceDashboard();payload.connections=await fixture.readConnections();payload.connections.providers[0].spend.amount=state.spend;}
   if(rpc.name==='work-request-card')payload.desired_outcome='Demo acceptance summary';
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}})});
  }
  if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-test-token'})});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
  const file=routes.routes[url.pathname]||url.pathname.slice(1);
  try{const body=await readFile(new URL(file,root));return route.fulfill({body,contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/control-room?mode=live');
 await page.waitForFunction(()=>document.querySelector('#selfAvatar')?.textContent==='J');
 return {page,state,calls,errors};
}
async function capture(page,name){await mkdir(new URL('test-artifacts/w7/',root),{recursive:true});await page.screenshot({path:new URL(`test-artifacts/w7/${name}.png`,root).pathname,fullPage:true});}
for(const width of [1440,390,320])test(`W7 shared room, cards and wide popup fit ${width}px`,async t=>{
 const {page,calls,errors}=await open(t,{width});await page.waitForSelector('[data-task-id="work_request:WR-000901"]');
 assert.equal(await page.locator('#appLayout').count(),1);assert.equal(await page.locator('#appTabsSlot #controlRoomTabs').count(),1);assert.equal(await page.locator('#appSidebarSlot #board-directory').count(),1);
 assert.equal(await page.locator('.pipeline-node[data-task-id^="governance:"]').count(),4);
 assert.equal(await page.locator('#panelDashboard [id="operationsBlocks"],#resourceDashboard,#headerCoverage').count(),0);
 assert.match(await page.locator('[data-task-id="work_request:WR-000901"]').textContent(),/WR-000901.*PR #17/);
 assert.equal(await page.locator('#board-retry').getAttribute('aria-label'),'Refresh');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(width!==320)await capture(page,`board-${width}`);
 const card=page.locator('[data-task-id="work_request:WR-000901"]');await card.click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);
 await page.locator('.job-summary').getByText('Demo acceptance summary',{exact:true}).waitFor();assert.ok((await page.locator('#jobDialog').boundingBox()).width>=Math.min(900,width-40));
 assert.equal(await page.locator('#jobBody details').evaluate(e=>e.open),false);await page.locator('#jobBody summary').click();
 assert.match(await page.locator('#jobBody pre').textContent(),/Demo acceptance summary/);assert.doesNotMatch(await page.locator('#jobBody pre').textContent(),/projection_state|next_human_action/);
 if(width!==320)await capture(page,`popup-${width}`);
 await page.locator('#jobClose').click();assert.equal(await card.evaluate(e=>document.activeElement===e),true);
 await page.locator('.pipeline-node[data-task-id^="governance:"]').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobBody summary').click();assert.match(await page.locator('#jobBody pre').textContent(),/Demo rule/);await page.locator('#jobClose').click();
 await page.locator('.work-card').first().click();await page.waitForFunction(()=>document.querySelector('#jobDialog').open);await page.locator('#jobClose').click();
 await page.locator('#tabConnections').click();await page.locator('[data-connection="claude"] a').waitFor();assert.equal(await page.locator('[data-device]').count(),2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width!==320)await capture(page,`connections-${width}`);
 assert.ok(calls.every(name=>Object.keys(reads).includes(name)||name==='read-resource-dashboard'),calls.join(', '));assert.deepEqual(errors,[]);
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
 state.pr=23;state.title='Demo updated dashboard';state.spend=18.50;await page.clock.runFor(16001);
 await page.waitForFunction(()=>document.querySelector('#jobBody').textContent.includes('PR #23'));
 assert.equal(await page.locator('#jobDialog').evaluate(e=>e.open),true);assert.equal(await page.locator('#jobBody details').evaluate(e=>e.open),true);assert.equal(await page.locator('#jobBody summary').evaluate(e=>e===document.activeElement),true);
 await page.locator('#jobClose').click();await page.locator('#tabConnections').click();await page.getByText('$18.50 · October 2026',{exact:true}).first().waitFor();
 assert.equal(await page.locator('[data-connection="grok"]').getAttribute('data-state'),'needs_reconnect');assert.equal(await page.locator('[data-device]').count(),2);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='full');assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'connection-breathe');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.connection-dot').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 state.denied=true;await page.clock.runFor(15001);await page.waitForFunction(()=>document.querySelector('[data-connection="claude"]').dataset.state==='unknown');assert.equal(await page.locator('[data-device]').count(),0);assert.match(await page.locator('#devicesState').textContent(),/unavailable/);
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
  const after=await readFile(new URL(`test-artifacts/w7/board-${width}.png`,root));
  assert.equal(before.readUInt32BE(16),width);assert.equal(after.readUInt32BE(16),width);assert.notDeepEqual(before,after);
 }
});
