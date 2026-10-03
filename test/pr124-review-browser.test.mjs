import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const phases = ['On Deck', 'Research', 'Site selection', 'Negotiation', 'Legal', 'Diligence', 'Closing', 'Closed'];
async function open(t, { width = 1440, reducedMotion = 'no-preference', many = false, query = '' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const seed = JSON.parse(await readFile(new URL('data/board-seed.json', root), 'utf8'));
  seed.deals.forEach((d, i) => Object.assign(d, { phase: phases[i % 8], next_step: 'Confirm the next appointment', last_touch: '2026-10-01', last_review_at: '2026-10-01T16:00:00Z', next_date: null, attention: false }));
  seed.deals.find(d => d.id === 'd14').phase = 'Negotiation';
  Object.assign(seed.deals.find(d => d.id === 'd14'), {owner:'joe',attention:true});
  Object.assign(seed.deals.find(d => d.id === 'd20'), {owner:'dell',attention:true});
  seed.deals.find(d => d.id === 'd20').phase = 'Closed';
  seed.deals.find(d => d.id === 'd23').invoiced_on = '2026-10-01';
  seed.seed_events = [{ id: 'auto-loi', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd14', field: 'phase', old_value: 'Research', new_value: 'Negotiation', automatic: true, change_reason: 'LOI sent', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' },
    { id: 'auto-invoice', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd20', field: 'phase', old_value: 'Closing', new_value: 'Closed', automatic: true, change_reason: 'invoice', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z' }];
  seed.threads.d14 = [{ id: 'demo-note', kind: 'note', actor: 'joe', at: '2026-10-01', text: 'LOI submitted. ' + 'Full original demo entry. '.repeat(30) }];
  if (many) for (let i = 20; i < 72; i++) seed.deals.push({ ...seed.deals[9], id: 'demo-' + i, name: 'Demo Assignment ' + i, phase: 'Research' });
  await page.clock.install({ time: new Date('2026-10-04T17:00:00Z') });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/data/board-seed.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(seed) });
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe' }, csrf_token: 'synthetic-only' }) });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals' + query);
  await page.waitForFunction(async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return { page, errors };
}
const refresh = page => page.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.refreshBoard({ reason: 'test' }));


async function detail(page) {
 await page.locator('.kanban-column [data-id="d14"]').click();
 await page.waitForSelector('#detailNextForm');
}
async function readPanel(page) {
 await page.evaluate(() => dispatchEvent(new Event('online')));
 await page.waitForTimeout(30);
}

// Exercise refusal through the live HTTP adapter, with synthetic authorized data.
async function liveDetailRead(page) {
 const wire = await page.evaluate(async () => {
   const {state}=await import('/js/pipeline.js');
   const detail=await state.client.getDeal('d14');
   return {...detail.deal,deal_id:'d14',thread:detail.thread,critical_dates:[],events:[]};
 });
 const reads={status:200,delayed:null,delayNext:false};
 await page.route('**/mcp',async route=>{
   const request=route.request().postDataJSON();
   assert.equal(request.params.name,'get-deal-room');
   const status=reads.status;
   if(reads.delayNext) {
     reads.delayNext=false;
     await new Promise(resolve=>{reads.delayed=resolve;});
   }
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify({
     jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify(wire)}]},
   })});
 });
 await page.evaluate(async()=>{
   const {state}=await import('/js/pipeline.js');
   const {createLiveClient}=await import('/js/live-client.js');
   window.beforeLiveDetail=state.panelDetail;
   state.client.getDeal=createLiveClient().getDeal;
 });
 await readPanel(page);
 await page.waitForFunction(async()=>{
   const {state}=await import('/js/pipeline.js');
   return state.panelDetail!==window.beforeLiveDetail&&state.panelDetail?.deal.id==='d14';
 });
 return reads;
}

for(const status of [401,403]) test('PR129 R1 loaded detail clears protected state on HTTP '+status,async t=>{
 const {page,errors}=await open(t);await detail(page);
 const reads=await liveDetailRead(page);
 await page.locator('#detailNextForm textarea').fill('Private unsaved draft');
 await page.locator('#panelContextOpen').click();
 await page.waitForFunction(()=>document.querySelector('#contextDrawer').open);
 reads.status=status;
 await page.clock.fastForward(15000);
 await page.waitForFunction(()=>!document.querySelector('#panelBody .detail-grid'));
 assert.equal(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.panelDetail),null);
 assert.equal(await page.locator('#panelTitle').textContent(),'Deal');
 assert.match(await page.locator('#panelBody').textContent(),/Unavailable/);
 assert.equal(await page.locator('#panelBody input, #panelBody textarea, #panelBody select').count(),0);
 assert.equal(await page.locator('#contextDrawer').evaluate(e=>e.open),false);
 assert.equal(await page.locator('#contextDrawerBody').textContent(),'');
 assert.equal(await page.locator('#panelContextOpenWrap').isVisible(),false);
 reads.status=200;
 await page.locator('[data-retry-detail]').click();
 await page.waitForSelector('#detailNextForm');
 assert.equal(await page.locator('#detailNextForm textarea').inputValue(),'Confirm the next appointment');
 assert.deepEqual(errors,[]);
});

