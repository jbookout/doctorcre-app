import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const kinds=['work_request','portfolio_node','loop','work_shape','slice_plan','governance_item','capability_session','slice_proposal','investigation','incident','cutover_plan','retrieval_proposal','ready_plan_amendment','defect','builder_brief','progress_task','pull_request','remote_branch','builder_brief_file'];
const items=kinds.map((kind,index)=>({id:`synthetic-${index}`,source:`synthetic.${kind}`,kind,title:`Synthetic ${kind} concept`,state:'open',completed:false,
 opened_at:'2026-08-01T12:00:00Z',last_activity_at:'2026-09-01T12:00:00Z',age:61,owner:null,version:'3',link:'/system-work.html',
 available_triage_actions:kind==='loop'?[{action:'cancel',verb:'close-loop',args:{loop_id:`synthetic-${index}`,resolution:'dropped'},fields:[{name:'outcome',label:'Why cancel?',required:true}],versioned:true}]:[]}));
const live=Array.from({length:12},(_,i)=>({...items[2],id:`live-${i}`,title:i===0?'Synthetic older completed concept':`Synthetic Live ${i}`,
 completed:true,state:'done',available_triage_actions:[],last_activity_at:`2026-09-${String(i+1).padStart(2,'0')}T12:00:00Z`})).reverse();
async function open(t,width,{snapshot=true}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:900}});const calls=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/mcp'){
   const rpc=route.request().postDataJSON().params;calls.push(rpc);let payload={ok:true};
   if(rpc.name==='unfinished-work'){
    const args=rpc.arguments;let rows=args.live_library?live:items;
    if(args.id)rows=rows.filter(r=>r.id===args.id).map(r=>({...r,version:'9'}));
    if(args.text)rows=rows.filter(r=>r.title.toLowerCase().includes(args.text.toLowerCase()));
    if(args.kinds)rows=rows.filter(r=>r.kind===args.kinds);
    if(args.source)rows=rows.filter(r=>r.source===args.source);
    payload={ok:true,schema:'unfinished-work.v1',items:rows.slice(0,args.limit||100),coverage:kinds.map(kind=>({kind,source_ref:`synthetic.${kind}`,count_total:1,state:'complete'})),census_complete:true,next_cursor:null};
   }else if(rpc.name==='read-progress-board')payload={ok:true,snapshot:snapshot?{board_id:'carr-v5',version:1,updated_at:'2026-10-01T12:00:00Z',snapshot_json:{title:'Synthetic system',tasks:{}}}:null,questions:[]};
   else if(rpc.name==='list-progress-boards')payload={ok:true,schema:'progress-board-directory.v1',boards:[]};
   return route.fulfill({contentType:'application/json',body:JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}})});
  }
  if(url.pathname==='/app-release'||url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:'{}'});
  let path=url.pathname==='/control-room/progress'?'progress-board.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL('../'+path,import.meta.url)),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/control-room/progress');await page.waitForFunction(()=>document.querySelectorAll('.work-card').length===19);
 return {page,calls,errors};
}
test('all source cards and ten recent Live nodes fit phone and desktop; library finds old completion',async t=>{
 for(const width of [320,390,1440])await t.test(String(width),async t=>{
  const {page,errors}=await open(t,width);assert.equal(await page.locator('.work-source').count(),19);
  // The v2 Live column shows the newest five and expands to all ten recent Live nodes.
  assert.equal(await page.locator('.column[data-stage="live"] .board-card').count(),5);
  assert.match(await page.locator('.column[data-stage="live"] .live-summary').textContent(),/^10 live/);
  await page.locator('#live-toggle').click();
  assert.equal(await page.locator('.column[data-stage="live"] .board-card').count(),10);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Live Library',exact:true}).click();
  await page.locator('[name="text"]').fill('older completed');await page.locator('#system-work-filters button').click();
  await page.waitForFunction(()=>document.querySelectorAll('.work-card').length===1);
  assert.match(await page.locator('.work-card').textContent(),/older completed/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  if(width!==320){await mkdir('test-artifacts/w1',{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`test-artifacts/w1/progress-${width===390?'phone':'desktop'}.png`,fullPage:true});}
 });
});
test('card action confirms and calls source verb with freshly read version',async t=>{
 const {page,calls,errors}=await open(t,390);
 await page.locator('.work-card[data-work-id="synthetic-2"]').getByRole('button',{name:'cancel'}).click();
 await page.locator('#work-triage textarea').fill('Synthetic concept is stale');page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Review and confirm'}).click();
 await page.waitForFunction(()=>document.querySelector('.triage-status')?.textContent.includes('Result:'));
 const write=calls.find(c=>c.name==='close-loop');assert.equal(write.arguments.base_version,9);assert.equal(write.arguments.loop_id,'synthetic-2');
 assert.equal(write.arguments.resolution,'dropped');assert.ok(write.arguments.idempotency_key);assert.deepEqual(errors,[]);
});

test('finding 11: system census remains usable without inventing snapshot publication',async t=>{
 const {page}=await open(t,390,{snapshot:false});
 assert.equal(await page.locator('.work-card').count(),19);
 const meta=page.locator('#board-meta');
 assert.equal(await meta.getAttribute('data-read-state'),'unpublished');
 assert.doesNotMatch(await meta.textContent(),/Published|Version null/);
 await page.getByText('This board has not been published yet.',{exact:true}).waitFor();
});

test('W1: desktop work action uses a wide dialog with human category labels',async t=>{
 const {page,errors}=await open(t,1440);
 assert.equal(await page.getByRole('combobox',{name:/^Category/}).count(),1);
 assert.doesNotMatch(await page.locator('.work-source h3').first().textContent(),/synthetic\.|public\./);
 await page.locator('.work-card[data-work-id="synthetic-2"]').getByRole('button',{name:'cancel'}).click();
 assert.ok((await page.locator('#work-triage').boundingBox()).width>=900);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
