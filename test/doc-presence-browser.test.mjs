import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from './browser-harness.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { workspace, detail } from './leads-workspace-fixture.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
const root=new URL('../',import.meta.url);
const contract=JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
async function setup(t,{width=1440,motion='no-preference',onRoute,engine=chromium}={}) {
 const browser=await engine.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion});
 // Playwright polls synchronous predicates. Import the page store once so
 // readiness checks return a boolean rather than a truthy Promise.
 await page.addInitScript(()=>window.addEventListener('DOMContentLoaded',()=>{
  import(new URL('/js/doc-context.js',location.href).href).then(({pageDocContext})=>{window.docContext=pageDocContext;});
 },{once:true}));
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 const calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(!['http://localhost','https://app.doctorcre.com'].includes(url.origin))return route.abort();
  if(onRoute && await onRoute(route,{url,fixture}))return;
  if(url.pathname==='/mcp'){
  const {name,arguments:args}=request.postDataJSON().params;calls.push({name,args});let value={ok:true};
   if(name==='read-doc-outcome-cards')return rpc(route,await fixture.docOutcomeCards(args));
   const methods={'deal-room-board':'getBoard','get-deal-room':'getDeal','deal-room-changes':'getChanges','today-triage':'todayTriage','list-doc-suggestions':'listDocSuggestions','decide-doc-suggestion':'decideDocSuggestion','list-doc-conversations':'listDocConversations','read-doc-conversation':'readDocConversation','loop-board':'loopBoard','read-loop':'readLoop','incident-board':'incidentBoard','current-work-item':'currentWorkItem','current-work-requests':'currentWorkRequests','notification-feed':'notificationFeed','list-industry-events':'listIndustryEvents','find':'find','find-and-catch-up':'findAndCatchUp'};
   if(name==='lead-board') value={leads:[],stages:[],as_of:new Date().toISOString()};
   else if(name==='claim-card') value={claimable:0,candidates:[],needs_contact_count:0};
   else if(methods[name]) { value=await fixture[methods[name]](name==='get-deal-room'?args.deal||args.deal_id:name==='deal-room-changes'?args.cursor:args); if(name==='get-deal-room') value={...value.deal,deal_id:value.deal.id,thread:value.thread,critical_dates:value.critical_dates.map(row=>({...row,due_on:row.date})),next_actions:value.next_actions,activities:value.activities,events:[]}; }
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(value)}]}})});
  }
  if(url.pathname==='/api/system-work/current')return route.fulfill({json:{ok:true,data:await fixture.currentWorkRequests()}});
  if(url.pathname.startsWith('/api/')) return route.fulfill({contentType:'application/json',body:'{}'});
  const file=contract.routes[url.pathname]||url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 const goto=async path=>{await page.goto('http://localhost'+path,{waitUntil:'domcontentloaded'});await page.locator('#docPresence').waitFor();};
 return{page,goto,calls,errors};
}