test('PR129 R1 an older successful detail read cannot repopulate refused detail',async t=>{
 const {page,errors}=await open(t);await detail(page);
 const reads=await liveDetailRead(page);
 reads.delayNext=true;await readPanel(page);
 assert.equal(typeof reads.delayed,'function');
 reads.status=401;await readPanel(page);
 assert.match(await page.locator('#panelBody').textContent(),/Unavailable/);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/mcp'&&r.status()===200);
 reads.delayed();await response;await page.waitForTimeout(30);
 assert.equal(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.panelDetail),null);
 assert.equal(await page.locator('#detailNextForm').count(),0);
 assert.deepEqual(errors,[]);
});

test('PR129 R1 refused next-step revalidation clears detail without sending the draft',async t=>{
 const {page,errors}=await open(t);await detail(page);
 const reads=await liveDetailRead(page);
 await page.locator('#detailNextForm textarea').fill('Private unsaved draft');
 await page.evaluate(async()=>{
   const {state}=await import('/js/pipeline.js');window.nextSends=0;
   state.client.setNextStep=async()=>{window.nextSends++;return {ok:true};};
 });
 reads.status=403;await page.locator('#detailNextForm button').click();
 await page.waitForFunction(()=>!document.querySelector('#panelBody .detail-grid'));
 assert.equal(await page.evaluate(()=>window.nextSends),0);
 assert.equal(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.panelDetail),null);
 assert.match(await page.locator('#panelBody').textContent(),/Unavailable/);
 assert.deepEqual(errors,[]);
});

test('PR129 R1 a context read survives an authorized detail poll but not a refusal/reopen',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
   const {state}=await import('/js/pipeline.js');
   const read=state.client.getDeal.bind(state.client);
   state.client.getDeal=async id=>{const detail=await read(id);detail.deal.account_client_id='synthetic-client';return detail;};
   window.contextReads=[];
   state.client.getPartyRecord=()=>new Promise(resolve=>contextReads.push(resolve));
 });
 await detail(page);const reads=await liveDetailRead(page);
 await page.locator('#panelContextOpen').click();
 await page.waitForFunction(()=>contextReads.length===1);
 await page.evaluate(async()=>{window.beforeContextPoll=(await import('/js/pipeline.js')).state.panelDetail;});
 await readPanel(page);
 await page.waitForFunction(async()=>(await import('/js/pipeline.js')).state.panelDetail!==window.beforeContextPoll);
 await page.evaluate(()=>contextReads[0]({record:{name:'Authorized client'}}));
 await page.waitForFunction(()=>document.querySelector('#contextDrawerBody').textContent.includes('Authorized client'));
 await page.locator('#contextDrawerClose').click();
 await page.locator('#panelContextOpen').click();
 await page.waitForFunction(()=>contextReads.length===2);
 reads.status=401;await readPanel(page);
 await page.waitForFunction(()=>!document.querySelector('#contextDrawer').open);
 assert.equal(await page.locator('#contextDrawer').evaluate(e=>e.open),false);
 reads.status=200;await page.locator('[data-retry-detail]').click();
 await page.waitForSelector('#detailNextForm');
 await page.locator('#panelContextOpen').click();
 await page.waitForFunction(()=>contextReads.length===3);
 await page.evaluate(()=>contextReads[2]({record:{name:'Revalidated client'}}));
 await page.waitForFunction(()=>document.querySelector('#contextDrawerBody').textContent.includes('Revalidated client'));
 await page.evaluate(()=>contextReads[1]({record:{name:'Refused old client'}}));
 await page.waitForTimeout(30);
 assert.doesNotMatch(await page.locator('#contextDrawerBody').textContent(),/Refused old client/);
 assert.deepEqual(errors,[]);
});

