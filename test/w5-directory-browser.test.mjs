import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
let server, origin;
before(async()=>{
  const port=21000+Math.floor(Math.random()*20000); origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['scripts/serve.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((res,rej)=>{server.stdout.once('data',res);server.once('error',rej);server.once('exit',code=>{if(code)rej(Error('server '+code));});});
  await mkdir(new URL('../test-artifacts/w5',import.meta.url),{recursive:true});
});
after(()=>server?.kill());
async function open(t,width=1440){
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000}}), errors=[], overrides=new Map(), calls=[];
  page.setDefaultTimeout(5000); page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-01T18:00:00Z')});await page.route('https://**',r=>r.abort());
  let fail=false,expired=false,writes=0,writeMode='saved';
  await page.route('**/api/v1/business/**',r=>{calls.push(r.request().url());return expired?r.fulfill({status:401,json:{error:'AUTHENTICATION_REQUIRED'}}):fail?r.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}):r.fulfill({json:directoryFixture(r.request().url(),{overrides})});});
  await page.route('**/api/system-work/session',r=>r.fulfill({json:{actor:{slug:'joe'}}}));
  await page.route('**/mcp',r=>{
    const {name,arguments:args}=r.request().postDataJSON().params;let payload={ok:true};
    if(name==='update-vendor'){
      assert.match(args.vendor,/^V-DEMO-\d+$/);assert.equal(args.base_version,1);assert.deepEqual(Object.keys(args.fields),['trust_override']);assert.match(args.idempotency_key,/^[a-f0-9-]{36}$/);if(args.fields.trust_override){assert.ok(['Trial','Established','Proven'].includes(args.fields.trust_override.tier));assert.ok(args.fields.trust_override.reason);}writes++;payload={ok:true,updated:['trust_override']};if(writeMode==='rejected')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:'AUTHORIZATION_REFUSED'})}]}}});if(writeMode==='unknownAck')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true,updated:[]})}]}}});if(writeMode==='unknownTool')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:'DEPENDENCY_UNAVAILABLE'})}]}}});if(writeMode==='unknown200')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'{}'}]}}});if(writeMode==='uncertain')return r.fulfill({status:502,body:'Synthetic lost response'});const n=Number(args.vendor.split('-').at(-1));const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
      overrides.set(id,args.fields.trust_override?{...args.fields.trust_override,recorded_by:'joe',recorded_at:'2026-10-01T18:00:00Z'}:null);
    if(writeMode==='lost')return r.fulfill({status:502,body:'Synthetic lost response'});
    }else if(name==='find-and-catch-up')payload={state:'not_found',candidates:[]};
    else if(name==='correspondence-readiness')payload={};
    return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
  });
  return {page,errors,calls,get writes(){return writes;},setFail:value=>{fail=value;},setExpired:value=>{expired=value;},setWriteMode:value=>{writeMode=value;}};
}
for(const width of [1440,390])test(`W5 rendered directories and wide dialog at ${width}px`,async t=>{
  const h=await open(t,width),{page}=h;await page.goto(origin+'/vendors?mode=live');await page.waitForSelector('.record-row').catch(async e=>{assert.fail(JSON.stringify({errors:h.errors,body:await page.locator('main').innerText()}));});
  assert.equal(await page.locator('#pager').count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Checked a while ago|About this list|source|No filters|read again/i);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({animations:'disabled',path:`test-artifacts/w5/vendors-${width}.png`});
  await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});
  assert.equal(await page.locator('#recordPanel').getAttribute('role'),'dialog');assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),true);
  const box=await page.locator('#recordPanel').boundingBox();assert.ok(box.width>width*.7);await page.screenshot({animations:'disabled',path:`test-artifacts/w5/vendor-overview-${width}.png`});
  const head=await page.locator('#recordTitle').boundingBox();assert.ok(head.y>=box.y && head.y+head.height<box.y+box.height);
  assert.match(await page.locator('#recordBody').innerText(),/Loan programs|Introductions made|Suggested introductions/);
  assert.equal(await page.locator('[data-details-key="intro-demo-intro"] .entry-detail').isVisible(),false);
  await page.locator('[data-details-key="intro-demo-intro"] summary').click();assert.match(await page.locator('[data-details-key="intro-demo-intro"]').innerText(),/Original synthetic introduction entry/);
  await page.locator('[data-details-key="entry-demo-entry"] summary').click();assert.match(await page.locator('[data-details-key="entry-demo-entry"]').innerText(),/Original synthetic email/);
  await page.screenshot({animations:'disabled',path:`test-artifacts/w5/vendor-detail-${width}.png`});
  await page.locator('[data-details-key="trust"] summary').click();await page.locator('[name="reason"]').fill('Synthetic reviewed exception');await page.locator('[name="tier"]').selectOption('Trial');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(80);assert.equal(await page.locator('[name="reason"]').inputValue(),'Synthetic reviewed exception');
  await page.locator('#trustForm button').click();await page.waitForFunction(()=>document.querySelector('.relationship-section').textContent.includes('Computed:'));
  assert.equal(h.writes,1);assert.match(await page.locator('.relationship-section').innerText(),/Trial.*Computed: Proven/s);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#recordPanel').isVisible(),false);assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),false);
  await page.goto(origin+'/clients');await page.waitForSelector('.record-row');await page.screenshot({animations:'disabled',path:`test-artifacts/w5/clients-${width}.png`});assert.deepEqual(h.errors,[]);
});
test('W5 filters, traversal and autonomous refresh recover without losing search',async t=>{
  const h=await open(t),{page}=h;await page.goto(origin+'/vendors?mode=live');await page.waitForSelector('.record-row');
  await page.locator('[data-owner="dell"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));assert.match(h.calls.at(-1),/owner=dell/);
  await page.locator('#territoryInput').fill('Demo North');await page.locator('#territoryInput').dispatchEvent('change');await page.waitForFunction(()=>location.search.includes('territory=Demo'));
  await page.locator('#sortSelect').selectOption('territory');await page.waitForFunction(()=>location.search.includes('sort=territory'));
  await page.locator('#resetFilters').click();await page.waitForFunction(()=>document.querySelectorAll('.record-row').length===25);
  await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>25);const search=await page.locator('.search-dock').boundingBox();assert.ok(search.y>=69&&search.y<102);assert.ok(search.height<110);assert.doesNotMatch(page.url(),/page=/);
  await page.locator('#searchInput').fill('Demo');await page.clock.fastForward(400);await page.waitForFunction(()=>location.search.includes('q=Demo'));
  await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>25);
  const count=await page.locator('.record-row').count();await page.clock.fastForward(31000);await page.waitForTimeout(80);assert.ok(await page.locator('.record-row').count()>=count);assert.equal(await page.locator('#searchInput').inputValue(),'Demo');
  h.setFail(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('.record-empty');h.setFail(false);await page.clock.fastForward(31000);await page.waitForSelector('.record-row');assert.deepEqual(h.errors,[]);
});
test('W5 reduced motion stops hover travel and pulse while keeping content visible',async t=>{
  const {page}=await open(t);await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/vendors');await page.waitForSelector('.record-row');await page.locator('.record-row').first().hover();
  const style=await page.locator('.record-row').first().evaluate(el=>({animation:getComputedStyle(el).animationName,transform:getComputedStyle(el).transform,opacity:getComputedStyle(el).opacity}));assert.deepEqual(style,{animation:'none',transform:'none',opacity:'1'});
  assert.equal(await page.locator('.business-hero').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');await page.screenshot({animations:'disabled',path:'test-artifacts/w5/reduced-motion.png'});
});

for(const mode of ['lost','rejected','uncertain','unknown200','unknownAck','unknownTool'])test(`W5 ${mode} override response is reconciled without replay`,async t=>{
  const h=await open(t);h.setWriteMode(mode);const {page}=h;await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});await page.locator('[data-details-key="trust"] summary').click();await page.locator('[name="tier"]').selectOption('Trial');await page.locator('[name="reason"]').fill('Demo exception');await page.locator('#trustForm button').click();
  await page.waitForFunction(()=>['Rating confirmed','Rating not confirmed'].includes(document.querySelector('#trustStatus')?.textContent));assert.equal(h.writes,1);
  if(mode==='lost'){assert.match(await page.locator('.relationship-section').innerText(),/Computed: Proven/);assert.equal(await page.locator('#trustStatus').textContent(),'Rating confirmed');assert.equal(await page.locator('#trustForm button').isDisabled(),false);}
  else assert.equal(await page.locator('#trustForm button').isDisabled(),['uncertain','unknown200','unknownAck','unknownTool'].includes(mode));
  await page.clock.fastForward(31000);await page.waitForTimeout(80);assert.equal(h.writes,1,'polling never repeats a write');assert.deepEqual(h.errors,[]);
});

