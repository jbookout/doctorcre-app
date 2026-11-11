import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, componentDocument, waitForAsync } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
const id='11111111-1111-4111-8111-111111111111';
const recordings=JSON.parse(await readFile(new URL('./fixtures/activity-attribution-panel/recordings.json',import.meta.url)));
const provenance=JSON.parse(await readFile(new URL('./fixtures/activity-attribution-panel/provenance.json',import.meta.url)));
test('canonical activities alone expose attribution', async()=>{
 const {renderDealUpdates}=await import('../js/deal-timeline.js');
 const entry=id=>({id,kind:'note',summary:'Synthetic activity',when:'2026-11-01T12:00:00Z'});
 const html=renderDealUpdates({entries:[entry(id),entry('note-1'),entry('22222222-2222-4222-8222-222222222222')],activities:[{id}]});
 assert.equal((html.match(/data-attribution-id=/g)||[]).length,1);
});
test('panel module is available',async()=>{
 const {mountActivityAttribution}=await import('../js/deal-timeline.js');
 assert.equal(typeof mountActivityAttribution,'function');
});
test('recorded registered producer and production parser agree',async t=>{
 const page=await open(t);
 const bytes=await readFile(new URL('./fixtures/activity-attribution-panel/producer.txt',import.meta.url));
 const {createHash}=await import('node:crypto');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.producer_sha256);
 assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/activity-attribution-panel/recordings.json',import.meta.url))).digest('hex'),provenance.recordings_sha256);
 const {family,parseActivityDealAttribution}=await import('data:text/javascript;base64,'+bytes.toString('base64'));
 const appParser=async value=>page.evaluate(async ({value,id})=>{const {parseActivityDealAttribution}=await import('/js/ui-activity-attribution.generated.js');return parseActivityDealAttribution(value,id);},{value,id});
 for(const row of recordings.cases){
  let calls=0;
  const actual=await family.createTools()['read-activity-deal-attribution'].handler({query:async(sql,args)=>{calls++;assert.deepEqual(args,[id,'joe']);return {rows:row.snapshot?[{snapshot:row.snapshot}]:[]};}},{id,slug:'joe',human:true},{activity_id:id});
  assert.equal(calls,1);assert.deepEqual(actual,row.response);
  assert.deepEqual(await appParser(parseActivityDealAttribution(actual)),actual);
 }
 const good=recordings.cases[0].response;
 for(const bad of [{...good,schema:undefined,schema_version:good.schema},{...good,credited_activity_count:0},{...good,candidates:[good.direct]},{...good,activity:{...good.activity,id:'bad'}},{...good,direct:{...good.direct,label:''}},{...good,direct:{...good.direct,deal_version:0}}]){
  assert.throws(()=>parseActivityDealAttribution(bad));await assert.rejects(appParser(bad));
 }
 await assert.rejects(page.evaluate(async value=>(await import('/js/ui-activity-attribution.generated.js')).parseActivityDealAttribution(value,'22222222-2222-4222-8222-222222222222'),good));
});
async function open(t,{width=1280,theme='light',pipeline=false}={}){
 const fixture=await fixtureServer();t.after(()=>fixture.close());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:900}});
 await componentDocument(page,fixture.origin,{owner:'attribution explanation',html:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/deal-timeline.css">',dispose:page=>page.evaluate(()=>window.view?.dispose())});
 await page.evaluate(({recordings,id,theme})=>{
  document.documentElement.dataset.theme=theme;window.recordings=recordings;window.activityId=id;
 },{recordings,id,theme});
 await page.evaluate(async()=>{
  const {renderDealUpdates}=await import('/js/deal-timeline.js');const {mountActivityAttribution}=await import('/js/deal-timeline.js');
  const host=document.createElement('main');host.id='probe';document.body.append(host);
  host.innerHTML=renderDealUpdates({entries:[{id:window.activityId,kind:'note',summary:'Synthetic activity',when:'2026-11-01T12:00:00Z'},{id:'22222222-2222-4222-8222-222222222222',kind:'note',summary:'Second activity',when:'2026-11-01T12:00:00Z'},{id:'event',kind:'phase',summary:'Synthetic timeline',when:'2026-11-01T12:00:00Z'}],activities:[{id:window.activityId},{id:'22222222-2222-4222-8222-222222222222'}]});
  host.querySelector('details').open=true;
  window.probe={calls:0,payload:window.recordings.cases[0].response,denied:0};
  window.makeView=()=>mountActivityAttribution(host,{
   read:async(activity,signal)=>{window.probe.calls++;window.probe.args={activity,aborted:signal.aborted};if(window.probe.failure)throw window.probe.failure;return window.probe.pending || window.probe.payload;},
   load:async()=>{if(window.probe.importPending)await window.probe.importPending;return import('/js/ui-activity-attribution.generated.js');},
   onDenied:()=>window.probe.denied++,
  });window.view=window.makeView();
 });
 return page;
}
for(const width of [390,1280])for(const theme of ['light','dark'])test(`recorded states, escaped labels and keyboard return at ${width} ${theme}`,async t=>{
 const page=await open(t,{width,theme});
 assert.equal(await page.evaluate(()=>window.probe.calls),0);
 for(const row of recordings.cases){
  await page.evaluate(response=>window.probe.payload=response,row.response);
  await page.getByRole('button',{name:'Show deal attribution'}).first().focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:({direct:'Direct deal attribution',source_linked:'Source-linked deal needs review',ambiguous:'Ambiguous deals need review',unresolved:'Deal attribution unresolved',unknown:'Activity attribution unknown',unavailable:'Activity attribution unavailable'})[row.name]}).waitFor();
  assert.match(await page.locator('[aria-label="Activity deal attribution"]').textContent(),new RegExp(`${row.response.credited_activity_count} credited activities`));
  const deals=row.response.direct?[row.response.direct]:row.response.candidates;
  assert.deepEqual(await page.locator('[aria-label="Activity deal attribution"] a').evaluateAll(a=>a.map(x=>({label:x.textContent,href:x.getAttribute('href')}))),deals.map(d=>({label:d.label,href:'/deals?deal='+d.deal_id})));
  await page.getByText('Version evidence',{exact:true}).click();
  if(row.response.activity)assert.match(await page.locator('[aria-label="Activity deal attribution"]').textContent(),/version 3/);
  assert.equal(await page.locator('main').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  if(row.name==='direct'){
   assert.ok((await page.getByRole('button',{name:'Close attribution'}).boundingBox()).height>=44);
   await mkdir('out/test-artifacts/activity-attribution',{recursive:true});
   await page.screenshot({path:`out/test-artifacts/activity-attribution/${width}-${theme}.png`});
  }
  await page.getByRole('button',{name:'Close attribution'}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'Show deal attribution'}).first().evaluate(n=>n===document.activeElement),true);
 }
 assert.equal(await page.evaluate(()=>window.probe.calls),6);
});
test('one in-flight read, explicit retry, malformed data and auth retirement',async t=>{
 const page=await open(t);
 await page.evaluate(()=>window.probe.failure=new Error('synthetic read failure'));
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();await page.getByRole('alert').waitFor();
 await page.evaluate(()=>window.probe.failure=null);await page.getByRole('button',{name:'Retry attribution'}).click();await page.getByRole('heading',{name:'Direct deal attribution'}).waitFor();
 assert.equal(await page.evaluate(()=>window.probe.calls),2);
 await page.getByRole('button',{name:'Close attribution'}).click();
 await page.evaluate(()=>window.probe.payload={...window.probe.payload,credited_activity_count:0});
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('[aria-label="Activity deal attribution"] a').count(),0);
 await page.evaluate(()=>{window.probe.payload=window.recordings.cases[0].response;window.probe.pending=new Promise(r=>window.release=r);});
 await page.getByRole('button',{name:'Retry attribution'}).click();
 await page.waitForFunction(()=>window.probe.calls===4);
 assert.equal(await page.getByRole('button',{name:'Show deal attribution'}).nth(1).isDisabled(),true);
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();
 assert.equal(await page.evaluate(()=>window.probe.calls),4,'repeated activation cannot start another in-flight read');
 await page.keyboard.press('Escape');await page.evaluate(()=>{window.release(window.probe.payload);window.probe.pending=null;});
 assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(),0);
 await page.evaluate(()=>window.probe.failure={status:403});await page.getByRole('button',{name:'Show deal attribution'}).first().click();
 await page.waitForFunction(()=>window.probe.denied===1);assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(),0);
});
for(const operation of ['dispose','session','late-import','close'])test(`${operation} retires delayed work`,async t=>{
 const page=await open(t);
 await page.evaluate(operation=>{
  if(operation==='late-import')window.probe.importPending=new Promise(r=>window.finishImport=r);
  else window.probe.pending=new Promise(r=>window.release=r);
 },operation);
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();
 if(operation!=='late-import')await page.waitForFunction(()=>window.probe.calls===1);
 if(operation==='close')await page.keyboard.press('Escape');
 else await page.evaluate(operation=>{if(operation==='session')window.dispatchEvent(new Event('doctorcre-session-invalidated'));else window.view.dispose();},operation);
 await page.evaluate(operation=>{if(operation==='late-import')window.finishImport();else window.release(window.probe.payload);},operation);
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,30)));
 assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(),0);
 if(operation==='late-import')assert.equal(await page.evaluate(()=>window.probe.calls),0);
});
test('every settled state clears on session retirement and a failed explanation closes',async t=>{
 const page=await open(t);
 for(const row of recordings.cases){
  await page.evaluate(response=>{window.view.dispose();window.probe.payload=response;window.probe.failure=null;window.view=window.makeView();},row.response);
  await page.getByRole('button',{name:'Show deal attribution'}).first().click();await page.locator('[aria-label="Activity deal attribution"] h4').waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(),0);
 }
 await page.evaluate(()=>{window.view=window.makeView();window.probe.failure=new Error('synthetic unavailable');});
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();await page.getByRole('alert').waitFor();
 await page.getByRole('button',{name:'Close attribution'}).click();assert.equal(await page.locator('[aria-label="Activity deal attribution"]').count(),0);
 await page.evaluate(()=>{window.probe.failure=null;window.probe.payload=window.recordings.cases[0].response;});
 await page.getByRole('button',{name:'Show deal attribution'}).first().click();await page.getByRole('heading',{name:'Direct deal attribution'}).waitFor();
 await page.getByRole('button',{name:'Show deal attribution'}).nth(1).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.locator('[aria-label="Activity deal attribution"] a').count(),0,'selection cannot adopt the wrong activity response');
});
