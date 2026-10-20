// Run with DEAL_CARD_CORPUS=<sanitized structural census JSON> node --test test/deal-card-sweep.test.mjs.
// Never accepts production credentials or writes records. The corpus stays outside source control.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,waitForAsync} from './browser-harness.mjs';
const root=new URL('../',import.meta.url);
test('all reachable deal details render without errors at phone and review widths in both themes',{skip:!process.env.DEAL_CARD_CORPUS},async t=>{
 const corpus=JSON.parse(await readFile(process.env.DEAL_CARD_CORPUS,'utf8'));
 assert.equal(corpus.details.length,corpus.denominator);
 assert.equal(new Set(corpus.details.map(d=>d.deal_id)).size,corpus.denominator);
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(3000);const failures=[];let checked=0;
 page.on('pageerror',e=>failures.push({error:e.message}));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({json:{}});
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/deals');await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.client!=null);
 for(const width of [390,1280])for(const theme of ['light','dark']) {
  await page.setViewportSize({width,height:960});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const [index,wire] of corpus.details.entries()){
   try{
    await page.evaluate(async wire=>{
     const {state}=await import('/js/pipeline.js');
     // Use the public live adapter normalization, replacing transport only.
     const {createLiveClient}=await import('/js/live-client.js');
     const client=createLiveClient({fetchImpl:async()=>new Response(JSON.stringify({result:{content:[{text:JSON.stringify(wire)}]}}),{status:200})});
     state.client.getDeal=client.getDeal;state.client.getRelationshipNetwork=async()=>({nodes:[],edges:[]});
     const deal=(await client.getDeal(wire.deal_id)).deal;state.deals.set(deal.id,deal);
     const button=document.createElement('button');button.dataset.openDeal=deal.id;button.id='sweepOpen';document.body.append(button);button.click();button.remove();
    },wire);
    await page.waitForFunction(id=>document.querySelector('#detailUpdateForm')&&document.querySelector('#recordPanel')?.open&&document.querySelector('#panelTitle')?.textContent,wire.deal_id);
    // Wait for the exact requested detail, not the previous dialog paint.
    await waitForAsync(page,async id=>(await import('/js/pipeline.js')).state.panelDetail?.deal.id===id,wire.deal_id);
    const result=await page.locator('#recordPanel').evaluate(panel=>({empty:panel.querySelector('#detailUpdateForm textarea')?.value==='',rail:panel.querySelectorAll('.phase-rail').length,overflow:panel.scrollWidth>panel.clientWidth+1,placeholder:/threads unavailable|meeting evidence unavailable|not linked/i.test(panel.textContent),notes:[...panel.querySelectorAll('.deal-note')].map(n=>({author:n.querySelector('b')?.textContent,date:n.querySelector('time')?.dateTime}))}));
    assert.equal(result.empty,true);assert.equal(result.rail,1);assert.equal(result.overflow,false);assert.equal(result.placeholder,false);
    for(const note of result.notes){assert.ok(note.author);assert.ok(Number.isFinite(Date.parse(note.date)));}
    checked++;await page.getByLabel('Close deal',{exact:true}).click();
   }catch(error){console.error(index,width,theme,error.message);failures.push({index,width,theme,error:error.message});await page.evaluate(()=>document.querySelector('#recordPanel')?.close());}
  }
 }
 await mkdir(new URL('out/test-artifacts/deal-card-review/',root),{recursive:true});
 const report={denominator:corpus.denominator,coverage:corpus.coverage,deployed_read_failures:corpus.failures.length,render_checks:checked,failures};
 await writeFile(new URL('out/test-artifacts/deal-card-review/sweep.json',root),JSON.stringify(report,null,2)+'\n');
 assert.deepEqual(failures,[]);assert.equal(checked,corpus.denominator*4);
});
