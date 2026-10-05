import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { chromium, settles } from './browser-harness.mjs';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
const root=new URL('../',import.meta.url);
const artifactDir=await mkdtemp(join(tmpdir(),'doctorcre-activity-browser-'));
await buildArtifact({root:fileURLToPath(root),outDir:artifactDir,commit:'1'.repeat(40)});
const site=pathToFileURL(join(artifactDir,'site')+'/');
const routes=JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
async function open(t,{width=1440,reducedMotion='no-preference',undoFailure=false,limit=50,holdUndos=false,readTransform=answer=>answer,firstOpen=false}={}) {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:960},reducedMotion,timezoneId:'UTC'});
  if(!firstOpen)await page.addInitScript(()=>{
    if(!localStorage.getItem('doctorcre:morning:joe'))localStorage.setItem('doctorcre:morning:joe',JSON.stringify({day:'2026-10-01',lastShownAt:'2026-10-01T14:00:00Z',since:'2026-09-30T17:00:00Z'}));
  });
  const fixture=createDocActivityFixture(()=>new Date('2026-10-01T15:00:00Z')), calls=[],errors=[];
  const undoHolds=new Map(),undoReady=new Map();
  let fail=undoFailure, reads=0, failRead=false, staleRead=null, heldRead=null, refusal=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()); if(url.origin!=='http://localhost')return route.abort();
    if(url.pathname==='/mcp'){
      const {params}=route.request().postDataJSON(); calls.push(params);
      let result;
      if(params.name==='read-doc-activity'){
        reads++; if(failRead)return route.fulfill({status:503,body:''});
        result=readTransform(await fixture.read({...params.arguments,limit}),params.arguments);
        if(refusal)result.entries[0].undo={state:"superseded"};
        if(staleRead===params.arguments.partner){staleRead=null;await new Promise(resolve=>{heldRead=resolve;});}
      }else if(params.name==='revert-deal-field'){
        const outcome=holdUndos?await new Promise(resolve=>{undoHolds.set(params.arguments.event_id,resolve);undoReady.get(params.arguments.event_id)?.();}):'success';
        if(outcome==='unknown')return route.fulfill({status:504,body:''});
        if(outcome==='refused')return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:'newer_change_exists'})}]}})});
        if(refusal)return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:'newer_change_exists'})}]}})});
        result=await fixture.undo(params.arguments);
        if(fail){fail=false;return route.fulfill({status:504,body:''});}
      }else if(params.name==='deal-room-board'){
        result={actor:'joe',deals:[]};
      }else if(params.name==='today-triage'){
        result={items:[]};
      }else if(params.name==='list-doc-suggestions'){
        result={ok:true,suggestions:[]};
      }else if(params.name==='morning-brief'){
        result={state:'ready',sponsor:'joe',sections:{today:{state:'empty',items:[]},deals:{state:'empty',items:[]},loops:{state:'empty',items:[]}}};
      }else { errors.push(`Unexpected MCP operation: ${params.name}`); return route.fulfill({status:500,body:''}); }
      return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(result)}]}})});
    }
    if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'}})});
    if(url.pathname==='/pipeline/changes')return route.fulfill({json:{events:[],cursor:null}});
    const file=routes.routes[url.pathname]||url.pathname.slice(1);
    try{return route.fulfill({body:await readFile(new URL(file,site)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
  await page.goto('http://localhost/doc-activity?mode=live'); await page.locator('.activity-row').first().waitFor();
  if(firstOpen){await page.locator('#docMorningBrief[open]').waitFor();await page.locator('#morningClose').click();}
  return {page,calls,errors,fixture,reads:()=>reads,setReadFailure:value=>{failRead=value;},holdPartner:value=>{staleRead=value;},
    waitUndo:id=>undoHolds.has(id)?Promise.resolve():new Promise(resolve=>undoReady.set(id,resolve)),releaseUndo:(id,outcome='success')=>undoHolds.get(id)?.(outcome),releaseHeld:()=>{heldRead?.();},hasHeld:()=>Boolean(heldRead),refuseUndo:()=>{refusal=true;}};
}
test('PR123 R1: Activity models the daily morning brief and rejects unknown operations', async t => {
  const { page, calls, errors } = await open(t, { firstOpen: true });
  const preference = () => page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:morning:joe')));
  assert.equal((await preference())?.day, '2026-10-01');
  assert.ok(calls.some(call => call.name === 'morning-brief'));
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#morningCoverage').textContent(), '');
  const loaded = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'morning-brief');
  await page.reload(); await loaded;
  await page.waitForFunction(() => document.querySelector('#morningUpdated')?.hasAttribute('datetime'));
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
  await page.locator('#docMorningBrief[open]').waitFor();
  await page.locator('#morningClose').click();
  await page.clock.setSystemTime(new Date('2026-10-02T15:00:00Z'));
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.locator('#docMorningBrief[open]').waitFor();
  assert.equal((await preference()).day, '2026-10-02');
  assert.deepEqual(errors, []);
  const status = await page.evaluate(async () => (await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unknown-operation', arguments: {} } }) })).status);
  assert.equal(status, 500);
  assert.deepEqual(errors, ['Unexpected MCP operation: unknown-operation']);
});

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
  assert.match(await readFile(new URL('conversations.html',root),'utf8'),/href="\/doc-activity"/);
});
test('an invalid date range is labelled and never sent to the server',async t=>{
  const {page,calls}=await open(t);
  await page.locator('[name=to]').fill('2026-10-01');
  await page.waitForFunction(()=>document.querySelector('#activityStatus').textContent==='');
  const reads=calls.filter(c=>c.name==='read-doc-activity').length;
  await page.locator('[name=from]').fill('2026-10-03');
  await page.getByText('Invalid date range',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.name==='read-doc-activity').length,reads);
  await page.locator('[name=from]').fill('2026-10-01');
  await page.waitForFunction(()=>document.querySelector('#activityStatus').textContent==='');
  assert.equal(await page.locator('.activity-row').count(),5);
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
  await settles(()=>assert.ok(hasHeld())); await page.locator('[name=partner]').selectOption('dell');
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

test('Undo feedback stays with its event across popup changes and concurrent completion orders',async t=>{
  for(const outcome of ['success','unknown','refused'])for(const order of ['A-first','B-first'])await t.test(`${outcome} ${order}`,async t=>{
    const {page,releaseUndo,waitUndo}=await open(t,{holdUndos:true});
    const a=await page.locator('[data-undo]').nth(0).getAttribute('data-undo');
    const b=await page.locator('[data-undo]').nth(1).getAttribute('data-undo');
    const start=async id=>{
      await page.locator(`[data-open="${id}"]`).click();
      const sent=page.waitForRequest(r=>r.url().endsWith('/mcp')&&r.postDataJSON()?.params.name==='revert-deal-field'&&r.postDataJSON().params.arguments.event_id===id);
      await page.locator('#detailUndo').click();await sent;await waitUndo(id);
    };
    await start(a);await page.locator('#detailClose').click();await start(b);
    const finish=async (id,result)=>{
      const received=page.waitForResponse(r=>r.url().endsWith('/mcp')&&r.request().postDataJSON()?.params.name==='revert-deal-field'&&r.request().postDataJSON().params.arguments.event_id===id);
      releaseUndo(id,result);await received;
      await page.waitForFunction(id=>document.querySelector(`[data-undo="${id}"]`)?.textContent!=='Undoing…',id);
    };
    if(order==='A-first'){
      await finish(a,outcome);
      assert.equal(await page.locator('#detailResult').textContent(),'');
      await finish(b,'success');
    }else{
      await finish(b,'success');await finish(a,outcome);
    }
    assert.equal(await page.locator('#detailTitle').textContent(),'Demo Northside Therapy');
    assert.equal(await page.locator('#detailResult').textContent(),'Change undone');
    await page.locator('#detailClose').click();await page.locator(`[data-open="${a}"]`).click();
    assert.equal(await page.locator('#detailResult').textContent(),{success:'Change undone',unknown:'Undo not confirmed',refused:'Undo unavailable'}[outcome]);
  });
});

test('polling new arrivals preserves loaded history, expanded detail and the next-page boundary',async t=>{
  const fixture=createDocActivityFixture(()=>new Date('2026-10-01T15:00:00Z'));
  const history=(await fixture.read()).entries;let inserted=[];
  const readTransform=(answer,args)=>{
    const rows=[...inserted,...history].filter(row=>!args.cursor||row.at<args.cursor.at||(row.at===args.cursor.at&&row.id<args.cursor.id));
    const entries=rows.slice(0,2),last=entries.at(-1);
    return {...answer,entries,next_cursor:rows.length>2?{at:last.at,id:last.id}:null};
  };
  const {page}=await open(t,{limit:2,readTransform});
  await page.locator('#activityMore').click();await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===4);
  const oldest=history[3];await page.locator(`[data-open="${oldest.id}"]`).click();await page.locator('#detailOriginal summary').click();
  inserted=[2,1].map(i=>({...history[0],id:`a2000000-0000-4000-8000-${String(i).padStart(12,'0')}`,at:`2026-10-01T15:0${i}:00Z`,what:'New arrival',undo:{state:'unavailable'}}));
  await page.clock.runFor(30_001);
  await page.waitForFunction(()=>document.querySelector('.activity-subject strong').textContent==='New arrival');
  assert.equal(await page.locator(`[data-open="${oldest.id}"]`).count(),1);
  assert.equal(await page.locator('#activityDetail').evaluate(el=>el.open),true);
  assert.equal(await page.locator('#detailOriginal').evaluate(el=>el.open),true);
  assert.equal(await page.locator('#detailTitle').textContent(),oldest.record.name);
  await page.locator('#detailClose').click();await page.locator('#activityMore').click();
  await page.waitForFunction(()=>document.querySelectorAll('.activity-row').length===7);
  assert.deepEqual(await page.locator('[data-open]').evaluateAll(xs=>xs.map(x=>x.dataset.open)),[...inserted,...history].map(row=>row.id));
});

test('malformed and mixed reads preserve the last valid feed and expanded detail until recovery',async t=>{
  for(const mode of ['malformed','mixed'])await t.test(mode,async t=>{
    let broken=false;
    const {page}=await open(t,{readTransform:answer=>broken?{...answer,entries:mode==='mixed'?[answer.entries[0],{...answer.entries[1],id:null}]:[{...answer.entries[0],id:null}]}:answer});
    await page.locator('.activity-open').first().click();await page.locator('#detailOriginal summary').click();
    broken=true;await page.clock.runFor(30_001);
    await page.getByText('Activity temporarily unavailable',{exact:true}).waitFor();
    assert.equal(await page.locator('.activity-row').count(),5);
    assert.equal(await page.locator('#activityDetail').evaluate(el=>el.open),true);
    assert.equal(await page.locator('#detailOriginal').evaluate(el=>el.open),true);
    broken=false;await page.clock.runFor(30_001);
    await page.waitForFunction(()=>document.querySelector('#activityStatus').textContent==='');
  });
});

test('unsupported or mismatched inverses display unavailable and never offer an inert Undo',async t=>{
  for(const inverse of ['unsupported','mismatched'])await t.test(inverse,async t=>{
    const {page,calls}=await open(t,{readTransform:answer=>({...answer,entries:answer.entries.map((row,i)=>i?row:{...row,undo:{...row.undo,...(inverse==='unsupported'?{verb:'future-verb'}:{event_id:'other'})}})})});
    const row=page.locator('.activity-row').first();
    assert.equal(await row.locator('[data-undo]').count(),0);
    assert.match(await row.textContent(),/Undo unavailable/);
    await row.locator('[data-open]').click();assert.equal(await page.locator('#detailUndo').isDisabled(),true);
    assert.equal(await page.locator('#detailUndo').textContent(),'Undo unavailable');
    assert.equal(calls.filter(c=>c.name==='revert-deal-field').length,0);
  });
});

test('long record names, rationale URLs and evidence wrap at desktop and phone widths',async t=>{
  const long='https://example.test/'+ 'a'.repeat(150);
  for(const width of [1440,390,320])await t.test(String(width),async t=>{
    const {page}=await open(t,{width,readTransform:answer=>({...answer,entries:answer.entries.map(row=>({...row,record:{...row.record,name:long},what:long,why:long,before:long,after:long,evidence:{...row.evidence,quote:long,summary:long}}))})});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('.activity-open').first().click();await page.locator('#detailOriginal summary').click();
    assert.equal(await page.locator('#activityDetail').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.locator('#detailTitle').textContent(),long);
    assert.equal(await page.locator('#detailWhy').textContent(),long);
    assert.equal(await page.locator('#detailQuote').textContent(),long);
  });
});
