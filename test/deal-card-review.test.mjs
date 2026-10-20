import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, access} from 'node:fs/promises';
import {chromium, waitForAsync, animationsSettled} from './browser-harness.mjs';
const root=new URL('../',import.meta.url);
const longestNextStep='Confirm appointment with Demo Clinic';
async function open(t,width=1280,{theme='dark',sparse=false,showDetail=true,height=960}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height}});
 await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
 Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Negotiation',next_step:'Prior status that must not prefill',workspace_kind:'team',account_client_id:null,operating_state:'active'});
 seed.deals.find(d=>d.id==='d20').next_step=longestNextStep;
 if(sparse) seed.deals=seed.deals.filter((d,i)=>i<5||d.id==='d14');
 seed.threads.d14=[{id:'demo-old',kind:'note',actor:'joe',text:'Older demo update',created_at:'2026-09-01T15:30:00Z',recorded_at:'2026-09-01T15:30:00Z'},
 {id:'demo-new',kind:'note',actor:'dell',text:'Newest demo update. '+ 'Detailed synthetic context. '.repeat(120),created_at:'2026-10-02T17:45:00Z',recorded_at:'2026-10-02T17:45:00Z'}];
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/data/board-seed.json')return route.fulfill({json:seed});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({json:{}});
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/deals'+(showDetail?'?deal=d14':''));
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.deals.size>0);
 if(showDetail) await page.waitForSelector('#detailPhase');
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


test('archive-only snapshots hide board mutation controls',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');
  const deal={id:'demo-archived',name:'Demo historical practice',phase:'Closed',outcome:'won',type:'Renewal',closed_on:'2026-10-01'};
  state.closedDeals=[deal];
  state.client.getDeal=async()=>({deal,thread:[],history:[],participants:[],critical_dates:[]});
 });
 await page.getByRole('button',{name:'Close deal',exact:true}).click();
 await page.getByRole('button',{name:'Closed deals',exact:true}).click();
 await page.locator('[data-open-deal="demo-archived"]').click();
 await page.locator('#detailUpdateForm').waitFor();
 assert.equal(await page.locator('#detailPhase').count(),0,'archived phase cannot use the board-only move path');
 assert.equal(await page.locator('#detailOwner').count(),0);
 assert.equal(await page.locator('#detailParkForm').count(),0);
 await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
 await page.waitForTimeout(100);
 assert.deepEqual(errors,[]);
});


test('deal review prioritizes cards, page tabs and Add deal in both themes and widths',async t=>{
 const dir=new URL('out/test-artifacts/dealroom-round2/',root);await mkdir(dir,{recursive:true});
 for(const width of [390,1280])for(const theme of ['dark','light'])await t.test(`${width}-${theme}`,async t=>{
  const {page,errors}=await open(t,width,{theme,sparse:true,showDetail:false});
  const evidence=async name=>page.screenshot({path:new URL(`${width}-${theme}-${name}.png`,dir).pathname,animations:'disabled'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  const columns=await page.locator('.kanban-column:visible').evaluateAll(nodes=>nodes.map(n=>({top:n.getBoundingClientRect().top,cards:n.querySelectorAll('.kanban-card').length})));
  assert.ok(columns[0].cards>0 || width>760,'the first phone stage contains active deals');
  if(width===1280){
   assert.equal(new Set(columns.map(n=>Math.round(n.top))).size,1,'desktop stages share one row');
   assert.ok((await page.locator('#kanban').boundingBox()).width>1050,'board gets desktop width');
  }
  assert.equal(await page.locator('.app-section-tabs').isVisible(),true);
  assert.equal(await page.locator('.app-section-tabs [aria-current="page"]').textContent(),'Local Deals');
  const add=await page.locator('#addDealOpen').boundingBox();assert.ok(add.x>=0&&add.x+add.width<=width,'Add deal stays in view');
  assert.equal(await page.locator('#addDealOpen').evaluate(n=>getComputedStyle(n).backgroundColor!==getComputedStyle(n.parentElement).backgroundColor),true,'Add deal has a primary fill');
  await evidence('board');
  await page.locator('[data-id="d14"] .card-open').click();await page.locator('#detailUpdateForm').waitFor();

  const rails=await page.locator('.phase-rail li').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));
  assert.equal(new Set(rails).size,1,'phase timeline is a continuous row');
  assert.ok((await page.locator('.deal-timeline').boundingBox()).height<160,'phase timeline stays compact');
  assert.equal(await page.locator('#panelContextOpen').isVisible(),false,'a name without a relationship does not advertise context');
  assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  assert.deepEqual(errors,[]);
  await evidence('detail');
 });
});


