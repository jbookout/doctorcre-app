import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const tourId='11111111-1111-4111-8111-111111111111';
const routeId='22222222-2222-4222-8222-222222222222';
const tour={id:tourId,name:'Synthetic recovery tour',route_version_id:routeId,route_version_state:'draft',accepted_route_version:0,stops:[],routes:[{id:routeId,route_version:1,accepted:false,stops:[]}]};

for(const failure of [401,403,503,'network','malformed','timeout']) test(`F04 Tour detail ${failure} settles loading and offers visible recovery`,async t=>{
  const server=await fixtureServer();t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failing=false;
  await page.route('**/api/tours/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/tours/detail' && failing){
      if(failure==='network') return route.abort();
      if(failure==='timeout') return;
      if(failure==='malformed') return route.fulfill({json:{data:{},csrf_token:'synthetic'}});
      return route.fulfill({status:failure,json:{error:'synthetic_refusal'}});
    }
    const data=path==='/api/tours/library'?{tours:[tour]}:path==='/api/tours/detail'?tour:{};
    return route.fulfill({json:{data,csrf_token:'synthetic'}});
  });
  await page.goto(`${server.origin}/tours/route-editor.html`);
  await page.locator('#empty-tours button').click();
  await page.locator('#tour-panel').waitFor({state:'visible'});
  failing=true;
  if(failure==='timeout') await page.clock.install();
  await page.locator('#appSidebarToggle').click();
  await page.locator('#tour-list button').click();
  if(failure==='timeout') await page.clock.fastForward(16000);
  await page.waitForFunction(()=>/unavailable|Sign in/i.test(document.querySelector('#status').textContent),{},{timeout:2500});
  assert.equal(await page.locator('#tour-panel').isVisible(),false);
  const recovery=page.locator(failure===401||failure===403?'[data-tour-signin]':'[data-tour-retry]');
  assert.equal(await recovery.isVisible(),true);
  assert.deepEqual(errors,[]);
});

async function national(t){
  const server=await fixtureServer();t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  const source=await read('js/app.js');
  await page.route('**/js/app.js',route=>route.fulfill({contentType:'text/javascript',body:source+'\nglobalThis.s4App={state,startAgenda,advanceAgenda,finishAgenda,renderConfirms,loadConfirms};'}));
  await page.route('**/api/**',route=>route.fulfill({json:{}}));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.waitForFunction(()=>window.s4App?.state.deals.size>0);
  await page.evaluate(()=>{const a=window.s4App;a.state.workspace='team';a.state.accountId=null;a.state.deals=new Map([['demo-deal',{id:'demo-deal',name:'Synthetic agenda deal',workspace_kind:'team',phase:'active'}]]);});
  return page;
}
for(const operation of ['startReview','reviewDeal','endReview','resolveConfirm']) test(`F04 ${operation} rejection is visible and outcome check reuses the request`,async t=>{
  const page=await national(t);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(async operation=>{
    const a=window.s4App;
    if(operation==='reviewDeal'||operation==='endReview') await a.startAgenda();
    a.state.client[operation]=async args=>{window.s4Requests??=[];window.s4Requests.push(args);throw new Error('synthetic network failure');};
    if(operation==='resolveConfirm'){a.state.confirms=[{id:'demo-proposal',label:'Demo suggestion'}];a.renderConfirms();}
  },operation);
  if(operation==='reviewDeal'||operation==='endReview') assert.equal(await page.locator('#agendaPanel').isVisible(),true,await page.locator('#screenActionStatus').textContent());
  if(operation==='startReview') await page.evaluate(()=>{void window.s4App.startAgenda();});
  if(operation==='reviewDeal') await page.locator('#agendaReviewed').click();
  if(operation==='endReview') await page.locator('#agendaEnd').click();
  if(operation==='resolveConfirm') await page.locator('[data-confirm=yes]').dispatchEvent('click');
  await page.locator('[data-screen-outcome]').waitFor({state:'visible',timeout:2500});
  assert.match(await page.locator('[data-screen-outcome]').textContent(),/not be confirmed|unknown/i);
  await page.locator('[data-screen-retry]').click();
  assert.deepEqual(await page.evaluate(()=>window.s4Requests[0]),await page.evaluate(()=>window.s4Requests[1]));
  assert.deepEqual(errors,[]);
});

