import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';
import { atlasFixtureResponse } from '../scripts/atlas-fixture.mjs';
const root = new URL('../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
const leads = ['New','Contacted','Qualified','Tour ready'].map((stage,i) => ({ id:`synthetic-lead-${i}`,name:`Demo Practice ${i+1}`,stage:stage.toLowerCase().replaceAll(' ','_'),stage_label:stage,owner:'joe',owner_label:'Joe',city:'Demo City',specialty:'Dental',score:80-i,notes:'Review the practice plan. Original synthetic entry with additional context.',updated_at:'2026-10-01T14:00:00Z',version:1 }));
async function open(t,{width=1440,motion='no-preference',clock=false,deniedStorage=false,events=[]}={}) {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion});page.setDefaultTimeout(5000);
  if(clock) await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
  if(deniedStorage) await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Unavailable','SecurityError');}});});
  const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
  const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!=='http://localhost') return route.abort();
    if(url.pathname==='/api/system-work/session') return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'}})});
    if(url.pathname==='/api/v1/command-center') return route.fulfill({contentType:'application/json',body:JSON.stringify(await fixture.commandCenter())});
    if(url.pathname==='/api/v1/atlas-graph'){const result=atlasFixtureResponse(url,'GET');return route.fulfill({status:result.status,contentType:'application/json',body:JSON.stringify(result.body)});}
    if(url.pathname==='/pipeline/changes') return route.fulfill({contentType:'application/json',body:JSON.stringify({events:events.slice(Number(url.searchParams.get('cursor')||0)),cursor:String(events.length),presence:[],capture_sessions:[]})});
    if(url.pathname==='/mcp'){
      const {name,arguments:args}=request.postDataJSON().params;
      let body;
      if(name==='lead-board') body={actor:'joe',generated_at:new Date().toISOString(),leads,stages:leads.map((l,i)=>({slug:l.stage,label:l.stage_label,sort:i}))};
      else if(name==='claim-card') body={claimable:0,needs_contact_count:0,candidates:[]};
      else if(name==='deal-room-board') body=await fixture.getBoard();
      else if(name==='today-triage') body=await fixture.todayTriage();
      else if(name==='get-deal-room') body=await fixture.getDeal(args.deal || args.deal_id);
      else if(name==='deal-room-changes') body=await fixture.getChanges(args.cursor);
      else { if(!/^(read-|list-|get-|notification-|correspondence-)/.test(name)) writes.push(name); body={ok:true}; }
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(body)}]}})});
    }
    if(url.pathname.startsWith('/api/')||url.pathname==='/app-release') return route.fulfill({contentType:'application/json',body:'{}'});
    const file=url.pathname==='/deals'&&url.searchParams.get('view')==='board'?'pipeline.html':url.pathname==='/'&&url.searchParams.get('view')==='charts'?'charts.html':contract.routes[url.pathname]||url.pathname.slice(1);
    try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  const goto=async path=>{await page.goto('http://localhost'+path);await page.waitForFunction(()=>document.querySelector('#appSyncTime')?.textContent!=='—');};
  return{page,goto,errors,writes};
}
const fits=async(page,label)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label);

test('five regions, rail destinations, original tab controls and per-page sidebar memory',async t=>{
 const{page,goto,errors}=await open(t);
 await goto('/leads');assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'closed');
 assert.deepEqual(await page.locator('.app-shell-navigation > a').evaluateAll(nodes=>nodes.map(n=>n.title)),['Home','Leads','Tours','Local Deals','Vendors','Control Room']);
 assert.equal(await page.locator('#appTabsSlot #boardView').count(),1);assert.equal(await page.locator('#appSidebarSlot #leadSearch').count(),1);
 await page.locator('#listView').click();assert.equal(await page.locator('.lead-list').count(),1);
 await page.locator('#appSidebarToggle').click();await page.locator('#leadSearch').fill('Practice 2');assert.equal(await page.locator('.lead-card').count(),1);
 await goto('/deals?view=board');assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'closed');
 await goto('/leads');assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'open');
 await goto('/');assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'open');
 await page.locator('#appSidebarToggle').click();await page.reload();assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'closed');
 await goto('/leads');assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'),'open');
 await page.locator('#boardView').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#listView').evaluate(n=>n===document.activeElement),true);
 assert.deepEqual(errors,[]);
});

test('phone rail is a bottom bar; drawers close by Escape and scrim with focus restored',async t=>{
 const{page,goto,errors}=await open(t,{width:390,motion:'reduce'});await goto('/leads');
 const rail=await page.locator('.app-shell-header').boundingBox();assert.ok(rail.y>=850);
 assert.equal(await page.locator('#appSidebarToggle').getAttribute('aria-expanded'),'false');
 await page.locator('#appSidebarToggle').click();assert.equal(await page.locator('#appLayout').getAttribute('data-drawer'),'sidebar');
 await page.keyboard.press('Shift+Tab');assert.ok(await page.locator('#appSidebar').evaluate(n=>n.contains(document.activeElement)));
 await page.keyboard.press('Escape');assert.equal(await page.locator('#appSidebarToggle').evaluate(n=>n===document.activeElement),true);
 await page.locator('#appTodayToggle').click();assert.equal(await page.locator('#appTodayToggle').getAttribute('aria-expanded'),'true');
 await page.locator('#appDrawerScrim').click({position:{x:5,y:5}});assert.equal(await page.locator('#appLayout').getAttribute('data-drawer'),'');
 await page.getByLabel('More',{exact:true}).click();assert.equal(await page.getByLabel('Progress',{exact:true}).isVisible(),true);await page.keyboard.press('Escape');
 assert.equal(await page.getByLabel('More',{exact:true}).getAttribute('aria-expanded'),'false');
 await fits(page,'phone drawers and menus');
 const reduced=await page.locator('#appToday,.app-layout-item,.app-shell-flow').evaluateAll(nodes=>nodes.map(n=>({transition:getComputedStyle(n).transitionDuration,animation:getComputedStyle(n).animationName})));
 assert.ok(reduced.every(s=>s.transition==='0s'&&s.animation==='none'));assert.deepEqual(errors,[]);
});