test('R1 pristine fields follow reads; dirty draft reconciles its original read before send', async t => {
 const {page}=await open(t); await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');await state.client.setNextStep({deal:'d14',text:'New recorded step',next_date:'2026-11-01',idempotency_key:'external-1'});});
 await readPanel(page);
 assert.equal(await page.locator('#detailNextForm textarea').inputValue(),'New recorded step');
 assert.equal(await page.locator('#detailNextForm input').inputValue(),'2026-11-01');
 await page.locator('#detailNextForm textarea').fill('My draft');
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');await state.client.setNextStep({deal:'d14',text:'Partner step',next_date:'2026-12-01',idempotency_key:'external-2'});});
 await readPanel(page); await page.locator('#detailNextForm button').click();
 await page.waitForTimeout(30);
 assert.equal(await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');return (await state.client.getDeal('d14')).deal.next_step;}),'Partner step');
 assert.match(await page.locator('#detailNextStatus').textContent(),/changed/);
});

test('R1 draft approval stays bound to the comparison shown before a newer poll', async t => {
 const {page}=await open(t); await detail(page);
 await page.locator('#detailNextForm textarea').fill('My draft');
 const record = (text,key) => page.evaluate(async ({text,key}) => {
   const {state}=await import('/js/pipeline.js');
   await state.client.setNextStep({deal:'d14',text,next_date:'2026-11-01',idempotency_key:key});
 },{text,key});
 await record('First partner step','partner-1');
 await page.locator('#detailNextForm button').click();
 await page.locator('[data-next-keep]').waitFor();
 assert.match(await page.locator('#detailNextStatus').textContent(),/First partner step/);
 await record('Later partner step','partner-2'); await readPanel(page);
 // The comparison still displays the first step when the next read arrives.
 assert.match(await page.locator('#detailNextStatus').textContent(),/First partner step/);
 await page.locator('[data-next-keep]').click();
 await page.locator('#detailNextForm button').click();
 await page.waitForTimeout(30);
 assert.equal(await page.evaluate(async () => {
   const {state}=await import('/js/pipeline.js'); return (await state.client.getDeal('d14')).deal.next_step;
 }),'Later partner step');
 assert.match(await page.locator('#detailNextStatus').textContent(),/Later partner step/);
});

test('R2 unknown next step replays exact key and intent; reopened pending form remains guarded', async t=>{
 const {page}=await open(t);await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const send=state.client.setNextStep.bind(state.client);window.calls=[];state.client.setNextStep=async r=>{calls.push(r);const result=await send(r);if(calls.length===1)throw Error('lost reply');return result;};});
 await page.locator('#detailNextForm textarea').fill('Retained step');await page.locator('#detailNextForm button').click();
 await page.waitForTimeout(30);
 assert.match(await page.locator('#detailNextForm button').textContent(),/Check outcome/);
 await page.getByLabel('Close deal',{exact:true}).click();await detail(page);
 assert.equal(await page.locator('#detailNextForm textarea').isDisabled(),true);
 await page.locator('#detailNextForm button').click();await page.waitForTimeout(30);
 assert.equal(await page.evaluate(()=>calls.length),2);
 assert.deepEqual(await page.evaluate(()=>calls[0]),await page.evaluate(()=>calls[1]));
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.setNextStep=r=>new Promise(resolve=>{calls.push(r);window.finishNext=()=>resolve({ok:true});});});
 await page.locator('#detailNextForm textarea').fill('Pending step');await page.locator('#detailNextForm button').click();
 await page.getByLabel('Close deal',{exact:true}).click();await detail(page);
 assert.equal(await page.locator('#detailNextForm button').isDisabled(),true);
 await page.evaluate(()=>finishNext());
});

test('R3 superseded park reply preserves newer active state and open detail',async t=>{
 const {page}=await open(t);await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.patchDealField=async r=>{await new Promise(resolve=>window.releasePark=resolve);return {ok:true,event_id:'old-park',event_recorded_at:'2026-10-04T17:00:01Z'};};});
 await page.locator('.park-options summary').click();await page.locator('#detailParkForm input').fill('Old park');await page.locator('#detailParkForm button').click();
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.fieldBase.set('d14|operating_state',{id:'new-revive',recorded_at:'2026-10-04T17:00:02Z'});state.deals.get('d14').operating_state='active';state.boardSync.requestRefresh=()=>{};releasePark();});
 await page.waitForTimeout(30);
 assert.equal(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.deals.get('d14').operating_state),'active');
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.open),true);
 assert.doesNotMatch(await page.locator('.toast').textContent(),/^Deal parked$/);
});

test('R4 accepted unassigned owner stays null despite a later selector change',async t=>{
 const {page}=await open(t);await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.patchDealField=r=>new Promise(resolve=>window.releaseOwner=()=>resolve({ok:true,event_id:'owner-clear',event_recorded_at:'2026-10-04T17:00:01Z'}));state.boardSync.requestRefresh=()=>{};});
 await page.locator('#detailOwner').selectOption('');await page.locator('#detailOwner').selectOption('dell');await page.evaluate(()=>releaseOwner());await page.waitForTimeout(30);
 assert.equal(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.deals.get('d14').owner),null);
});