test('F06 Search catch-up failure preserves good find results visibly; denied catch-up clears them',async t=>{
  const server=await fixtureServer();t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  const source=await read('js/fixture-client.js');
  await page.route('**/js/fixture-client.js',route=>route.fulfill({contentType:'text/javascript',body:source.replace('export async function createFixtureClient','async function originalCreateClient')+`
export async function createFixtureClient(...args){const client=await originalCreateClient(...args);client.findAndCatchUp=async()=>{throw Object.assign(new Error('synthetic'),{status:window.s4Denied?401:503});};return client;}`}));
  await page.route('**/api/**',route=>route.fulfill({json:{}}));
  await page.goto(`${server.origin}/search?mode=fixture&q=Demo`);
  await page.waitForFunction(()=>document.querySelector('#searchResults').getAttribute('aria-busy')==='false');
  assert.match(await page.locator('#searchState').textContent(),/context unavailable/i);
  assert.ok(await page.locator('.search-row').count()>0);
  await page.evaluate(()=>{window.s4Denied=true;});
  await page.locator('#searchRetry').click();
  await page.waitForFunction(()=>document.querySelector('#searchState').textContent.includes('Sign-in required'));
  assert.equal(await page.locator('.search-row').count(),0);
});

for(const failure of [401,403,503,'malformed','refusal','timeout']) test(`F04 agenda ${failure} has a settled recovery state without unhandled rejection`,async t=>{
  const page=await national(t), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  if(failure==='timeout') await page.clock.install();
  await page.evaluate(failure=>{
    window.s4App.state.client.startReview=async()=>{
      if(failure==='timeout') return new Promise(()=>{});
      if(failure==='malformed') return {};
      if(failure==='refusal') return {ok:false,error:'invalid_request'};
      throw Object.assign(new Error('synthetic failure'),{status:failure});
    };
    void window.s4App.startAgenda();
  },failure);
  if(failure==='timeout') await page.clock.fastForward(31000);
  await page.waitForFunction(()=>document.querySelector('[data-screen-outcome]')?.textContent.match(/unknown|refused|not saved|not be confirmed/));
  assert.doesNotMatch(await page.locator('[data-screen-outcome]').textContent(),/Saving…/);
  if(failure===401||failure===403){
    assert.equal(await page.locator('[data-screen-outcome] a[href="/auth/login"]').count(),1);
    assert.equal(await page.evaluate(()=>window.s4App.state.deals.size),0);
  }
  assert.deepEqual(errors,[]);
});

test('F06 capture queue failure has visible retry; a late success cannot restore denied suggestions',async t=>{
  const page=await national(t);
  await page.evaluate(async()=>{
    window.s4App.state.client.getPendingConfirms=async()=>{throw Object.assign(new Error('synthetic failure'),{status:503});};
    await window.s4App.loadConfirms();
  });
  assert.match(await page.locator('#confirmDock').textContent(),/Suggestions unavailable/);
  await page.evaluate(()=>{
    window.s4App.state.client.getPendingConfirms=()=>new Promise(resolve=>{window.s4LateConfirms=resolve;});
    void window.s4App.loadConfirms();
    window.s4App.state.client.startReview=async()=>{throw Object.assign(new Error('denied'),{status:401});};
    void window.s4App.startAgenda();
  });
  await page.locator('[data-screen-outcome] a').waitFor();
  await page.evaluate(()=>window.s4LateConfirms({proposals:[{id:'late-private',label:'Previous private suggestion'}]}));
  await page.waitForTimeout(30);
  assert.doesNotMatch(await page.locator('#confirmDock').textContent(),/Previous private suggestion/);
});
