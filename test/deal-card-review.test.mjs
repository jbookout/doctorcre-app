import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, access} from 'node:fs/promises';
import {chromium, waitForAsync, animationsSettled} from './browser-harness.mjs';
const root=new URL('../',import.meta.url);
const longestNextStep='Confirm the Demo Clinic appointment and send notes';
async function open(t,width=1280,{theme='dark',sparse=false,showDetail=true,height=960,nextStep='Prior status that must not prefill',closedOn=null,manyUpdates=false,denseBoard=false}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height}});
 await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
 Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Negotiation',next_step:nextStep,closed_on:closedOn,workspace_kind:'team',account_client_id:null,operating_state:'active',phase_started_on:{pending:'2026-08-10',research:'2026-08-31',site_selection:'2026-09-08',negotiation:'2026-09-20'}});
 seed.deals.find(d=>d.id==='d20').next_step=longestNextStep;
 if(denseBoard) {
  seed.deals.forEach(deal=>{if(deal.phase==='Research') deal.phase='Negotiation';});
  seed.deals.push(...Array.from({length:100},(_,i)=>({...seed.deals.find(d=>d.id==='d14'),id:`demo-dense-${i}`,phase:'Research',name:`Demo multidisciplinary healthcare practice with a deliberately long full name number ${i}`,short_name:`Demo short ${i}`})));
 }
 if(sparse) seed.deals=seed.deals.filter((d,i)=>i<5||d.id==='d14');
 seed.threads.d14=[{id:'demo-old',kind:'note',actor:'joe',text:'Older demo update',created_at:'2026-09-01T15:30:00Z',recorded_at:'2026-09-01T15:30:00Z'},
 {id:'demo-new',kind:'note',actor:'dell',text:'Newest demo update. '+ 'Detailed synthetic context. '.repeat(120),created_at:'2026-10-02T17:45:00Z',recorded_at:'2026-10-02T17:45:00Z'}];
 if(manyUpdates) seed.threads.d14=Array.from({length:30},(_,i)=>({id:`demo-note-${i}`,kind:'note',actor:'joe',text:`Demo update ${i}. `+'Detailed synthetic context. '.repeat(12),recorded_at:new Date(Date.UTC(2026,9,20,12,0,i)).toISOString()}));
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

test('every deal snapshot opens with an empty Update above a concise overview and expandable attributed history',async t=>{
 await mkdir(new URL('out/test-artifacts/deal-card-review/',root),{recursive:true});
 for(const width of [390,1280]) await t.test(String(width),async t=>{
  const {page,errors}=await open(t,width);
  const before=new URL(`out/test-artifacts/deal-card-review/${width}-before.png`,root).pathname;
  try{await access(before);}catch{await page.screenshot({path:before,animations:'disabled'});}
  assert.equal(await page.locator('#detailUpdateForm').count(),1);
  assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'');
  const form=await page.locator('#detailUpdateForm').boundingBox(),notes=await page.locator('.deal-updates').boundingBox();
  assert.ok(form.y+form.height<notes.y);assert.ok(form.y+form.height<960);
  await page.locator('.updates-history > summary').click();
  assert.equal(await page.locator('.deal-note').first().getAttribute('data-id'),'demo-new');
  assert.match(await page.locator('.deal-note').first().textContent(),/Dell/);
  assert.equal(await page.locator('.deal-note').first().locator('time').getAttribute('datetime'),'2026-10-02T17:45:00Z');
  assert.equal(await page.locator('.timeline-chart').count(),0);
  assert.equal(await page.locator('[aria-label="Deal phases and timeline"]').count(),1);
  await page.locator('#panelEvidenceSection > summary').click();
  await page.locator('[data-evidence-retry]').first().waitFor();
  assert.match(await page.locator('#recordPanel').textContent(),/Threads unavailable/);
  assert.equal(await page.locator('[data-evidence-retry]').count()>0,true);
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
 assert.equal(await page.locator('.full-record').count(),0,'empty record sections do not create placeholder output');
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
  assert.equal(new Set(rails).size,width===390?2:1,'phase dates fit without horizontal scrolling');
  assert.ok((await page.locator('.deal-timeline').boundingBox()).height<(width===390?330:200),'phase timeline stays compact');
  assert.equal(await page.locator('#panelContextOpen').isVisible(),true,'linked context loads only when opened');
  assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  assert.deepEqual(errors,[]);
  await evidence('detail');
 });
});