test('shared Doc presence appears on every authenticated route; narrow drawers never hide it',async t=>{
 const{page,goto,errors,calls}=await setup(t);
 for(const width of [1440,390]) { await page.setViewportSize({width,height:960});
 for(const path of ['/', '/deals', '/leads', '/tours', '/clients','/vendors','/calendar','/ideas-events','/control-room','/control-room/progress','/work-requests','/all-work','/incidents','/control-room/progress/work','/updates','/doc-chats','/doc-chats/work','/search','/status','/design-lab']){
  try { await goto(path); } catch(error) { throw new Error(path+' '+JSON.stringify(errors)+' '+error.message); } assert.equal(await page.locator('body > #docPresence').count(),1,path);
  assert.equal(await page.locator('#docOpen').isVisible(),true,path);
  assert.equal(await page.locator('#docChat:visible').count(),0,path);
  await page.locator('#docOpen').click();assert.equal(await page.locator('#docDetail').evaluate(n=>n.open),true,path);await page.keyboard.press('Escape');
 }
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(calls.filter(call=>! /^(list-|read-|get-|deal-room-|morning-brief|today-triage|lead-board|claim-card|loop-board|incident-board|current-work-|notification-feed|correspondence-|doc-outcome-cards|unfinished-work|industry-events|resource-dashboard|schedule-board)/.test(call.name)).map(call=>call.name),[]);
});

test('page facts and exact selection, existing suggestions, one-tap approval, inert original entry and responsive renders',async t=>{
 const{page,goto,errors,calls}=await setup(t);
 await goto('/deals?mode=live&deal=d14');
 await page.locator('#recordPanel[open]').waitFor();
 await page.locator('#recordPanel > #docPresence').waitFor();
 await page.waitForFunction(()=>document.querySelector('#recordPanel > #docPresence')?.dataset.state==='ready');
 assert.equal(await page.getByRole('button',{name:'Deal outlook',exact:true}).count(),1);
 assert.ok(await page.locator('[data-jev-deal]').evaluate(n=>n.getBoundingClientRect().height)>=44);
 assert.doesNotMatch(await page.locator('#recordPanel').innerText(),/Jev|Read this deal|lint|leak check/);
 await mkdir(new URL('out/test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('out/test-artifacts/w8/record-presence-desktop.png',root).pathname,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('out/test-artifacts/w8/record-presence-phone.png',root).pathname,animations:'disabled'});
 const persistent=await page.locator('#recordPanel').evaluate(dialog=>{
  dialog.scrollTop=500;
  const presence=dialog.querySelector('#docPresence').getBoundingClientRect();
  const visible=presence.top>=0 && presence.bottom<=window.innerHeight && presence.right<=window.innerWidth;
  dialog.scrollTop=0;return visible;
 });assert.equal(persistent,true);
 await page.setViewportSize({width:1440,height:960});
 await page.locator('#recordPanel #docOpen').click();
 assert.equal(await page.locator('#docRecord').isDisabled(),true);
 assert.equal(await page.locator('#docRecord').inputValue(),'deal:d14');
 assert.match(await page.locator('#docFacts').innerText(),/Confirm fictional commencement/);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#recordPanel #docOpen').evaluate(n=>n===document.activeElement),true);
 const detailReads=calls.filter(call=>call.name==='get-deal-room').length;
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name==='get-deal-room');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await refreshed;
 await page.waitForFunction(()=>document.querySelector('#recordPanel > #docPresence')?.dataset.state==='ready' && window.docContext?.snapshot().active?.title==='Demo Surgical Practice');
 assert.ok(calls.filter(call=>call.name==='get-deal-room').length>detailReads);
 await page.locator('#recordPanel #docOpen').click();
 assert.equal(await page.locator('#docRecord').inputValue(),'deal:d14');
 await page.keyboard.press('Escape');
 await page.locator('#panelClose').click();
 await page.locator('body > #docPresence').waitFor();
 await page.waitForFunction(()=>document.querySelector('#docSuggestions')?.textContent.includes('Confirm the survey'));
 await page.locator('#docOpen').click();await page.locator('#docRecord').selectOption('deal:d14');
 assert.match(await page.locator('#docFacts').innerText(),/Confirm fictional commencement/);
 await mkdir(new URL('out/test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('out/test-artifacts/w8/staged-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('out/test-artifacts/w8/staged-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:1440,height:960});
 await page.locator('[data-doc-approve]').click();await page.waitForFunction(()=>document.querySelector('#docApprovalStatus')?.textContent==='Discussion approved');
 assert.equal(calls.filter(call=>call.name==='decide-doc-suggestion').length,1);
 const decision=calls.find(call=>call.name==='decide-doc-suggestion');assert.equal(decision.args.choice,'discuss');assert.equal(decision.args.base_version,1);
 assert.equal(await page.locator('[data-doc-approve]').count(),0);
 assert.ok(await page.locator('#docDetail').evaluate(n=>n.getBoundingClientRect().width)>900);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mkdir(new URL('out/test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('out/test-artifacts/w8/doc-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.keyboard.press('Escape');await page.screenshot({path:new URL('out/test-artifacts/w8/presence-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});await page.locator('#docOpen').click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('#docDetail').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:new URL('out/test-artifacts/w8/doc-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.keyboard.press('Escape');await page.screenshot({path:new URL('out/test-artifacts/w8/presence-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.doc-presence .doc-orb').evaluate(n=>getComputedStyle(n).animationName),'none');
 await page.locator('#docOpen').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');
 assert.equal(await page.locator('#docOpen').evaluate(n=>n===document.activeElement),true);
 assert.deepEqual(errors,[]);
});

test('selection/filter changes cancel context, auto-refresh recovers and no write happens without a click',async t=>{
 const{page,goto,calls}=await setup(t);await page.clock.install();
 await goto('/deals?mode=live');
 await page.waitForFunction(()=>document.querySelector('#docSuggestions')?.textContent.includes('Confirm the survey'));
 const result=await page.evaluate(async()=>{
  const {pageDocContext}=await import('/js/doc-context.js');
  const ticket=pageDocContext.begin('getBoard');pageDocContext.fail(ticket,{status:401});return pageDocContext.snapshot();
 });assert.equal(result.ready,false);
 assert.match(await page.locator('#docSuggestions').innerText(),/Unavailable/);
 await page.clock.fastForward(31_000);
 await page.waitForFunction(()=>document.querySelector('#docSuggestions')?.textContent.includes('Confirm the survey'));
 assert.equal(calls.filter(call=>call.name==='decide-doc-suggestion').length,0);
});

const readContext=page=>page.evaluate(async()=> (await import('/js/doc-context.js')).pageDocContext.snapshot());
// Native close is queued separately from the key press. Wait for the product
// state as well as the dialog before inspecting the resulting projection.
async function escapeRecord(page, selector) {
 await page.evaluate(selector=>{
  window.recordCloseObserved=false;
  document.querySelector(selector).addEventListener('close',()=>queueMicrotask(()=>{window.recordCloseObserved=true;}),{once:true});
 },selector);
 await page.keyboard.press('Escape');
 await page.waitForFunction(selector=>window.recordCloseObserved&&!document.querySelector(selector).open &&
  window.docContext?.snapshot().selected===null,selector);
}
const rpc=async(route,payload)=>route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
const tourId='22222222-2222-4222-8222-222222222222';
const sampleTour={id:tourId,name:'Sample Tour',status:'draft',version:1,stops:[]};
async function producerRoute(route,{url,fixture}) {
 if(url.pathname==='/mcp'){
  const {name,arguments:args}=route.request().postDataJSON().params;
  if(name==='lead-board'){const board=workspace();await rpc(route,{...board,...(args.lead_id?{detail:detail(board.leads.find(row=>row.id===args.lead_id))}:{})});return true;}
  if(name==='loop-board'){await rpc(route,{loops:[{number:1,label:'Sample idea',kind:'idea',owner:'sample',version:1}]});return true;}
  if(name==='read-loop'){await rpc(route,{loop:{number:1,loop_id:'sample-idea',title:'Sample idea',kind:'idea',version:1}});return true;}
 }
 if(url.pathname.startsWith('/api/')){
  let data;
  if(url.pathname==='/api/tours/library')data={tours:[sampleTour]};
  if(url.pathname==='/api/tours/detail')data=sampleTour;
  if(url.pathname==='/api/v1/business/clients')data={rows:[],page:1,page_count:1};
  if(url.pathname==='/api/system-work/current'){await route.fulfill({json:{ok:true,data:await fixture.currentWorkRequests()}});return true;}
  if(url.pathname==='/api/room/turns'){await route.fulfill({json:{turns:[{seq:1,msg_id:'sample-turn',body:'Sample turn',at:new Date().toISOString(),origin_actor:'joe',kind:'turn',seat:'human',sponsor:'joe'}],latest_seq:1,more:false,actor:{slug:'joe'},csrf_token:'synthetic'}});return true;}
  if(url.pathname==='/api/room/queue'){await route.fulfill({json:{live:true,projected_at:new Date().toISOString(),events:[]}});return true;}
  if(data){await route.fulfill({json:{data,csrf_token:'synthetic'}});return true;}
 }
 return false;
}
for(const failure of [null,503,401])test(`R1/R2 Home healthy/partial/expired context survives scope correctly (${failure})`,async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/mcp' && route.request().postDataJSON().params.name==='incident-board' && failure){await route.fulfill({status:failure,body:'{}'});return true;}
  return producerRoute(route,env);
 }});
 await goto('/?mode=live');await page.waitForFunction(()=>document.querySelector('#refreshHome').getAttribute('aria-busy')==='false');
 const before=await readContext(page);
 assert.equal(before.ready,failure===null,JSON.stringify(before));
 if(!failure){assert.ok(before.records.some(r=>r.kind==='deal'));assert.ok(before.records.some(r=>r.kind==='work'));}
 await page.locator('[data-scope="mine"]').click();const after=await readContext(page);
 assert.equal(after.ready,failure===null);if(failure===401)assert.equal(after.records.length,0);
 if(!failure)assert.ok(after.records.some(r=>r.kind==='work'));
});
test('initial Queue read uses the mounted Wire filter scope and publishes its first response',async t=>{
 let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/api/room/queue'){started();await held;await route.fulfill({json:queuePayload('running')});return true;}
  return producerRoute(route,env);
 }});
 await goto('/control-room/progress/work');await entered;
 await page.waitForFunction(()=>window.docContext?.snapshot().records.some(r=>r.kind==='room-turn'));
 release();await page.waitForFunction(()=>document.querySelector('.queue-card-meta')?.textContent.includes('running'));
 const c=await readContext(page);assert.equal(c.ready,true);assert.ok(c.records.some(r=>r.kind==='room-task'));
});
test('versioned Leads details bind popup identity and native close clears it',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/leads?mode=live');
 await page.locator('.lead-card').first().click();
 await page.waitForFunction(()=>document.querySelector('#detailBody')?.textContent.includes('Correspondence'));let c=await readContext(page);
 assert.equal(c.ready,true,JSON.stringify(c));assert.deepEqual(c.selected,{kind:'lead',id:workspace().leads[0].id});assert.equal(c.active.title,'Dr. Example 1');
 await escapeRecord(page,'#leadDetail');assert.equal((await readContext(page)).selected,null);
});
test('held Leads collection recovers in the current local filter before opening a visible sidebar lead',async t=>{
 let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page,goto,errors}=await setup(t,{onRoute:async(route,env)=>{
  const params=env.url.pathname==='/mcp'?route.request().postDataJSON().params:null;
  if(params?.name==='lead-board' && params.arguments.workspace==='leads' && !params.arguments.lead_id){
   started();await held;await rpc(route,workspace());return true;
  }
  return producerRoute(route,env);
 }});
 await goto('/leads?mode=live');await entered;
 await page.locator('#appSidebarToggle').click();
 await page.locator('#leadSearch').fill('no matches');
 release();await page.waitForFunction(()=>document.querySelectorAll('#hotLeads [data-lead-id]').length>0);
 assert.equal(await page.locator('.lead-card').count(),0);
 const filtered=await readContext(page);
 assert.equal(filtered.ready,true,JSON.stringify(filtered));assert.deepEqual(filtered.records,[]);
 assert.equal(filtered.filters.search,'no matches');assert.ok(filtered.observedAt);
 await page.locator('#hotLeads [data-lead-id]').first().click();
 await page.waitForFunction(()=>document.querySelector('#detailBody')?.textContent.includes('Correspondence'));
 const opened=await readContext(page);assert.equal(opened.ready,true);assert.equal(opened.active.title,'Dr. Example 1');
 await escapeRecord(page,'#leadDetail');
 await page.locator('#leadSearch').fill('');
 const restored=await readContext(page);assert.equal(restored.ready,true);assert.ok(restored.records.length>0);
 assert.equal(restored.observedAt,filtered.observedAt);assert.deepEqual(errors,[]);
});
test('close readiness waits until queued context cleanup finishes',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/leads?mode=live');
 await page.locator('.lead-card').first().click();
 await page.evaluate(async()=>{
  const c=(await import('/js/doc-context.js')).pageDocContext,select=c.select;
  c.select=(kind,id)=>id===null?setTimeout(()=>select(kind,id),250):select(kind,id);
 });
 await escapeRecord(page,'#leadDetail');
 assert.equal((await readContext(page)).selected,null);
});
test('R14/R15/R16 Ideas searches, Escape and tab return keep correctly scoped observations',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await page.goto('https://app.doctorcre.com/ideas-events',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#ideaList')?.textContent.includes('Sample idea'));
 await page.locator('.idea-tile').first().click();await page.waitForFunction(()=>document.querySelector('#ideaDialogBody .idea-rows'));assert.equal((await readContext(page)).selected?.id,'sample-idea');
 await escapeRecord(page,'#ideaDialog');assert.equal((await readContext(page)).selected,null);
 const before=await readContext(page);await page.locator('#ideaSearch').fill('no match');await page.waitForFunction(()=>document.querySelectorAll('.idea-tile').length===0);
 const filtered=await readContext(page);assert.equal(filtered.records.length,0);assert.equal(filtered.filters.query,'no match');assert.equal(filtered.observedAt,before.observedAt);
 await page.locator('#tabEvents').click();await page.waitForFunction(()=>document.querySelector('#docPresence').dataset.state==='ready');await page.locator('#tabIdeas').click();await page.waitForFunction(()=>document.querySelector('#docPresence').dataset.state==='ready');assert.equal((await readContext(page)).ready,true);
});
test('R6/R14 Tour background failure clears eligibility; search constrains original observation',async t=>{
 let outage=false;const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(outage && env.url.pathname==='/api/tours/detail'){await route.fulfill({status:503,json:{}});return true;}return producerRoute(route,env);
 }});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 assert.equal((await readContext(page)).ready,true);outage=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#detail-message').textContent.includes('unavailable'));
 assert.equal((await readContext(page)).ready,false);
 await escapeRecord(page,'#tour-dialog');await page.locator('#tour-filter').fill('no match');
 const c=await readContext(page);assert.equal(c.records.length,0);assert.equal(c.filters.query,'no match');assert.equal(c.ready,true);
});
for(const path of ['/api/tours/library','/api/v1/business/clients','/api/tours/detail'])test(`R6 Tour authorization loss from ${path} clears global context`,async t=>{
 let denied=false;const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(denied && env.url.pathname===path){await route.fulfill({status:401,json:{}});return true;}return producerRoute(route,env);
 }});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#tour-library-state').textContent.includes('Sign in'));
 const c=await readContext(page);assert.equal(c.ready,false);assert.equal(c.records.length,0);
});
test('R8 delayed approval receipt cannot appear under a different record',async t=>{
 let release,started;const wait=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page,goto,calls}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='decide-doc-suggestion'){started();await wait;const args=route.request().postDataJSON().params.arguments;await rpc(route,{ok:true,suggestion_id:args.suggestion_id,choice:'discuss',version:args.base_version+1});return true;}
  return false;
 }});await goto('/deals?mode=live');await page.waitForFunction(()=>document.querySelector('[data-doc-suggestion]'));await page.locator('#docOpen').click();await page.locator('[data-doc-approve]').click();await entered;
 await page.keyboard.press('Escape');await page.evaluate(async()=>{const c=(await import('/js/doc-context.js')).pageDocContext;c.select('deal','d1');});await page.locator('#docOpen').click();release();
 await page.waitForTimeout(100);assert.equal(await page.locator('#docApprovalStatus').textContent(),'');
});
const queuePayload=(status='running',at=new Date().toISOString())=>({live:true,projected_at:new Date().toISOString(),events:[{task_id:'t_sample',summary:'Sample task',projected_at:new Date().toISOString(),card:{title:'Sample task',status,priority:'normal',target:'sol',updated_at:at}}]});
test('R3 retained Taskboard card navigation opens its own recorded work scope',async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{if(env.url.pathname==='/api/room/queue'){await route.fulfill({json:queuePayload()});return true;}return producerRoute(route,env);}});
 await goto('/control-room/progress/work');await page.locator('.queue-card').first().click();await page.waitForURL('**/control-room/progress/work?board=carr-v5&task=t_sample');
 assert.equal((await readContext(page)).filters.task,'t_sample');
});
for(const staleFailure of [false,true])test(`R4 superseded Queue ${staleFailure?'failure':'success'} cannot replace newer facts`,async t=>{
 let reads=0,release,started;const pending=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/api/room/queue'){
   if(++reads===1){started();await pending;await route.fulfill(staleFailure?{status:503,json:{}}:{json:queuePayload('running','2026-10-01T10:00:00Z')});}
   else await route.fulfill({json:queuePayload('done','2026-10-01T11:00:00Z')});return true;
  }return producerRoute(route,env);
 }});await page.clock.install();await goto('/control-room/progress/work');await entered;await page.clock.fastForward(5000);
 await page.waitForFunction(()=>document.querySelector('.queue-card-meta')?.textContent.includes('done'));release();await page.waitForTimeout(100);
 const c=await readContext(page);assert.equal(c.ready,true);assert.equal(c.records.find(r=>r.kind==='room-task')?.fields.find(f=>f.label==='Status').value,'done');
 assert.match(await page.locator('.queue-card-meta').textContent(),/done/);
});
test('R5 failed Wire read stays unavailable when filtering retained turns',async t=>{
 let denied=false;const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(denied&&env.url.pathname==='/api/room/turns'){await route.fulfill({status:503,json:{}});return true;}return producerRoute(route,env);
 }});await page.clock.install();await goto('/control-room/progress/work');await page.waitForFunction(()=>document.querySelector('#wireFeed').textContent.includes('Sample turn'));
 assert.equal((await readContext(page)).ready,true);denied=true;await page.clock.fastForward(6000);await page.waitForFunction(()=>document.querySelector('#roomBanner').textContent.includes('offline'));
 assert.equal((await readContext(page)).ready,false);await page.locator('#wireSearch').fill('Sample');assert.equal((await readContext(page)).ready,false);
});
for(const dataset of ['clients','vendors'])test(`R12/R13/R18 ${dataset} facts and unsorted activity use the real directory seam`,async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname.startsWith('/api/v1/business/')){await route.fulfill({json:directoryFixture(url.href)});return true;}
  if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='find-and-catch-up'){
   await rpc(route,{state:'completed',match:{kind:dataset==='clients'?'client':'vendor',target:dataset==='clients'?'C-DEMO-1':'V-DEMO-1'},catch_up:{timeline:[{summary:'Older review',occurred_at:'2026-10-01T10:00:00Z'},{summary:'Newer review',occurred_at:'2026-10-01T11:00:00Z'}]}});return true;
  }return false;
 }});await goto('/'+dataset+'?mode=live');await page.locator('.record-row').first().click();await page.waitForFunction(()=>document.querySelector('#recordActivity')?.textContent.includes('Newer review'));
 const c=await readContext(page);assert.equal(c.ready,true);assert.equal(c.active.fields.find(f=>f.label==='Owner').value,'Joe');assert.equal(c.active.fields.find(f=>f.label==='Status').value,dataset==='clients'?'Active':'Warm');assert.equal(c.active.activity[0]?.text,'Newer review');
});
test('R11/R18 Search completed catch-up supports positive context through live MCP',async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname!=='/mcp')return false;const {name,arguments:args}=route.request().postDataJSON().params;
  if(name==='find'){await rpc(route,{parties:[{ref:'C-SAMPLE',kind:'client',name:'Sample Practice',city:null,specialty:null,org_name:null,merged:false}],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Sample'});return true;}
  if(name==='find-and-catch-up'){await rpc(route,{state:'completed',match:{kind:'client',name:'Sample Practice',target:'C-SAMPLE'},catch_up:{timeline:[{summary:'Sample review',occurred_at:'2026-10-01T12:00:00Z'}]}});return true;}return false;
 }});await page.goto('https://app.doctorcre.com/search',{waitUntil:'domcontentloaded'});await page.locator('#searchQuery').fill('Sample');await page.locator('#searchForm').dispatchEvent('submit');await page.waitForFunction(()=>{const c=window.docContext?.snapshot();return c?.ready&&c.records.some(r=>r.kind==='catch-up'&&r.activity[0]?.text==='Sample review');});
 const c=await readContext(page);assert.equal(c.records.find(r=>r.kind==='catch-up'&&r.id==='C-SAMPLE')?.activity[0].text,'Sample review');
});
for(const failure of ['timeout','malformed'])test(`R6 Tour background ${failure} invalidates eligible context`,async t=>{
 let outage=false,release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(outage&&env.url.pathname==='/api/tours/detail'){
   if(failure==='timeout'){started();await held;await route.fulfill({json:{data:sampleTour,csrf_token:'synthetic'}});}else await route.fulfill({json:{data:{id:tourId},csrf_token:'synthetic'}});return true;
  }return producerRoute(route,env);
 }});if(failure==='timeout')await page.clock.install();await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 outage=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));if(failure==='timeout'){await entered;await page.clock.fastForward(11000);}await page.waitForFunction(()=>document.querySelector('#detail-message').textContent.includes('unavailable'));
 assert.equal((await readContext(page)).ready,false);
});
test('R14 Tour no-match projection changes scope and preserves the library observation',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/tours');await page.locator('.tour-button').first().waitFor();const before=await readContext(page);
 await page.locator('#tour-filter').fill('no match');await page.waitForFunction(()=>document.querySelectorAll('.tour-button').length===0);
 const after=await readContext(page);assert.equal(after.records.length,0);assert.equal(after.filters.query,'no match');assert.ok(after.epoch>before.epoch);assert.equal(after.observedAt,before.observedAt);assert.equal(after.ready,true);
});
test('R15/R16 browser Back restores the Ideas tab scope and pagehide clears selection',async t=>{
 const {page}=await setup(t,{onRoute:producerRoute});await page.goto('https://app.doctorcre.com/ideas-events');await page.locator('.idea-tile').first().waitFor();
 await page.locator('#tabEvents').click();await page.locator('#tabIdeas').click();await page.goBack();await page.waitForFunction(()=>document.querySelector('#tabEvents').getAttribute('aria-selected')==='true');
 assert.equal((await readContext(page)).page,'events');
 await page.locator('#tabIdeas').click();await page.locator('.idea-tile').first().click();await page.waitForFunction(()=>document.querySelector('#ideaDialogBody .idea-rows'));
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));assert.equal((await readContext(page)).selected,null);
});
for(const verb of ['loop-board','list-industry-events'])test(`R1/R16 Ideas tab cache cannot recover after ${verb} authorization loss`,async t=>{
 let denied=false,authLost=false;const {page}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/mcp'&&(authLost||(denied&&route.request().postDataJSON().params.name===verb))){authLost=true;await route.fulfill({status:401,json:{}});return true;}return producerRoute(route,env);
 }});await page.goto('https://app.doctorcre.com/ideas-events');await page.locator('.idea-tile').first().waitFor();await page.locator('#tabEvents').click();await page.waitForFunction(()=>document.querySelector('#docPresence').dataset.state==='ready');await page.locator('#tabIdeas').click();
 denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(120);
 await page.locator('#tabEvents').click();assert.equal((await readContext(page)).ready,false);assert.equal((await readContext(page)).records.length,0);
});
test('R11/R12 valid empty directory activity remains an authorized empty read',async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname.startsWith('/api/v1/business/')){await route.fulfill({json:directoryFixture(url.href)});return true;}
  if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='find-and-catch-up'){await rpc(route,{state:'completed',match:{kind:'client',target:'C-DEMO-1'},catch_up:{timeline:[]}});return true;}return false;
 }});await goto('/clients?mode=live');await page.locator('.record-row').first().click();await page.waitForFunction(()=>document.querySelector('#recordActivity')?.textContent.includes('No recent activity'));
 const c=await readContext(page);assert.equal(c.ready,true);assert.deepEqual(c.active.activity,[]);
});

