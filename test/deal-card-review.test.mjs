import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, access} from 'node:fs/promises';
import {chromium, waitForAsync} from './browser-harness.mjs';
const root=new URL('../',import.meta.url);
async function open(t,width=1280) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
 Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Negotiation',next_step:'Prior status that must not prefill',workspace_kind:'team',account_client_id:null,operating_state:'active'});
 seed.threads.d14=[{id:'demo-old',kind:'note',actor:'joe',text:'Older demo update',created_at:'2026-09-01T15:30:00Z',recorded_at:'2026-09-01T15:30:00Z'},
 {id:'demo-new',kind:'note',actor:'dell',text:'Newest demo update. '+ 'Detailed synthetic context. '.repeat(120),created_at:'2026-10-02T17:45:00Z',recorded_at:'2026-10-02T17:45:00Z'}];
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/data/board-seed.json')return route.fulfill({json:seed});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({json:{}});
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/deals');
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.deals.size>0);
 await page.locator('.kanban-column [data-id="d14"] .card-open').click();
 await page.waitForSelector('#detailPhase');
 return {page,errors};
}

test('every deal snapshot opens with an empty Update above a full-width newest-first attributed feed',async t=>{
 await mkdir(new URL('out/test-artifacts/deal-card-review/',root),{recursive:true});
 for(const width of [390,1280]) await t.test(String(width),async t=>{
  const {page,errors}=await open(t,width);
  const before=new URL(`out/test-artifacts/deal-card-review/${width}-before.png`,root).pathname;
  try{await access(before);}catch{await page.screenshot({path:before,animations:'disabled'});}
  assert.equal(await page.locator('#detailUpdateForm').count(),1);
  assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'');
  const form=await page.locator('#detailUpdateForm').boundingBox(),notes=await page.locator('.deal-updates').boundingBox();
  assert.ok(form.y+form.height<notes.y);assert.ok(form.y+form.height<960);
  assert.equal(await page.locator('.deal-note').first().getAttribute('data-id'),'demo-new');
  assert.match(await page.locator('.deal-note').first().textContent(),/Dell/);
  assert.equal(await page.locator('.deal-note').first().locator('time').getAttribute('datetime'),'2026-10-02T17:45:00Z');
  assert.equal(await page.locator('.timeline-chart').count(),0);
  assert.equal(await page.locator('[aria-label="Deal phases and timeline"]').count(),1);
  assert.doesNotMatch(await page.locator('#recordPanel').textContent(),/threads unavailable|meeting evidence unavailable|not linked/i);
  assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.screenshot({path:new URL(`out/test-artifacts/deal-card-review/${width}-after.png`,root).pathname,animations:'disabled'});
  await page.locator('.deal-updates').scrollIntoViewIfNeeded();
  await page.screenshot({path:new URL(`out/test-artifacts/deal-card-review/${width}-notes-after.png`,root).pathname,animations:'disabled'});
  assert.deepEqual(errors,[]);
 });
});

test('lost deals have a searchable view and open the shared snapshot',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,outcome:'lost'}};};state.lostDeals=[{id:'d14',name:'Demo Lost Practice',client_name:'Demo Lost Client',type:'Relocation',outcome:'lost',phase:'Closed'}];});
 await page.getByRole('button',{name:'Close deal',exact:true}).click();
 await page.getByRole('button',{name:'Lost deals',exact:true}).click();
 assert.equal(await page.locator('#closedCount').textContent(),'1 lost deals');
 await page.getByLabel('Search lost deals').fill('Demo Lost Client');
 await page.locator('#closedDealsList [data-open-deal="d14"]').click();
 await page.locator('#detailUpdateForm').waitFor();
 assert.match(await page.locator('.deal-snapshot-facts').textContent(),/OutcomeLost/);
 assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(),'');
});