test('phone timeline has one rail and unlinked context opens an explicit empty state',async t=>{
 const {page}=await open(t,390);

 await t.test('compact rail',async()=>{
  const tops=await page.locator('.phase-rail li').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size,2);
 });
 await t.test('explicit empty context',async()=>{
  await page.locator('#panelContextOpen').click();
  await page.getByText('No linked context recorded.',{exact:true}).waitFor();
 });
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


test('desktop checklist titles fit without exposing the legacy next-step paragraph',async t=>{
 const {page}=await open(t,1280,{theme:'light',showDetail:false});
 const card=page.locator('.kanban-column [data-id="d14"]');
 assert.deepEqual(await card.locator('ol button').allTextContents(),['Vendor Introductions','Prelim Market Study','ETL not completed']);
 assert.equal(await card.locator('.next-line').count(),0);
 assert.equal(await card.evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.doesNotMatch(await card.textContent(),/Prior status that must not prefill/);
});

test('empty legacy next steps preserve existing structured items',async t=>{
 const {page}=await open(t,390,{showDetail:false,nextStep:' \t\n '});
 const card=page.locator('.kanban-column [data-id="d14"]');
 assert.equal(await card.getByText('Next step missing',{exact:true}).count(),0);
 await card.locator('.card-open').click();
 await page.locator('#detailUpdateForm').waitFor();
 assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'');
 assert.equal(await page.locator('.deal-current-action').count(),0);
 assert.equal(await page.locator('.deal-opening-snapshot ol li').count(),3,'the legacy text does not erase item records');
 assert.doesNotMatch(await page.locator('#recordPanel').textContent(),/Next step pending|Nothing needs you/i);
});


test('a recorded close date keeps an imported deal in history without open-board controls',async t=>{
 const {page,errors}=await open(t,1280,{showDetail:false,closedOn:'2026-10-01'});
 assert.equal(await page.locator('.kanban-column [data-id="d14"]').count(),0);
 await page.getByRole('button',{name:'List',exact:true}).click();
 assert.equal(await page.locator('#kanban [data-id="d14"]').count(),0);
 await page.getByRole('button',{name:'Closed deals',exact:true}).click();
 await page.locator('#closedDealsList [data-open-deal="d14"]').click();
 await page.locator('#detailUpdateForm').waitFor();
 assert.equal(await page.locator('#detailPhase,#detailOwner,#detailParkForm').count(),0);
 assert.deepEqual(errors,[]);
});

test('card omits outlook, Dates and Full record sections',async t=>{
 const {page}=await open(t);
 assert.equal(await page.locator('.full-record,.deal-dates,[data-jev-deal]').count(),0);
 assert.doesNotMatch(await page.locator('#recordPanel').textContent(),/System note|Deal outlook|Full record/);
});

test('deal card cleanup shows dates and one summary at 390/1280 in dark/light',async t=>{
 const dir=new URL('out/test-artifacts/deal-card-cleanup/',root);await mkdir(dir,{recursive:true});
 for(const width of [390,1280])for(const theme of ['dark','light'])await t.test(`${width}-${theme}`,async t=>{
  const {page,errors}=await open(t,width,{theme,nextStep:'Confirm the appointment and review the lease draft'});
  assert.equal(await page.locator('.deal-opening-snapshot ol button').first().textContent(),'Vendor Introductions');
  assert.equal(await page.locator('.deal-current-action strong').textContent(),'Confirm the appointment and review the lease draft');
  assert.equal(await page.locator('.updates-overview').count(),1);
  assert.equal(await page.locator('.deal-note:visible').count(),0);
  assert.match(await page.locator('.updates-overview').textContent(),/Newest demo update/);
  assert.doesNotMatch(await page.locator('.updates-overview').textContent(),/Older demo update/);
  assert.equal(await page.locator('.phase-rail time:visible').count(),4);
  assert.equal(await page.locator('.phase-rail time[datetime="2026-08-31"]').textContent(),'Aug 31, 2026');
  assert.equal(await page.locator('.full-record,.deal-dates,[data-jev-deal]').count(),0);
  assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
  await page.screenshot({path:new URL(`${width}-${theme}.png`,dir).pathname,animations:'disabled'});
  await page.locator('.updates-overview').scrollIntoViewIfNeeded();
  const title=await page.locator('#panelTitle').boundingBox(),doc=await page.locator('#recordPanel > #docPresence').boundingBox();
  assert.ok(title.x>=doc.x+doc.width,'the scrolled title clears Doc');
  await page.screenshot({path:new URL(`${width}-${theme}-summary.png`,dir).pathname,animations:'disabled'});
  await page.locator('.updates-history > summary').click();
  assert.equal(await page.locator('.deal-note:visible').count()>1,true);
  await page.locator('.updates-history').scrollIntoViewIfNeeded();
  await page.screenshot({path:new URL(`${width}-${theme}-history.png`,dir).pathname,animations:'disabled'});
  assert.deepEqual(errors,[]);
 });
});

test('refresh removes and restores Updates as recorded notes change',async t=>{
 const {page}=await open(t);
 assert.equal(await page.locator('.deal-updates').count(),1);
 await page.getByLabel('Update',{exact:true}).fill('Demo unsaved draft');
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;
  state.client.getDeal=async id=>{
   const detail=await read(id);
   return {...detail,thread:[],activities:[]};
  };
 });
 await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.panelDetail.thread.length===0);
 assert.equal(await page.locator('.deal-updates').count(),0);
 assert.doesNotMatch(await page.locator('#recordPanel').textContent(),/No updates recorded/);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const read=state.client.getDeal;
  state.client.getDeal=async id=>({...await read(id),thread:[{id:'demo-restored',kind:'note',actor:'joe',text:'Demo restored update',at:'2026-10-02'}]});
 });
 await page.getByRole('button',{name:'Refresh deal',exact:true}).click();
 await page.locator('.deal-note[data-id="demo-restored"]').waitFor({state:'attached'});
 assert.equal(await page.locator('.deal-updates').count(),1);
 assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'Demo unsaved draft');
});