test('R14 Tour closed detail cannot survive a no-match library filter',async t=>{
 const {page,goto}=await setup(t,{onRoute:producerRoute});await goto('/tours');await page.locator('.tour-button').first().click();await page.waitForFunction(()=>document.querySelector('#detail-title').textContent==='Sample Tour');
 await escapeRecord(page,'#tour-dialog');await page.locator('#tour-filter').fill('no match');assert.equal((await readContext(page)).records.length,0);
});

test('R13/R18 incomplete conversation reports unknown recent activity in the answer and visible Doc',async t=>{
 const id='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
 const {page,goto}=await setup(t,{onRoute:async(route,{url,fixture})=>{
  if(url.pathname!=='/mcp'||route.request().postDataJSON().params.name!=='read-doc-conversation')return false;
  await rpc(route,{...await fixture.readDocConversation({conversation_id:id}),latest_sequence:6,more:true,
   turns:[{sequence:1,body:'Earlier sample turn',at:'2026-10-01T10:00:00Z'},
    {sequence:2,body:'Later sample turn on first page',at:'2026-10-01T11:00:00Z'}]});return true;
 }});
 await goto('/doc-chats?mode=live&id='+id);
 await page.waitForFunction(()=> {const c=window.docContext?.snapshot();return c?.ready&&c.active?.activityComplete===false;});
 await page.locator('#docOpen').click();
 assert.equal(await page.locator('#docActivity').innerText(),'Recent activity unavailable.');
 assert.doesNotMatch(await page.locator('#docActivity').innerText(),/read|source|incomplete/i);
 assert.equal(await page.locator('#docActivity article').count(),0);
 const answer=await page.evaluate(async id=>{
  const c=(await import('/js/doc-context.js')).pageDocContext;
  return (await import('/js/doc-context-model.js')).docAnswer(c.snapshot(),{kind:'conversation',recordId:id,question:'Recent activity'});
 },id);
 assert.equal(answer.state,'unknown');assert.equal(answer.value,null);
 assert.deepEqual((await readContext(page)).recentActivity,[]);
});
test('R18 closed Deal detail cannot survive an empty board projection',async t=>{
 let empty=false;
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{
  if(empty && url.pathname==='/mcp' && route.request().postDataJSON().params.name==='deal-room-board'){await rpc(route,{deals:[],actor:'joe',workspace_kind:'team'});return true;}return false;
 }});await page.clock.install();await goto('/deals?mode=live&deal=d14');
 await page.waitForFunction(()=>window.docContext?.snapshot().active?.id==='d14');
 await page.locator('#panelClose').click();
 await page.waitForFunction(()=>window.docContext?.snapshot().selected===null);
 empty=true;await page.clock.fastForward(31_000);
 await page.waitForFunction(()=>document.querySelectorAll('.kanban-card').length===0);
 const c=await readContext(page);assert.equal(c.ready,true);assert.deepEqual(c.records,[]);
});
test('R18 a held Search response cannot publish under a later query scope',async t=>{
 let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());
 const {page}=await setup(t,{onRoute:async(route,{url})=>{
  if(url.pathname!=='/mcp'||route.request().postDataJSON().params.name!=='find')return false;
  started();await held;await rpc(route,{parties:[{ref:'C-SAMPLE',kind:'client',name:'Old query sample',merged:false}],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Sample'});return true;
 }});
 await page.goto('https://app.doctorcre.com/search');
 await page.evaluate(async()=>{
  const c=(await import('/js/doc-context.js')).pageDocContext,finish=c.finish;
  c.finish=(...args)=>{const result=finish(...args);window.finishedFind=result;return result;};
 });
 await page.locator('#searchQuery').fill('Old query');await page.locator('#searchForm').dispatchEvent('submit');await entered;
 await page.locator('#searchQuery').fill('');await page.locator('#searchForm').dispatchEvent('submit');
 release();await page.waitForFunction(()=>window.finishedFind!==undefined);
 assert.equal(await page.evaluate(()=>window.finishedFind),false);
 const c=await readContext(page);assert.equal(c.filters.query,'');assert.deepEqual(c.records,[]);assert.equal(c.ready,false);
});

for(const prefix of ['plan','space'])test(`R6 ${prefix} client record authorization loss clears Tour context`,async t=>{
 const client={id:'11111111-1111-4111-8111-111111111111',name:'Sample Practice'};
 const {page,goto}=await setup(t,{onRoute:async(route,env)=>{
  if(env.url.pathname==='/api/v1/business/clients'){await route.fulfill({json:{data:{rows:[client],page:1,page_count:1},csrf_token:'synthetic'}});return true;}
  if(env.url.pathname===`/api/v1/business/clients/${client.id}`){await route.fulfill({status:401,json:{}});return true;}return producerRoute(route,env);
 }});await goto('/tours');await page.locator('.tour-button').first().waitFor();assert.equal((await readContext(page)).ready,true);await page.locator(`#${prefix}-client`).selectOption(client.id);
 await page.waitForFunction(()=>document.querySelector('#tour-library-state').textContent.includes('Sign in'));const c=await readContext(page);assert.equal(c.ready,false);assert.equal(c.records.length,0);
});

for (const [name,engine] of [['chromium',chromium],['webkit',webkit]]) test(`W11 ${name} command bar shortcuts, keyboard results, refresh and responsive motion`,async t=>{
 for(const width of [1440,390,320]) await t.test(String(width),async t=>{
  const {page,goto,calls,errors}=await setup(t,{width,motion:'reduce',engine,onRoute:async(route,{url})=>{if(url.pathname==='/api/tours/library'){await route.fulfill({json:{data:{tours:[{id:tourId,name:'Demo Tour'}]}}});return true;}return false;}});
  await goto('/deals?mode=live');
  const key=name==='webkit'?'Meta':'Control';
  await page.locator('#docOpen').focus();await page.keyboard.press(`${key}+d`);
  assert.equal(await page.locator('#docDetail').evaluate(n=>n.open),true);
  assert.equal(await page.locator('#docCommandInput').evaluate(n=>n===document.activeElement),true);
  await page.keyboard.press('Escape');await page.keyboard.press(`${key}+k`);
  await page.locator('#docCommandInput').fill('Demo');
  await page.waitForFunction(()=>document.querySelectorAll('#docCommandResults [data-doc-result]').length>0);
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await page.locator('#docCommandDetail').isVisible(),true);
  assert.equal(await page.locator('.doc-context-tools').isVisible(),false);
  assert.equal(await page.locator('#docDetail').evaluate(n=>getComputedStyle(n).animationName),'none');
  assert.ok(await page.locator('#docDetail').evaluate(n=>n.getBoundingClientRect().width<=innerWidth));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir(new URL('out/test-artifacts/w11/',root),{recursive:true});
  await page.screenshot({path:new URL(`out/test-artifacts/w11/${name}-${width}.png`,root).pathname,animations:'disabled'});
  await page.locator('#docCommandRefresh').click();assert.equal(await page.locator('#docCommandInput').inputValue(),'Demo');
  assert.deepEqual(errors,[]);
  assert.equal(calls.some(row=>! /^(find$|deal-room-|list-|read-|get-|morning-brief|today-triage|notification-feed|lead-board|claim-card|loop-board|incident-board|current-work-)/.test(row.name)),false);
 });
});

