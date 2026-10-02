import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';
const root=new URL('../',import.meta.url);
const contract=JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
async function setup(t,{width=1440,motion='no-preference'}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion});page.setDefaultTimeout(10000);
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 const calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/mcp'){
   const {name,arguments:args}=request.postDataJSON().params;calls.push({name,args});let value={ok:true};
   const methods={'deal-room-board':'getBoard','get-deal-room':'getDeal','deal-room-changes':'getChanges','today-triage':'todayTriage','list-doc-suggestions':'listDocSuggestions','decide-doc-suggestion':'decideDocSuggestion','list-doc-conversations':'listDocConversations','read-doc-conversation':'readDocConversation','loop-board':'loopBoard','read-loop':'readLoop','incident-board':'incidentBoard','current-work-item':'currentWorkItem','current-work-requests':'currentWorkRequests','notification-feed':'notificationFeed'};
   if(name==='lead-board') value={leads:[],stages:[],as_of:new Date().toISOString()};
   else if(name==='claim-card') value={claimable:0,candidates:[],needs_contact_count:0};
   else if(methods[name]) { value=await fixture[methods[name]](name==='get-deal-room'?args.deal||args.deal_id:name==='deal-room-changes'?args.cursor:args); if(name==='get-deal-room') value={...value.deal,deal_id:value.deal.id,thread:value.thread,critical_dates:value.critical_dates.map(row=>({...row,due_on:row.date})),next_actions:value.next_actions,activities:value.activities,events:[]}; }
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(value)}]}})});
  }
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
 for(const path of ['/', '/deals', '/leads', '/tours', '/clients','/vendors','/calendar','/ideas-events','/control-room','/control-room/progress','/work-requests','/all-work','/incidents','/agent-room','/control-room/agents/queue','/updates','/doc-chats','/doc-chats/work','/search','/status','/design-lab']){
  try { await goto(path); } catch(error) { throw new Error(path+' '+JSON.stringify(errors)+' '+error.message); } assert.equal(await page.locator('#appMainSlot > #docPresence').count(),1,path);
  assert.equal(await page.locator('#docOpen').isVisible(),true,path);
  assert.equal(await page.locator('#docChat:visible').count(),0,path);
  await page.locator('#docOpen').click();assert.equal(await page.locator('#docDetail').evaluate(n=>n.open),true,path);await page.keyboard.press('Escape');
 }
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(calls.filter(call=>! /^(list-|read-|get-|deal-room-|today-triage|lead-board|claim-card|loop-board|incident-board|current-work-|notification-feed|correspondence-|doc-outcome-cards|unfinished-work|industry-events|resource-dashboard|schedule-board)/.test(call.name)).map(call=>call.name),[]);
});

test('page facts and exact selection, existing suggestions, one-tap approval, inert original entry and responsive renders',async t=>{
 const{page,goto,errors,calls}=await setup(t);
 await goto('/deals?mode=live&deal=d14');
 await page.locator('#dealDialog[open]').waitFor();
 await page.locator('#dealDialog > #docPresence').waitFor();
 await page.waitForFunction(()=>document.querySelector('#dealDialog > #docPresence')?.dataset.state==='ready');
 assert.equal(await page.getByRole('button',{name:'Review deal',exact:true}).count(),1);
 assert.ok(await page.locator('[data-jev-deal]').evaluate(n=>n.getBoundingClientRect().height)>=44);
 assert.doesNotMatch(await page.locator('#dealDialog').innerText(),/Jev|Read this deal|lint|leak check/);
 await mkdir(new URL('test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('test-artifacts/w8/record-presence-desktop.png',root).pathname,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('test-artifacts/w8/record-presence-phone.png',root).pathname,animations:'disabled'});
 const persistent=await page.locator('#dealDialog').evaluate(dialog=>{
  dialog.scrollTop=500;
  const card=dialog.getBoundingClientRect(),presence=dialog.querySelector('#docPresence').getBoundingClientRect();
  const visible=presence.top>=card.top && presence.bottom<=card.bottom;
  dialog.scrollTop=0;return visible;
 });assert.equal(persistent,true);
 await page.setViewportSize({width:1440,height:960});
 await page.locator('#dealDialog #docOpen').click();
 assert.equal(await page.locator('#docRecord').isDisabled(),true);
 assert.equal(await page.locator('#docRecord').inputValue(),'deal:d14');
 assert.match(await page.locator('#docFacts').innerText(),/Confirm fictional commencement/);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#dealDialog #docOpen').evaluate(n=>n===document.activeElement),true);
 const detailReads=calls.filter(call=>call.name==='get-deal-room').length;
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name==='get-deal-room');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await refreshed;
 await page.waitForFunction(()=>document.querySelector('#dealDialog > #docPresence')?.dataset.state==='ready' && document.querySelector('#dealDialog #docPageLabel')?.textContent==='Demo Surgical Practice');
 assert.ok(calls.filter(call=>call.name==='get-deal-room').length>detailReads);
 await page.locator('#dealDialog #docOpen').click();
 assert.equal(await page.locator('#docRecord').inputValue(),'deal:d14');
 await page.keyboard.press('Escape');
 await page.locator('[data-close-deal]').click();
 await page.locator('#appMainSlot > #docPresence').waitFor();
 await page.waitForFunction(()=>document.querySelector('#docSuggestions')?.textContent.includes('Confirm the survey'));
 await page.locator('#docOpen').click();await page.locator('#docRecord').selectOption('deal:d14');
 assert.match(await page.locator('#docFacts').innerText(),/Confirm fictional commencement/);
 await mkdir(new URL('test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('test-artifacts/w8/staged-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('test-artifacts/w8/staged-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:1440,height:960});
 await page.locator('[data-doc-approve]').click();await page.waitForFunction(()=>document.querySelector('#docApprovalStatus')?.textContent==='Discussion approved');
 assert.equal(calls.filter(call=>call.name==='decide-doc-suggestion').length,1);
 const decision=calls.find(call=>call.name==='decide-doc-suggestion');assert.equal(decision.args.choice,'discuss');assert.equal(decision.args.base_version,1);
 assert.equal(await page.locator('[data-doc-approve]').count(),0);
 assert.ok(await page.locator('#docDetail').evaluate(n=>n.getBoundingClientRect().width)>900);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mkdir(new URL('test-artifacts/w8/',root),{recursive:true});
 await page.screenshot({path:new URL('test-artifacts/w8/doc-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.keyboard.press('Escape');await page.screenshot({path:new URL('test-artifacts/w8/presence-desktop.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});await page.locator('#docOpen').click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('#docDetail').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:new URL('test-artifacts/w8/doc-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
 await page.keyboard.press('Escape');await page.screenshot({path:new URL('test-artifacts/w8/presence-phone.png',root).pathname,fullPage:page.viewportSize().width>760,animations:'disabled'});
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