test('thirty notes show one concise summary and expand inline at phone width',async t=>{
 const {page}=await open(t,390,{manyUpdates:true});
 const overview=page.locator('.updates-overview p');
 assert.ok((await overview.textContent()).length<=180);
 assert.match(await overview.textContent(),/Demo update 29/);
 assert.doesNotMatch(await overview.textContent(),/Demo update 28/);
 const box=await overview.evaluate(n=>({height:n.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(n).lineHeight),overflow:getComputedStyle(n).overflowY}));
 assert.ok(box.height<=box.lineHeight*2+1,JSON.stringify(box));
 assert.equal(box.overflow,'visible');
 assert.equal(await page.locator('.deal-note:visible').count(),0);
 await page.locator('.updates-history > summary').click();
 assert.equal(await page.locator('.deal-note[data-id^="demo-note-"]:visible').count(),30);
 assert.equal(await page.locator('.deal-note:visible').count(),32);
 assert.equal(await page.locator('.updates-history').evaluate(n=>getComputedStyle(n).overflowY),'visible');
});

test('deal card controls meet the 44px target floor at phone and desktop widths',async t=>{
 for(const width of [390,1280])for(const theme of ['dark','light'])await t.test(`${width}-${theme}`,async t=>{
  const {page}=await open(t,width,{theme});
  const undersized=[];
  for(const expanded of [false,true]){
   if(expanded){
    await page.locator('.park-options > summary').click();
    await page.locator('.updates-history > summary').click();
   }
   await animationsSettled(page);
   const controls=await page.locator('#recordPanel :is(button,a,input,select,textarea,summary,[role="button"]):visible').evaluateAll(nodes=>nodes.map(n=>{
    const {width,height}=n.getBoundingClientRect();
    return {control:n.id||n.getAttribute('aria-label')||n.getAttribute('name')||n.textContent.trim().slice(0,60),width,height};
   }));
   assert.ok(controls.length>0,'card exercises its controls');
   undersized.push(...controls.filter(n=>n.width<44||n.height<44));
  }
  assert.deepEqual(undersized,[]);
 });
});