test('phone timeline has one rail and unlinked snapshots hide context',async t=>{
 const {page}=await open(t,390);

 await t.test('compact rail',async()=>{
  const tops=await page.locator('.phase-rail li').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size,1);
 });
 await t.test('no empty context',async()=>assert.equal(await page.locator('#panelContextOpen').isVisible(),false));
});


test('an open snapshot removes board controls when a refresh records closure',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;
  state.client.getDeal=async id=>{const detail=await read(id);return {...detail,deal:{...detail.deal,phase:'Closed',outcome:'won'}};};
 });
 await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.phase-rail [aria-current] span')?.textContent==='Closed');
 assert.equal(await page.locator('#detailPhase').count(),0);
 assert.equal(await page.locator('#detailOwner').count(),0);
 assert.deepEqual(errors,[]);
});


test('phone deal title stays clear of Doc through the full timeline scroll',async t=>{
 const {page}=await open(t,390,{height:844});
 await page.locator('#recordPanel > #docPresence').waitFor();
 await animationsSettled(page);
 const maxScroll=await page.locator('#recordPanel').evaluate(n=>n.scrollHeight-n.clientHeight);
 assert.ok(maxScroll>0,'fixture exercises a scrolling snapshot');
 for(const top of [...new Set([0,44,...Array.from({length:Math.ceil(maxScroll/16)},(_,i)=>i*16),maxScroll])]){
  await page.locator('#recordPanel').evaluate((n,top)=>{n.scrollTop=top;},top);
  const obscured=await page.locator('#panelTitle').evaluate(title=>{
   const box=title.getBoundingClientRect(),hits=[];
   for(let y=box.top+1;y<box.bottom;y+=4)for(let x=box.left+1;x<box.right;x+=4){
    const hit=document.elementFromPoint(x,y);
    if(!title.contains(hit))hits.push({x,y,hit:hit?.id||hit?.className});
   }
   return hits.slice(0,5);
  });
  assert.deepEqual(obscured,[],`title remains hit-testable at scroll ${top}`);
 }
 await page.locator('.deal-timeline').scrollIntoViewIfNeeded();
 await mkdir(new URL('out/test-artifacts/dealroom-final/',root),{recursive:true});
 await page.screenshot({path:new URL('out/test-artifacts/dealroom-final/390-d14-scrolled.png',root).pathname,animations:'disabled'});
});


test('desktop board shows the full longest next step within three lines',async t=>{
 const {page}=await open(t,1280,{theme:'light',showDetail:false});
 await animationsSettled(page);
 const step=page.locator('.kanban-column [data-id="d20"] .next-line');
 assert.equal(await step.textContent(),longestNextStep);
 assert.equal(await step.getAttribute('title'),longestNextStep);
 const layout=await step.evaluate(n=>{
  const box=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);
  const lines=[...range.getClientRects()];
  return {height:box.height,lineHeight:parseFloat(getComputedStyle(n).lineHeight),
   clipped:lines.filter(line=>line.bottom>box.bottom+1||line.right>box.right+1).length};
 });
 assert.equal(layout.clipped,0,'the whole sentence fits inside the visible next step');
 assert.ok(layout.height>layout.lineHeight*2,'fixture exercises the third line');
 assert.ok(layout.height<=layout.lineHeight*3+1,'next step uses at most three lines');
 assert.ok((await step.locator('..').boundingBox()).height<240,'card stays compact');
 await mkdir(new URL('out/test-artifacts/dealroom-final/',root),{recursive:true});
 await page.screenshot({path:new URL('out/test-artifacts/dealroom-final/1280-light-board.png',root).pathname,animations:'disabled'});
});