async function parkingConflict(page) {
 await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.patchDealField=async()=>({status:'conflict',conflict:{conflict_id:'synthetic-conflict',field:'operating_state',a:{actor:'joe',recorded_at:'2026-10-04T16:00:00Z',value:{state:'parked',reason:'other',note:'Awaiting landlord'}},b:{actor:'dell',recorded_at:'2026-10-04T17:00:00Z',value:{state:'active',reason:null,note:'Tour booked'}}}});});
 await page.locator('.park-options summary').click();await page.locator('#detailParkForm input').fill('Test conflict');await page.locator('#detailParkForm button').click();await page.waitForFunction(()=>document.querySelector('#conflictDialog').open);
}
test('R5 operating-state conflict renders structured choices and attribution',async t=>{
 const {page}=await open(t);await parkingConflict(page);
 const text=await page.locator('#conflictChoices').textContent();assert.match(text,/parked/);assert.match(text,/Awaiting landlord/);assert.match(text,/active/);assert.match(text,/Tour booked/);assert.match(text,/Joe/);assert.match(text,/Dell/);assert.doesNotMatch(text,/object Object/);
});
test('R6 resolution retains unknown request, reports refusal and never loses check outcome',async t=>{
 const {page,errors}=await open(t);await parkingConflict(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');window.resolutions=[];state.client.resolveConflict=async r=>{resolutions.push(r);if(resolutions.length===1)throw Error('lost response');if(resolutions.length===2){const e=Error('refused');e.payload={error:'choice_declined',hint:'Read both values again'};throw e;}return {ok:true};};});
 await page.locator('#conflictForm button[type="submit"]').click();await page.waitForTimeout(30);
 assert.equal(await page.locator('#conflictDialog').evaluate(e=>e.open),true);
 assert.match(await page.locator('#conflictStatus').textContent(),/confirmed/);
 assert.match(await page.locator('#conflictForm button[type="submit"]').textContent(),/Check outcome/);
 await page.locator('#conflictForm button[type="submit"]').click();await page.waitForTimeout(30);
 assert.deepEqual(await page.evaluate(()=>resolutions[0]),await page.evaluate(()=>resolutions[1]));
 assert.match(await page.locator('#conflictStatus').textContent(),/Read both values again/);
 await page.locator('#conflictForm button[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#conflictDialog').open);assert.deepEqual(errors,[]);
});
test('R7 detail read failures show retry/stale state and late failure cannot replace another detail',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');window.originalRead=state.client.getDeal.bind(state.client);state.client.getDeal=async()=>{throw Error('offline');};});
 await page.locator('.kanban-column [data-id="d14"]').click();await page.waitForTimeout(30);
 assert.match(await page.locator('#panelBody').textContent(),/could not be read/);
 await page.evaluate(async()=>{(await import('/js/pipeline.js')).state.client.getDeal=originalRead;});await page.locator('[data-retry-detail]').click();await page.waitForSelector('#detailNextForm');
 await page.locator('#detailNextForm textarea').fill('Draft retained through outage');
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.getDeal=async()=>({deal:null});});await readPanel(page);
 assert.match(await page.locator('#detailReadStatus').textContent(),/stale/);
 assert.equal(await page.locator('#detailNextForm textarea').inputValue(),'Draft retained through outage');
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.getDeal=id=>id==='d14'?new Promise((_,reject)=>window.failOld=()=>reject(Error('old'))):originalRead(id);dispatchEvent(new Event('online'));});
 await page.getByLabel('Close deal',{exact:true}).click();await page.locator('.kanban-column [data-id="d20"]').click();await page.waitForSelector('#detailNextForm');await page.evaluate(()=>failOld());await page.waitForTimeout(30);
 assert.doesNotMatch(await page.locator('#panelBody').textContent(),/stale|could not be read/);
});
for(const width of [1440,390]) test('R8 list Undo is visible and clickable at '+width,async t=>{
 const {page}=await open(t,{width});await page.locator('#listView').click();
 const undo=page.locator('[data-id="d14"] [data-undo]');
 const boxes=await undo.evaluate(e=>{const a=e.getBoundingClientRect(),b=e.closest('article').getBoundingClientRect();return {button:a.bottom,row:b.bottom};});assert.ok(boxes.button<=boxes.row);
 await undo.click();await page.waitForFunction(async()=>(await import('/js/pipeline.js')).state.deals.get('d14').phase==='Research');
});
test('R9 original prior step and actors survive without synthetic activity echo',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const read=state.client.getDeal.bind(state.client);state.client.getDeal=async id=>({...await read(id),activities:[],thread:[{id:'prior',kind:'archived_step',text:'Original prior step',actor:'dell',at:'2026-10-01'}]});});await detail(page);
 assert.match(await page.locator('.deal-note').textContent(),/Prior next step/);assert.match(await page.locator('.deal-note').textContent(),/Dell/);await page.locator('.deal-note summary').click();assert.equal(await page.locator('.note-original').textContent(),'Original prior step');
});
test('R10 Home flagged personal URL reaches only flagged records for current actor',async t=>{
 const {page}=await open(t,{query:'?workspace=team&filter=flagged&owner=me'});
 const observed=await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');return {filter:state.filter,scope:state.scopeFilter,expected:[...state.deals.values()].filter(d=>d.owner===state.selfActor&&d.attention&&d.operating_state!=='parked'&&d.workspace_kind!=='national_account'&&!d.account_client_id&&!d.invoiced_on).map(d=>d.id).sort(),shown:[...document.querySelectorAll('.kanban-column [data-id]')].map(e=>e.dataset.id).sort()};});
 assert.equal(observed.filter,'joe');assert.equal(observed.scope,'flagged');assert.deepEqual(observed.shown,observed.expected);
});
test('R12 full-record disclosures preserve actions, premises, rounds, documents and change history',async t=>{
 const {page}=await open(t);await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const read=state.client.getDeal.bind(state.client);state.client.getDeal=async id=>({...await read(id),next_actions:[{id:'a',status:'open',description:'Additional action',owner:'joe',due_on:'2026-11-01'}],premises:[{label:'Demo premises',address:'123 Demo Street',area_amount:2200,area_basis:'SF'}],negotiation_rounds:[{round_no:3,side:'tenant',rate_amount:28,rate_basis:'SF',term_months:60}],documents:[{sent_status:'prepared',prepared_at:'2026-10-01',lint_passed:true,leak_check_passed:false}],history:[{summary:'Demo history',actor:'dell',recorded_at:'2026-10-01'}]});});await detail(page);
 await page.getByText('Full record',{exact:true}).click();const text=await page.locator('.full-record').textContent();for(const value of ['Additional action','Joe','Demo premises','123 Demo Street','2200','Round 3','28','60 months','prepared','lint passed','leak check not confirmed','Demo history','Dell'])assert.ok(text.includes(value),value);
});