test('phone phase dates and secondary timeline text stay readable at 13px',async t=>{
 const {page}=await open(t,390);
 const sizes=await page.locator('.phase-rail :is(time,small)').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,size:parseFloat(getComputedStyle(n).fontSize)})));
 assert.ok(sizes.length>=4,'recorded phase dates are present');
 assert.deepEqual(sizes.filter(n=>n.size<13),[]);
});

test('readable phone phase labels stay inside their rail columns',async t=>{
 const {page}=await open(t,390);
 const overflow=await page.locator('.phase-rail li > span').evaluateAll(nodes=>nodes.flatMap(n=>{
  const box=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);
  return [...range.getClientRects()].filter(line=>line.right>box.right+1).map(()=>n.textContent);
 }));
 assert.deepEqual(overflow,[]);
});

for (const width of [390,1280]) test(`board cards show the full practice name without clipping at ${width}px`,async t=>{
 const {page}=await open(t,width,{showDetail:false,denseBoard:true});
 const title=page.locator('[data-id="demo-dense-0"] .card-open');
 assert.equal(await title.textContent(),'Demo multidisciplinary healthcare practice with a deliberately long full name number 0');
 const visible=await title.evaluate(button=>{
  const range=document.createRange();range.selectNodeContents(button);
  const bounds=button.closest('h4').getBoundingClientRect();
  return [...range.getClientRects()].every(rect=>rect.bottom<=bounds.bottom+1&&rect.right<=bounds.right+1);
 });
 assert.equal(visible,true,'every line of the full name is visible');
});

for (const width of [390,1280]) for (const theme of ['light','dark']) test(`100-card stage keeps its heading and collapse preview at ${width}px in ${theme}`,async t=>{
 const {page,errors}=await open(t,width,{theme,showDetail:false,denseBoard:true});
 await mkdir(new URL('out/test-artifacts/d02-stages/',root),{recursive:true});
 const capture=state=>page.screenshot({path:new URL(`out/test-artifacts/d02-stages/${width}-${theme}-${state}.png`,root).pathname,animations:'disabled'});
 const lane=page.locator('[data-column="research"]');
 const heading=lane.locator('h3');
 assert.equal(await heading.locator('small').textContent(),'100');
 await lane.scrollIntoViewIfNeeded();
 await page.locator('#kanban').evaluate(board=>{board.scrollTop=4500;});
 assert.ok(await page.locator('#kanban').evaluate(board=>board.scrollTop)>=1000,'the populated board scrolls');
 assert.equal(await heading.evaluate(h=>{
  const r=h.getBoundingClientRect(),board=document.querySelector('#kanban').getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+10,r.top+r.height/2);
  return r.top>=board.top-1&&r.bottom<=innerHeight&&h.contains(hit);
 }),true,'the stage heading remains visible above scrolled cards');
 await capture('scrolled');
 const collapse=lane.getByRole('button',{name:'Collapse Research',exact:true});
 await collapse.focus();await page.keyboard.press('Enter');
 assert.equal(await lane.locator('.kanban-card:visible').count(),0);
 assert.equal(await lane.getByRole('button',{name:'Expand Research',exact:true}).getAttribute('aria-expanded'),'false');
 assert.match(await lane.locator('.stage-preview').textContent(),/Demo multidisciplinary healthcare practice/);
 assert.match(await lane.locator('.stage-preview').textContent(),/98 more/);
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Expand Research');
 assert.equal(await heading.evaluate(h=>{
  const r=h.getBoundingClientRect(),board=document.querySelector('#kanban').getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+10,r.top+r.height/2);
  return r.top>=board.top-1&&r.bottom<=innerHeight&&h.contains(hit);
 }),true,'collapse keeps its focused heading in view');
 await capture('collapsed');
 await page.locator('#listView').click();await page.locator('#boardView').click();
 await lane.getByRole('button',{name:'Expand Research',exact:true}).click();
 assert.equal(await lane.locator('.kanban-card').count(),100);
 await mkdir(new URL('out/test-artifacts/d02-stages/',root),{recursive:true});
 await page.screenshot({path:new URL(`out/test-artifacts/d02-stages/${width}-${theme}.png`,root).pathname,animations:'disabled'});
 assert.deepEqual(errors,[]);
});