test('recent moves catch up through history and update read-only on pages without their own receipts',async t=>{
 const events=[{id:'demo-event-1',subject_type:'deal',subject_id:'d23',field:'attention',actor:'doc',old_value:false,new_value:true,recorded_at:'2026-10-01T14:00:00Z'}];
 const{page,goto,writes,errors}=await open(t,{clock:true,events});await goto('/leads?mode=live');
 await page.waitForFunction(()=>document.querySelector('#appTodayMoves')?.textContent.includes('Demo Specialty Clinic'));
 assert.match(await page.locator('#appTodayMoves').textContent(),/Doc.*Flagged/);assert.equal(await page.locator('#appTodayMoves [data-undo]').count(),0);
 events.push({id:'demo-event-2',subject_type:'deal',subject_id:'d23',field:'next_step',actor:'doc',new_value:'Review synthetic terms',recorded_at:'2026-10-01T15:00:00Z'});
 await page.clock.fastForward(31_000);await page.waitForFunction(()=>document.querySelector('#appTodayMoves')?.textContent.includes('Review synthetic terms'));
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
});

test('Local Deals opens a wide popup, refreshes its original note, and retains one-tap Undo in Today',async t=>{
 const{page,goto,errors}=await open(t,{clock:true});await goto('/deals?view=board');
 await page.locator('.kanban-card[data-id="d05"] [data-open]').click();await page.waitForFunction(()=>document.querySelector('#panelBody details'));
 assert.ok((await page.locator('#recordPanel').boundingBox()).width>=900);await page.locator('#panelBody summary').click();
 await page.evaluate(async()=>{const{state}=await import('/js/pipeline.js');await state.client.addDealNote({deal:'d05',text:'A synthetic update. Original detail continues here.',idempotency_key:'demo-w1b-note'});});
 await page.clock.fastForward(16_000);await page.waitForFunction(()=>document.querySelector('#panelBody')?.textContent.includes('A synthetic update.'));
 assert.equal(await page.locator('#panelBody details').evaluate(n=>n.open),true);assert.equal(await page.locator('#recordPanel').evaluate(n=>n.open),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#recordPanel').evaluate(n=>n.open),false);
 const original=await page.evaluate(async()=>{const{state}=await import('/js/pipeline.js');const d=state.deals.get('d23');const value=d.attention;await state.client.patchDealField({deal:d.id,field:'attention',value:!value,base_event_id:d.field_base?.attention?.id||null,idempotency_key:'demo-w1b-attention'});return value;});
 await page.clock.fastForward(3_000);await page.waitForSelector('#appTodayMoves [data-undo]');await page.locator('#appTodayMoves [data-undo]').first().click();
 await page.waitForFunction(async original=>(await import('/js/pipeline.js')).state.deals.get('d23').attention===original,original);
 assert.deepEqual(errors,[]);
});

test('blocked localStorage, automatic Today refresh, and wide item details stay usable',async t=>{
 const{page,goto,errors}=await open(t,{deniedStorage:true,clock:true});await goto('/deals');
 await page.locator('#appSidebarToggle').click();
 const first=page.locator('#appTodayNeeds [data-layout-deal]').first();await first.click();
 await page.waitForFunction(()=>document.querySelector('#dealDialog')?.open);assert.ok((await page.locator('#dealDialog').boundingBox()).width>=900);
 const before=await page.locator('#appSyncTime').getAttribute('datetime');await page.clock.fastForward(31_000);await page.waitForFunction(before=>document.querySelector('#appSyncTime').getAttribute('datetime')!==before,before);
 assert.equal(await page.locator('#dealDialog').evaluate(n=>n.open),true);await page.getByLabel('Close details',{exact:true}).click();
 await goto('/leads');await page.locator('.lead-card').first().click();assert.equal(await page.locator('#leadDetailDialog').evaluate(n=>n.open),true);assert.ok((await page.locator('#leadDetailDialog').boundingBox()).width>=900);
 await page.locator('#leadDetailBody summary').click();assert.equal(await page.locator('#leadDetailBody details').evaluate(n=>n.open),true);await page.locator('#leadDetailBody summary').focus();await page.clock.fastForward(31_000);assert.equal(await page.locator('#leadDetailBody summary').evaluate(n=>n===document.activeElement),true);assert.equal(await page.locator('#leadDetailBody details').evaluate(n=>n.open),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#leadDetailDialog').evaluate(n=>n.open),false);assert.deepEqual(errors,[]);
});

test('Home, Leads and Local Deals fit desktop and phone; capture the six review renders',async t=>{
 await mkdir(new URL('test-artifacts/w1b/',root),{recursive:true});
 const{page,goto,errors}=await open(t);
 for(const width of[1440,390]){await page.setViewportSize({width,height:960});for(const[name,path]of[['home','/'],['leads','/leads'],['local-deals','/deals?view=board']]){
  await goto(path);if(name==='leads')await page.waitForSelector('.lead-card');if(name==='local-deals')await page.waitForSelector('.kanban-card');
  await fits(page,`${name} ${width}`);await page.screenshot({path:new URL(`test-artifacts/w1b/${name}-${width}.png`,root).pathname});
 }}assert.deepEqual(errors,[]);
});