test('R2 a move follow-up cannot replace an unanswered next-step intent or its receipt',async t=>{
 const {page}=await open(t);await detail(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');window.calls=[];const send=state.client.setNextStep.bind(state.client);state.client.setNextStep=async r=>{calls.push(r);const result=await send(r);if(calls.length===1)throw Error('lost reply');return result;};});
 await page.locator('#detailNextForm textarea').fill('Original intent');await page.locator('#detailNextForm button').click();await page.waitForTimeout(30);
 await page.getByLabel('Close deal',{exact:true}).click();
 await page.locator('.kanban-column [data-id="d14"]').focus();
 await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#completionDialog').open);
 await page.locator('#completionNextStep').fill('Different move follow-up');await page.locator('#completionConfirm').click();await page.waitForFunction(()=>!document.querySelector('#completionDialog').open);
 assert.equal(await page.evaluate(()=>calls.length),1);
 await page.locator('#receiptDock [data-event="reconcile"]').click();await page.waitForTimeout(30);
 assert.deepEqual(await page.evaluate(()=>calls[0]),await page.evaluate(()=>calls[1]));
});

test('R6 command dock reconciliation settles the retained conflict and closes its chooser',async t=>{
 const {page}=await open(t);await parkingConflict(page);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');window.calls=[];state.client.resolveConflict=async r=>{calls.push(r);if(calls.length===1)throw Error('lost reply');return {ok:true};};});
 await page.locator('#conflictForm button[type="submit"]').click();await page.waitForTimeout(30);await page.locator('#conflictCancel').click();
 await page.getByLabel('Close deal',{exact:true}).click();
 await page.locator('#receiptDock [data-event="reconcile"]').click();await page.waitForTimeout(30);
 assert.match(await page.locator('.toast').textContent(),/Conflict resolved/);
 await parkingConflict(page);
 // A new conflict with this fixture id must start as a new choice after settlement.
 assert.equal(await page.locator('#conflictChoices input:disabled').count(),0);
 assert.deepEqual(await page.evaluate(()=>calls[0]),await page.evaluate(()=>calls[1]));
});