test('R1 Doc search consumes and validates the live wrapped tour library',async t=>{
 const {page,goto}=await setup(t,{onRoute:async(route,{url})=>{if(url.pathname==='/api/tours/library'){await route.fulfill({json:{data:{tours:[{id:tourId,name:'Library Sample'}]}}});return true;}return false;}});
 await goto('/deals?mode=live');await page.locator('#docOpen').click();await page.locator('#docCommandInput').fill('Library Sample');
 await page.getByRole('option',{name:/Library Sample/}).waitFor();await page.getByRole('option',{name:/Library Sample/}).click();
 assert.equal(await page.locator('#docCommandDetail a').getAttribute('href'),`/tours?tour=${tourId}`);
});
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])test(`R8 ${name} long detail title fits inside the 320px Doc dialog`,async t=>{
 const title='Demo'+ 'x'.repeat(180);
 const {page,goto}=await setup(t,{width:320,engine,onRoute:async(route,{url})=>{if(url.pathname==='/mcp'&&route.request().postDataJSON().params.name==='find'){await rpc(route,{parties:[{ref:'C-SAMPLE',kind:'client',name:title,merged:false}],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Synthetic'});return true;}return false;}});
 await goto('/deals?mode=live');await page.locator('#docOpen').click();await page.locator('#docCommandInput').fill('Demo');await page.getByRole('option',{name:new RegExp(title)}).click();
 assert.equal(await page.locator('#docDetail').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.ok(await page.locator('#docCommandBack').evaluate(n=>n.getBoundingClientRect().width)>=44);
});
