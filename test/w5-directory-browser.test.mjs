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
  let fail=false,writes=0,writeMode='saved';
  await page.route('**/api/v1/business/**',r=>{calls.push(r.request().url());return fail?r.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}):r.fulfill({json:directoryFixture(r.request().url(),{overrides})});});
  await page.route('**/api/system-work/session',r=>r.fulfill({json:{actor:{slug:'joe'}}}));
  await page.route('**/mcp',r=>{
    const {name,arguments:args}=r.request().postDataJSON().params;let payload={ok:true};
    if(name==='update-vendor'){
      writes++;payload={ok:true,updated:['trust_override']};if(writeMode==='rejected')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:'AUTHORIZATION_REFUSED'})}]}}});if(writeMode==='unknownAck')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true,updated:[]})}]}}});if(writeMode==='unknownTool')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:'DEPENDENCY_UNAVAILABLE'})}]}}});if(writeMode==='unknown200')return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'{}'}]}}});if(writeMode==='uncertain')return r.fulfill({status:502,body:'Synthetic lost response'});const n=Number(args.vendor.split('-').at(-1));const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
      overrides.set(id,args.fields.trust_override?{...args.fields.trust_override,recorded_by:'joe',recorded_at:'2026-10-01T18:00:00Z'}:null);
    if(writeMode==='lost')return r.fulfill({status:502,body:'Synthetic lost response'});
    }else if(name==='find-and-catch-up')payload={state:'not_found',candidates:[]};
    else if(name==='correspondence-readiness')payload={};
    return r.fulfill({json:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
  });
  return {page,errors,calls,get writes(){return writes;},setFail:value=>{fail=value;},setWriteMode:value=>{writeMode=value;}};
}
for(const width of [1440,390])test(`W5 rendered directories and wide dialog at ${width}px`,async t=>{
  const h=await open(t,width),{page}=h;await page.goto(origin+'/vendors?mode=live');await page.waitForSelector('.record-row').catch(async e=>{assert.fail(JSON.stringify({errors:h.errors,body:await page.locator('main').innerText()}));});
  assert.equal(await page.locator('#pager').count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Checked a while ago|About this list|source|No filters|read again/i);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`test-artifacts/w5/vendors-${width}.png`});
  await page.locator('.record-row').first().click();await page.waitForSelector('#trustForm',{state:'attached'});
  assert.equal(await page.locator('#recordPanel').getAttribute('role'),'dialog');assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),true);
  const box=await page.locator('#recordPanel').boundingBox();assert.ok(box.width>width*.7);await page.screenshot({path:`test-artifacts/w5/vendor-overview-${width}.png`});
  const head=await page.locator('#recordTitle').boundingBox();assert.ok(head.y>=box.y && head.y+head.height<box.y+box.height);
  assert.match(await page.locator('#recordBody').innerText(),/Loan programs|Introductions made|Suggested introductions/);
  await page.locator('[data-details-key="entry-demo-entry"] summary').click();assert.match(await page.locator('[data-details-key="entry-demo-entry"]').innerText(),/Original synthetic email/);
  await page.screenshot({path:`test-artifacts/w5/vendor-detail-${width}.png`});
  await page.locator('[data-details-key="trust"] summary').click();await page.locator('[name="reason"]').fill('Synthetic reviewed exception');await page.locator('[name="tier"]').selectOption('Trial');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(80);assert.equal(await page.locator('[name="reason"]').inputValue(),'Synthetic reviewed exception');
  await page.locator('#trustForm button').click();await page.waitForFunction(()=>document.querySelector('.relationship-section').textContent.includes('Computed:'));
  assert.equal(h.writes,1);assert.match(await page.locator('.relationship-section').innerText(),/Trial.*Computed: Proven/s);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#recordPanel').isVisible(),false);assert.equal(await page.locator('#appShell').evaluate(el=>el.inert),false);
  await page.goto(origin+'/clients');await page.waitForSelector('.record-row');await page.screenshot({path:`test-artifacts/w5/clients-${width}.png`});assert.deepEqual(h.errors,[]);
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
  assert.equal(await page.locator('.business-hero').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');await page.screenshot({path:'test-artifacts/w5/reduced-motion.png'});
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
