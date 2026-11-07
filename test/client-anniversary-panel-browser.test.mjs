import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('leases publishes an opt-in anniversary island', async () => {
  assert.match(await readFile(new URL('../lease-radar.html',import.meta.url),'utf8'), /id="clientAnniversaries"/);
});
import { transform, stop } from 'esbuild';
after(() => stop());
import { createHash } from 'node:crypto';
import { chromium } from './browser-harness.mjs';
import { resolve, sep } from 'node:path';
const root=resolve(new URL('../',import.meta.url).pathname);
const fixtures=JSON.parse(await readFile(new URL('./fixtures/client-anniversary-panel/recordings.json',import.meta.url),'utf8'));
const source=JSON.parse(await readFile(new URL('./fixtures/client-anniversary-panel/producer.txt',import.meta.url),'utf8'));
const provenance=JSON.parse(await readFile(new URL('./fixtures/client-anniversary-panel/provenance.json',import.meta.url),'utf8'));
const transformed=await transform(source['calendar-date.ts']+source['client-anniversary-read.ts'].replace(/^import .*$/mg,''),{loader:'ts',format:'esm'});
const producer=await import('data:text/javascript;base64,'+Buffer.from(transformed.code).toString('base64'));
const ui=await import('../js/client-anniversaries-client.js');
test('pinned registered producer and parser replay every recording through app parser',async()=>{
  for(const [name,text] of Object.entries(source))assert.equal(createHash('sha256').update(text).digest('hex'),provenance.files[name]);
  for(const fixture of Object.values(fixtures)) {
    const output=await producer.readClientAnniversaries({client:{query:async()=>{if(fixture.input===null)throw Error('synthetic');return {rows:fixture.input};}},actor:{slug:'joe'},args:{horizon_days:30,limit:20,offset:0},now:()=>new Date('2026-11-06T18:00:00Z')});
    assert.deepEqual(output,fixture.output);
    producer.parseClientAnniversaryResponse(fixture.output);
    assert.equal(ui.parseClientAnniversaries(fixture.output).state,fixture.output.state);
  }
});
async function open(t,{width=1440,theme='light'}={}) {
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
  await page.route('http://localhost/**',async route=>{
    let path;
    try {path=resolve(root,'.'+decodeURIComponent(new URL(route.request().url()).pathname));}catch{return route.fulfill({status:400,body:''});}
    if(!path.startsWith(root+sep))return route.fulfill({status:403,body:''});
    if(path===root+'/island')return route.fulfill({contentType:'text/html',body:`<html data-theme="${theme}"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/workspace.css"></head><body><div id="host"></div></body></html>`});
    try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.css')?'text/css':'text/javascript'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://localhost/island');
  await page.evaluate(async()=>{
    const {mountClientAnniversaries}=await import('/js/ui-client-anniversaries.js');
    const {parseClientAnniversaries}=await import('/js/client-anniversaries-client.js');
    window.reads=0;window.pending=[];
    window.panel=mountClientAnniversaries(document.getElementById('host'),{load:signal=>{window.reads++;window.signal=signal;return new Promise((resolve,reject)=>window.pending.push({resolve:value=>{try{resolve(parseClientAnniversaries(value));}catch(error){reject(error);}},reject}));}});
  });
  return page;
}
const complete=(page,payload)=>page.evaluate(payload=>window.pending.shift().resolve(payload),payload);
for(const width of [390,1440])for(const theme of ['light','dark'])test(`keyboard opt-in bounded snapshot at ${width} ${theme}`,async t=>{
  const page=await open(t,{width,theme});
  assert.equal(await page.evaluate(()=>window.reads),0);
  const button=page.getByRole('button',{name:'Show closing anniversaries'});await button.focus();await page.keyboard.press('Enter');
  await page.getByText('Loading closing anniversaries…').waitFor();
  await complete(page,fixtures.more.output);
  await page.getByText('More anniversary rows exist.',{exact:false}).waitFor();
  assert.equal(await page.locator('li').count(),20);
  assert.equal(await page.evaluate(()=>window.reads),1);
  assert.equal(await page.locator('li a').first().getAttribute('href'),'/clients?record=synthetic-client');
  assert.ok((await page.locator('li').first().innerText()).includes('2020-11-12'));
  assert.ok((await page.locator('li').first().innerText()).includes('2026-11-12'));
  assert.ok((await page.locator('li').first().innerText()).includes('6 days until'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Hide closing anniversaries'}).click();
  assert.equal(await page.locator('li').count(),0);
});
test('empty, unavailable, needs input and malformed data are distinct and explicitly retry',async t=>{
  const page=await open(t);
  for(const [value,text] of [[fixtures.empty.output,'No closing anniversaries in this slice.'],[fixtures.unavailable.output,'Closing anniversaries are unavailable.'],[{...fixtures.unavailable.output,state:'needs_input'},'Closing anniversaries need input.'],[{},'Closing anniversaries could not be loaded. Try again.']]){
    await page.getByRole('button',{name:'Show closing anniversaries'}).click();await complete(page,value);
    await page.getByText(text,{exact:true}).waitFor();
    if(!text.startsWith('No ')){
      await page.getByRole('button',{name:'Retry closing anniversaries'}).click();await complete(page,fixtures.ready.output);
      await page.getByText('Skipped invalid 1.',{exact:false}).waitFor();
    }
    await page.getByRole('button',{name:'Hide closing anniversaries'}).click();
  }
});
test('hide invalidates late completion and new loading ignores the older response',async t=>{
  const page=await open(t);
  await page.getByRole('button',{name:'Show closing anniversaries'}).click();
  await page.getByRole('button',{name:'Hide closing anniversaries'}).click();
  assert.equal(await page.evaluate(()=>window.signal.aborted),true);
  await page.getByRole('button',{name:'Show closing anniversaries'}).click();
  await complete(page,fixtures.ready.output);
  assert.equal(await page.locator('li').count(),0);
  await complete(page,fixtures.empty.output);
  await page.getByText('No closing anniversaries in this slice.').waitFor();
});
for(const action of ['dispose','pagehide','doctorcre-session-invalidated'])for(const state of ['idle','loading','success','empty','refusal'])test(`${action} retires ${state} and ignores late completion`,async t=>{
  const page=await open(t);
  if(state!=='idle')await page.getByRole('button',{name:'Show closing anniversaries'}).click();
  if(['success','empty','refusal'].includes(state)){
    await complete(page,state==='success'?fixtures.ready.output:state==='empty'?fixtures.empty.output:{});
    await page.locator('[aria-busy="false"]').waitFor();
  }
  await page.evaluate(action=>action==='dispose'?window.panel.dispose():window.dispatchEvent(new Event(action)),action);
  if(state==='loading')await complete(page,fixtures.ready.output);
  assert.equal(await page.locator('#host').innerText(),'');
});
test('read adapter preserves query and signal, refuses auth and malformed bodies',async()=>{
  const {createClientAnniversariesClient}=await import('../js/client-anniversaries-client.js');
  let count=0;
  const client=createClientAnniversariesClient({fetchImpl:async(path,init)=>{
    count++;assert.equal(path,'/api/v1/intelligence/client-anniversary-read?horizon_days=30&limit=20&offset=0');assert.equal(init.credentials,'same-origin');
    return new Response(JSON.stringify(fixtures.ready.output),{status:200});
  }});
  assert.deepEqual(await client.read(),fixtures.ready.output);assert.equal(count,1);
  for(const status of [401,403,503])await assert.rejects(createClientAnniversariesClient({fetchImpl:async()=>new Response('{}',{status})}).read());
  await assert.rejects(createClientAnniversariesClient({fetchImpl:async()=>new Response('{}')}).read());
});
