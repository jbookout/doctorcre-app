import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';
const root=new URL('../',import.meta.url);
const routes=JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
async function open(t,{width=1440,reducedMotion='no-preference',undoFailure=false,limit=50}={}) {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:960},reducedMotion}); page.setDefaultTimeout(5000);
  const fixture=createDocActivityFixture(()=>new Date('2026-10-01T15:00:00Z')), calls=[],errors=[];
  let fail=undoFailure, reads=0, failRead=false, staleRead=null, heldRead=null, refusal=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()); if(url.origin!=='http://localhost')return route.abort();
    if(url.pathname==='/mcp'){
      const {params}=route.request().postDataJSON(); calls.push(params);
      let result;
      if(params.name==='read-doc-activity'){
        reads++; if(failRead)return route.fulfill({status:503,body:''});
        result=await fixture.read({...params.arguments,limit});
        if(refusal)result.entries[0].undo={state:"superseded"};
        if(staleRead===params.arguments.partner){staleRead=null;await new Promise(resolve=>{heldRead=resolve;});}
      }else if(params.name==='revert-deal-field'){
        if(refusal)return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:'newer_change_exists'})}]}})});
        result=await fixture.undo(params.arguments);
        if(fail){fail=false;return route.fulfill({status:504,body:''});}
      }else result={};
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(result)}]}})});
    }
    if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'}})});
    const file=routes.routes[url.pathname]||url.pathname.slice(1);
    try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
  await page.goto('http://localhost/doc-activity?mode=live'); await page.locator('.activity-row').first().waitFor();
  return {page,calls,errors,fixture,reads:()=>reads,setReadFailure:value=>{failRead=value;},holdPartner:value=>{staleRead=value;},
    releaseHeld:()=>{heldRead?.();},hasHeld:()=>Boolean(heldRead),refuseUndo:()=>{refusal=true;}};
}
test('account and Doc entry points, filters, date range, wide evidence popup and one tap undo',async t=>{
  const {page,calls,errors}=await open(t);
  assert.equal(await page.locator('.activity-row').count(),5);
  await page.locator('#selfAvatar').click(); assert.equal(await page.locator('#accountMenu a[href="/doc-activity"]').count(),1);
  await page.keyboard.press('Escape');
  await page.locator('[name=partner]').selectOption('dell'); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===2);
  await page.locator('[name=record_type]').selectOption('document'); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===1);
  await page.locator('.activity-open').click(); assert.equal(await page.locator('#activityDetail').evaluate(el=>el.open),true);
  assert.ok((await page.locator('#activityDetail').boundingBox()).width>1000);
  await page.locator('#detailOriginal summary').click(); assert.match(await page.locator('#detailOriginalText').textContent(),/tour feedback/);
  await page.locator('#detailClose').click(); assert.equal(await page.locator('.activity-open').evaluate(el=>el===document.activeElement),true);
  await page.locator('[name=partner]').selectOption(''); await page.locator('[name=record_type]').selectOption(''); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===5);
  await page.locator('[name=from]').fill('2026-10-02'); await page.waitForFunction(()=>document.querySelector('#activityStatus').textContent==='No activity');
  await page.locator('[name=from]').fill(''); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===5);
  await page.locator('[data-undo]').first().click(); await page.getByText('Undone',{exact:true}).first().waitFor();
  assert.equal(calls.filter(c=>c.name==='revert-deal-field').length,1); assert.deepEqual(errors,[]);
  const doc=await readFile(new URL('js/doc-dock.js',root),'utf8'); assert.match(doc,/link.href = "\/doc-activity"/);
  assert.match(await readFile(new URL('conversations.html',root),'utf8'),/href="\/doc-activity"/);
});
test('unknown undo outcome retains exact request for explicit check; polling never repeats writes',async t=>{
  const {page,calls}=await open(t,{undoFailure:true});
  await page.locator('[data-undo]').first().click(); await page.getByRole('button',{name:'Check undo',exact:true}).waitFor();
  await page.clock.runFor(30_001); await page.getByRole('button',{name:'Check undo',exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.name==='revert-deal-field').length,1);
  await page.getByRole('button',{name:'Check undo',exact:true}).click(); await page.getByText('Undone',{exact:true}).first().waitFor();
  const writes=calls.filter(c=>c.name==='revert-deal-field'); assert.deepEqual(writes[0].arguments,writes[1].arguments);
});
test('automatic refresh recovers read failure and preserves filters and expanded popup',async t=>{
  const {page,reads,setReadFailure}=await open(t);
  assert.deepEqual(await page.locator('[name=partner] option').evaluateAll(xs=>xs.map(x=>x.value)),['','joe','dell']);
  await page.locator('[name=partner]').selectOption('joe'); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===3);
  await page.locator('.activity-open').first().click(); await page.locator('#detailOriginal summary').click();
  setReadFailure(true); const before=reads(); await page.clock.runFor(30_001);
  await page.getByText('Activity temporarily unavailable',{exact:true}).waitFor(); assert.ok(reads()>before);
  setReadFailure(false); await page.clock.runFor(30_001); await page.waitForFunction(()=>document.querySelector('#activityStatus').textContent==='');
  assert.equal(await page.locator('[name=partner]').inputValue(),'joe'); assert.equal(await page.locator('#detailOriginal').evaluate(el=>el.open),true);
});
test('earlier activity traverses keyset pages and remains complete after refresh',async t=>{
  const {page}=await open(t,{limit:2}); assert.equal(await page.locator('.activity-row').count(),2);
  await page.locator('#activityMore').click(); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===4);
  await page.locator('#activityMore').click(); await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===5);
  await page.clock.runFor(30_001); assert.equal(await page.locator('.activity-row').count(),5);
});
test('late filter responses never replace the current partner',async t=>{
  const {page,holdPartner,releaseHeld,hasHeld}=await open(t);
  holdPartner('joe'); await page.locator('[name=partner]').selectOption('joe');
  for(let i=0;i<40&&!hasHeld();i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(hasHeld()); await page.locator('[name=partner]').selectOption('dell');
  await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===2);
  releaseHeld(); await page.clock.runFor(100);
  assert.equal(await page.locator('[name=partner]').inputValue(),'dell'); assert.equal(await page.locator('.activity-row').count(),2);
});
test('a server refusal performs no second write and rechecks eligibility',async t=>{
  const {page,calls,refuseUndo}=await open(t); refuseUndo();
  const before=calls.filter(c=>c.name==='read-doc-activity').length;
  const reread=page.waitForResponse(response=>response.url().endsWith('/mcp')&&response.request().postDataJSON().params.name==='read-doc-activity');
  await page.locator('[data-undo]').first().click(); await reread;
  await page.getByText('Changed later',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.name==='revert-deal-field').length,1);
  assert.ok(calls.filter(c=>c.name==='read-doc-activity').length>before);
});
test('desktop and phone rendered checks, hover motion and reduced motion',async t=>{
  await mkdir(new URL('test-artifacts/w10/',root),{recursive:true});
  for(const width of [1440,390,320])await t.test(String(width),async t=>{
    const {page,errors}=await open(t,{width});
    await page.evaluate(()=>document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().iterations)).forEach(a=>a.finish()));
    assert.equal(await page.locator(".activity-row").first().evaluate(el=>getComputedStyle(el).opacity),"1");
    await page.screenshot({path:new URL(`test-artifacts/w10/activity-${width}.png`,root).pathname,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('.activity-open').first().click();
    assert.equal(await page.locator('#activityDetail').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.locator('#detailOriginal summary').click();
    await page.screenshot({path:new URL(`test-artifacts/w10/detail-${width}.png`,root).pathname});
    await page.locator('#detailClose').click(); await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('.activity-row').first().hover();
    const motion=await page.locator('.activity-row').first().evaluate(el=>({transform:getComputedStyle(el).transform,animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration}));
    assert.deepEqual(motion,{transform:'none',animation:'none',transition:'0s'}); assert.deepEqual(errors,[]);
  });
});