test('W5 Clients exposes every requested sort and owner without territory controls',async t=>{
 const {page,calls}=await open(t);await page.goto(origin+'/clients');await page.waitForSelector('.record-row');assert.equal(await page.locator('#territoryField').isVisible(),false);
 for(const sort of ['vertical','name','deal_type','last_deal_desc','last_deal_asc']){await page.locator('#sortSelect').selectOption(sort);await page.waitForFunction(s=>document.querySelector('#sortSelect').value===s,sort);await page.waitForTimeout(40);assert.ok(calls.some(url=>new URL(url).searchParams.get('sort')===sort)||sort==='name');}
 await page.locator('[data-owner="joe"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));
});

test('W5 session expiry erases a pending trust draft and recovery permits a fresh action without replay',async t=>{
 const h=await open(t),{page}=h;h.setWriteMode('uncertain');await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await page.locator('[data-details-key="trust"] summary').click();await page.locator('[name="tier"]').selectOption('Trial');await page.locator('[name="reason"]').fill('Demo pending draft');await page.locator('#trustForm button').click();await page.waitForFunction(()=>document.querySelector('#trustStatus')?.textContent==='Rating not confirmed');
 h.setExpired(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#recordTitle')?.textContent==='Your session has ended');assert.doesNotMatch(await page.locator('#recordBody').innerText(),/Demo pending draft/);
 h.setExpired(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('#trustForm',{state:'attached'});await page.locator('[data-details-key="trust"] summary').click();assert.equal(await page.locator('[name="reason"]').inputValue(),'');assert.equal(await page.locator('#trustForm button').isDisabled(),false);assert.equal(h.writes,1);assert.deepEqual(h.errors,[]);
});

async function beginRating(page, reason='Synthetic pending rating') {
 await page.locator('[data-details-key="trust"] summary').click();
 await page.locator('[name="tier"]').selectOption('Trial');
 await page.locator('[name="reason"]').fill(reason);
}
const ack = r => r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true,updated:['trust_override']})}]}}});
async function holdWrites(page) {
 const held=[];
 await page.route('**/mcp', r => r.request().postDataJSON().params.name==='update-vendor' ? held.push(r) : r.fallback());
 return held;
}
test('W5 late successful save cannot repaint another selected vendor',async t=>{
 const {page}=await open(t);const held=await holdWrites(page);
 await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await beginRating(page);await page.locator('#trustForm button').click();await page.waitForFunction(()=>document.querySelector('#trustStatus').textContent==='Saving…');
 await page.locator('#recordClose').click();await page.locator('.record-row').nth(1).click();await page.waitForFunction(()=>document.querySelector('#recordTitle').textContent==='Demo Partner 02');
 await ack(held[0]);await page.waitForTimeout(150);
 assert.equal(await page.locator('#recordTitle').textContent(),'Demo Partner 02');assert.equal(await page.locator('#trustForm').count(),1);assert.equal(await page.locator('#trustForm button').isDisabled(),false);
});
for (const status of [200,502]) test(`W5 pre-expiry save response ${status} cannot release a recovered session save`,async t=>{
 const h=await open(t),{page}=h;const held=await holdWrites(page);
 await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await beginRating(page);await page.locator('#trustForm button').click();await page.waitForTimeout(50);
 // Expiry refresh reads the list and then the selected record. The title can
 // change after the first read; finish both before simulating restored auth.
 const expiredRecord=page.waitForResponse(response=>response.status()===401
  && /\/api\/v1\/business\/vendors\/[^/]+$/.test(new URL(response.url()).pathname));
 h.setExpired(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await (await expiredRecord).finished();await page.clock.runFor(1);
 await page.waitForFunction(()=>document.querySelector('#recordTitle').textContent==='Your session has ended');
 h.setExpired(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('#trustForm',{state:'attached'});await beginRating(page,'Synthetic second save');await page.locator('#trustForm button').click();await page.waitForTimeout(50);assert.equal(held.length,2);
 if (status===200) await ack(held[0]); else await held[0].fulfill({status,body:'Synthetic lost response'});
 await page.waitForTimeout(150);assert.equal(await page.locator('#trustForm button').isDisabled(),true);assert.equal(await page.locator('#trustStatus').textContent(),'Saving…');await ack(held[1]);
});
test('W5 a read dispatched before a new save cannot reconcile that save',async t=>{
 const {page}=await open(t);const writes=await holdWrites(page), reads=[];
 const reason='Synthetic repeated rating';
 await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await beginRating(page,reason);
 await page.route('**/api/v1/business/vendors/*',r=>reads.push(r));
 await page.locator('#trustForm button').click();await page.waitForTimeout(50);await ack(writes[0]);
 await page.waitForFunction(()=>!document.querySelector('#trustForm button').disabled);await page.waitForTimeout(50);assert.equal(reads.length,1);
 await page.locator('#trustForm button').click();await page.waitForTimeout(50);assert.equal(writes.length,2);
 const id='00000000-0000-4000-8000-000000000001';
 const payload=directoryFixture(reads[0].request().url(),{overrides:new Map([[id,{tier:'Trial',reason,recorded_by:'joe',recorded_at:'2026-10-01T18:00:00Z'}]])});
 await reads[0].fulfill({json:payload});await page.waitForTimeout(150);
 assert.equal(await page.locator('#trustForm button').isDisabled(),true);assert.equal(await page.locator('#trustStatus').textContent(),'Saving…');
 await page.unroute('**/api/v1/business/vendors/*');await ack(writes[1]);
});
test('W5 keyboard reaches disclosures and skips closed controls',async t=>{
 const {page}=await open(t);await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});
 await page.locator('[data-details-key="trust"] summary').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SUMMARY');
 await page.locator('[data-details-key="trust"] summary').focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.name),'tier');
 await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SUMMARY');
 await page.locator('[data-details-key="entry-demo-entry"] summary').focus();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>document.activeElement.closest('details')?.dataset.detailsKey),'entry-demo-entry');
});
test('W5 Back restores cached query rows while its read is pending',async t=>{
 const {page}=await open(t);await page.goto(origin+'/vendors?mode=live');await page.waitForSelector('.record-row');await page.locator('[data-owner="joe"]').click();await page.waitForFunction(()=>document.querySelector('#resultSummary').textContent.startsWith('31 '));
 await page.locator('[data-owner="dell"]').click();await page.waitForFunction(()=>document.querySelector('.row-owner')?.textContent.includes('Dell'));
 const held=[];await page.route('**/api/v1/business/vendors?**',r=>new URL(r.request().url()).searchParams.get('owner')==='joe'?held.push(r):r.fallback());
 await page.goBack();await page.waitForTimeout(100);assert.equal(await page.locator('[data-owner="joe"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.row-owner').evaluateAll(rows=>rows.every(row=>row.textContent.includes('Joe'))),true);
 for(const r of held)await r.fulfill({json:directoryFixture(r.request().url())});
});
test('W5 ordinary record read failure preserves the unsaved rating draft',async t=>{
 const h=await open(t),{page}=h;await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await beginRating(page,'Synthetic draft survives');
 h.setFail(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#recordTitle').textContent==='This did not load');
 h.setFail(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForSelector('#trustForm',{state:'attached'});
 assert.equal(await page.locator('[name="reason"]').inputValue(),'Synthetic draft survives');assert.equal(await page.locator('[name="tier"]').inputValue(),'Trial');
});
test('W5 failed continuous page is visible and polling retries without scroll',async t=>{
 const {page}=await open(t);let fail=true;
 await page.route('**/api/v1/business/vendors?**',r=>new URL(r.request().url()).searchParams.get('page')==='2'&&fail?r.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}):r.fallback());
 await page.goto(origin+'/vendors?mode=live');await page.waitForSelector('.record-row');await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(150);
 assert.match(await page.locator('#noticeRegion').innerText(),/Could not load more/);assert.equal(await page.locator('.record-row').count(),25);
 fail=false;await page.clock.fastForward(31000);await page.waitForFunction(()=>document.querySelectorAll('.record-row').length>=50);
});
test('W5 missing original details never displays summary as original',async t=>{
 const {page}=await open(t);await page.route('**/api/v1/business/vendors/*',r=>{const p=directoryFixture(r.request().url());p.record.relationship.recent_entries[0].detail=null;return r.fulfill({json:p});});
 await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});assert.equal(await page.locator('[data-details-key="entry-demo-entry"]').count(),0);
});
test('W5 vendor business facts remain visible in the modal',async t=>{
 const {page}=await open(t);await page.route('**/api/v1/business/vendors/*',r=>{const p=directoryFixture(r.request().url());p.record.verticals=['Synthetic specialist vertical'];return r.fulfill({json:p});});
 await page.goto(origin+'/vendors?mode=live');await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});const body=await page.locator('#recordBody').innerText();for(const value of ['Synthetic specialist vertical','Banking','Warm','Active'])assert.ok(body.includes(value),value);
});
test('W5 fixture adapter withholds unsupported rating action',async t=>{
 const h=await open(t),{page}=h;await page.goto(origin+'/vendors');await page.locator('.record-row').first().click();await page.waitForFunction(()=>document.querySelector('#recordTitle').textContent==='Demo Partner 01');assert.equal(await page.locator('#trustForm').count(),0);assert.equal(h.writes,0);
});
