import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import { componentDocument, chromium, waitForAsync } from './browser-harness.mjs';
import {dealHref} from '../js/home-dashboard-model.js';
const root=new URL('../',import.meta.url);
// A touch tablet: the iPad Mini portrait profile.
const ipad={viewport:{width:768,height:1024},deviceScaleFactor:2,isMobile:true,hasTouch:true};
async function open(t,{width=1440,height=960,touch,device,link=false,reducedMotion='no-preference',fixtureDelayMs=0,noteOrder=false}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({...(device?ipad:{viewport:{width,height},...(touch === undefined ? {} : {hasTouch:touch,isMobile:touch})}),reducedMotion});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-04T17:00:00Z')});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(['/api/system-work/session','/auth/session'].includes(url.pathname))return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-only'})});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({contentType:'application/json',body:'{}'});
  if(url.pathname==='/data/board-seed.json' && fixtureDelayMs)await new Promise(resolve=>setTimeout(resolve,fixtureDelayMs));
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try {return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://localhost/deals');
 await waitForAsync(page, async()=> (await import('/js/pipeline.js')).state.deals.size>0);
 await page.evaluate(async noteOrder=>{
  const {state}=await import('/js/pipeline.js');const get=state.client.getDeal;
  window.timelineProbe={reads:0,fail:false,changed:false};
  state.client.getDeal=async (...args)=>{
   window.timelineProbe.reads++;if(window.timelineProbe.fail)throw new Error('Synthetic unavailable');
   const detail=await get(...args);if(args[0]!=='d14')return detail;
   if(noteOrder) return {...detail,activities:[],thread:[
    {id:'undated',kind:'note',actor:'joe',text:'Synthetic undated update'},
    {id:'earlier',kind:'note',actor:'dell',at:'2026-10-01T12:00:00.000001Z',text:'Synthetic earlier update'},
    {id:'latest',kind:'note',actor:'joe',at:'2026-10-01T07:00:00.000002-05:00',text:'Synthetic latest update. Landlord accepted the revised terms.'},
   ]};
   return {...detail,deal:{...detail.deal,phase:'Legal',phase_started_on:{research:'2026-09-20',legal:'2026-10-03'}},lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3'},
    history:[{id:'p1',field:'phase',new_value:'research',recorded_at:'2026-09-20T12:00:00Z'},{id:'p2',field:'phase',new_value:'legal',recorded_at:'2026-10-03T12:00:00Z'}],
    critical_dates:[...detail.critical_dates.filter(d=>d.kind),{id:'loi',kind:'loi_expiry',due_on:window.timelineProbe.changed?'2026-10-09':'2026-10-05',source:'Demo contract',note:'Demo LOI clause 2'}],
    activities:[{id:'mail',kind:'email',summary:window.timelineProbe.changed?'Demo updated allowance received':'Demo revised allowance received',detail:'Original synthetic email. '+ 'Clause text. '.repeat(30),occurred_at:'2026-10-02T12:00:00Z'},
     {id:'call',kind:'call',summary:'Demo lease terms discussed',detail:'Original synthetic call entry',occurred_at:'2026-10-01T12:00:00Z'},
     {id:'calendar',kind:'meeting',summary:'Demo premises appointment',detail:'Original synthetic calendar entry',source:'Demo calendar',occurred_at:'2026-10-03T12:00:00Z'},
     {id:'old',kind:'note',summary:'Demo historic entry',detail:'Original old entry',occurred_at:'2020-01-01T12:00:00Z'}],
    documents:[{id:'doc',prepared_at:'2026-10-03T12:00:00Z',note:'Demo revised lease entry. '+ 'Original document entry. '.repeat(20)}]};
  };
 },noteOrder);
 if(link) {
  // Follow the same exact href the Home flags and shared sidebar use.
  await page.evaluate(href=>{const a=document.createElement('a');a.href=href;a.id='homeDealFlag';a.textContent='Demo deal';document.body.append(a);},dealHref('d14'));
  // Navigation is checked in a second page below; keep this instrumented client.
  assert.equal(await page.locator('#homeDealFlag').getAttribute('href'),'/deals?deal=d14');
 }
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();await page.locator('#detailUpdateForm').waitFor();
 return {page,errors};
}

for(const width of [320,390,1280]) for(const theme of ['light','dark']) test(`unified phase timeline and full-width updates at ${width} ${theme}`,async t=>{
 const {page,errors}=await open(t,{width,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 assert.equal(await page.locator('.phase-rail').count(),1);
 assert.equal(await page.locator('.timeline-chart').count(),0);
 assert.equal(await page.locator('.phase-rail [aria-current] time').textContent(),'Oct 3, 2026');
 assert.equal(await page.locator('.deal-note[data-id="mail"]').count(),1);
 await page.locator('.updates-history > summary').click();
 await page.locator('.deal-note[data-id="mail"] summary').click();
 assert.match(await page.locator('.deal-note[data-id="mail"] .note-original').textContent(),/Original synthetic email/);
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
 assert.deepEqual(errors,[]);
});
test('refresh preserves expanded updates, focus, dates and draft through an outage',async t=>{
 const {page,errors}=await open(t);
 await page.locator('.updates-history > summary').click();
 const summary=page.locator('.deal-note[data-id="mail"] summary');await summary.click();await summary.focus();
 await page.evaluate(()=>window.timelineProbe.changed=true);await page.clock.fastForward(61_000);
 await page.waitForFunction(()=>document.querySelector('.deal-updates').textContent.includes('Demo updated allowance received'));
 assert.equal(await page.locator('.deal-note[data-id="mail"] details').evaluate(e=>e.open),true);
 assert.equal(await summary.evaluate(e=>document.activeElement===e),true);
 await page.locator('#dealUpdate').fill('Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=true);await page.clock.fastForward(61_000);
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();
 assert.equal(await page.locator('#dealUpdate').inputValue(),'Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=false);await page.clock.fastForward(61_000);
 await page.waitForFunction(()=>!document.querySelector('#detailReadStatus').textContent);
 assert.deepEqual(errors,[]);
});

test('W9 board/list use the same addressable popup and Home href opens it directly',async t=>{
 const {page,errors}=await open(t,{link:true});
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
 assert.equal(new URL(page.url()).searchParams.has('deal'),false);
 await page.locator('#listView').click();await page.locator('.deal-row[data-id="d14"] .card-open').click();
 assert.equal(await page.locator('#recordPanel').evaluate(e => !e.hidden),true);
 await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
 await page.locator('#homeDealFlag').click();
 await page.locator('#recordPanel:not([hidden]) #detailUpdateForm').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 assert.equal(await page.locator('#recordPanel:not([hidden])').count(),1);
 assert.deepEqual(errors,[]);
});




for (const theme of ['light','dark']) test(`phone phase labels are legible along a dated rail in ${theme}`,async t=>{
 const {page,errors}=await open(t,{width:390,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.getByRole('tab',{name:'Activity',exact:true}).click();
 const labels=await page.locator('.phase-rail li').evaluateAll(items=>items.map(item=>{
  const labels=[...item.querySelectorAll('span,abbr')].filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return s.display!=='none' && s.clipPath==='none' && r.width>=16 && r.height>=12 && parseFloat(s.fontSize)>=12;});
  return {top:item.getBoundingClientRect().top,labels:labels.map(n=>n.textContent)};
 }));
 assert.equal(labels.length,8);
 assert.ok(labels.every(p=>p.labels.length>0),JSON.stringify(labels));
 assert.equal(new Set(labels.map(p=>p.top)).size,2,'dates stay visible in two rows');
 assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.deepEqual(errors,[]);
});

for(const width of [1440,390]) for(const theme of ['light','dark']) test(`newest update preview and recorded history at ${width} ${theme}`, async t=>{
 const {page,errors}=await open(t,{width,noteOrder:true,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 assert.match(await page.locator('.updates-history > summary').textContent(), /3 updates.*Oct 1, 2026.*Synthetic latest update/);
 assert.equal(await page.locator('.updates-overview').count(), 0);
 assert.equal(await page.locator('.updates-history').evaluate(e=>e.open), false);
 await mkdir('out/test-artifacts/newest-updates',{recursive:true});
 await page.locator('.deal-updates').scrollIntoViewIfNeeded();
 await page.screenshot({path:`out/test-artifacts/newest-updates/preview-${width}-${theme}.png`});
 await page.locator('.updates-history > summary').click();
 assert.deepEqual(await page.locator('.deal-note').evaluateAll(rows=>rows.map(row=>row.dataset.id)),['latest','earlier','undated']);
 assert.equal(await page.locator('.deal-note').last().locator('time').textContent(),'Date not recorded');
 assert.equal(await page.locator('#recordPanel').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('.deal-updates').screenshot({path:`out/test-artifacts/newest-updates/history-${width}-${theme}.png`});
 assert.deepEqual(errors,[]);
});

test('update form offers the current next action and date at phone width', async t => {
 const {page}=await open(t,{width:390});
 const deal=await page.evaluate(async()=> (await (await import('/js/pipeline.js')).state.client.getDeal('d14')).deal);
 const form=page.locator('#detailUpdateForm');
 const editor=form.getByText('Change next step',{exact:true});
 assert.equal(await form.getByLabel('Next step').isVisible(),false);
 await form.getByLabel('Update').focus();
 await page.keyboard.press('Tab');
 assert.equal(await editor.evaluate(e=>e===document.activeElement),true);
 await page.keyboard.press('Enter');
 assert.equal(await form.getByLabel('Next step').inputValue(), typeof deal.next_step === 'object' ? deal.next_step?.text || '' : deal.next_step || '');
 assert.equal(await form.getByLabel('Next date').inputValue(),deal.next_date || '');
 for (const field of [form.getByLabel('Update'),editor,form.getByLabel('Next step'),form.getByLabel('Next date'),form.getByRole('button',{name:'Add update'})]) {
  assert.ok((await field.boundingBox()).height >= 44);
 }
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
 for (const label of ['Next step','Next date']) {
  await page.keyboard.press('Tab');
  assert.equal(await form.getByLabel(label).evaluate(e=>e===document.activeElement),true);
 }
 for (let i=0; i<4 && !await form.getByRole('button',{name:'Add update'}).evaluate(e=>e===document.activeElement); i++) await page.keyboard.press('Tab');
 assert.equal(await form.getByRole('button',{name:'Add update'}).evaluate(e=>e===document.activeElement),true);
});

for (const timezoneId of ['UTC','America/Chicago','America/Los_Angeles','Asia/Tokyo']) test(`Central deadline browser boundaries in ${timezoneId}`, async t => {
 const { ownedFixtureServer: fixtureServer } = await import("./fixture-probe.ts");
 const {exercise}=await import('../scripts/prove-deal-deadline-central-day.mjs');
 const fixture=await fixtureServer();t.after(()=>fixture.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({timezoneId});
 await page.clock.setFixedTime(new Date('2026-11-06T02:00:00Z'));
 await componentDocument(page, fixture.origin, {owner:'deadline date boundaries'});
 const assertions=await exercise(page,`${fixture.origin}/js/deal-timeline.js`);
 assert.equal(assertions.length,83);
 assert.ok(assertions.every(result=>result.passed));
});

const planPhase={phase:'legal',from_on:'2026-10-03',to_on:null,expected_from_on:null,expected_to_on:'2026-11-05'};
const planRows=[
 {id:'review',kind:'todo',phase:'legal',label:'Review the lease',state:'current',day:2,typical_days:7,from_on:'2026-10-03',expected_to_on:'2026-10-10'},
 {id:'sign',kind:'todo',phase:'legal',label:'Sign the lease',state:'expected',typical_days:7,expected_from_on:'2026-10-10',expected_to_on:'2026-10-17'},
 {id:'step:sample',kind:'step',phase:'legal',owner:'dell',state:'open',from_on:'2026-10-04',to_on:'2026-10-07',done_on:null,label:'Call about the lease',change_id:12},
];
const plan={phases:[planPhase],rows:planRows,arrows:[{from:'review',to:'sign',at_risk:false}],expected_signing_on:'2026-10-17',stale:null,own_dates:{},base_version:0};
async function showPlan(page) {
 await page.evaluate(async plan=>{
  const {state}=await import('/js/pipeline.js');
  const get=state.client.getDeal.bind(state.client);
  state.client.getDeal=async (...args)=>({...await get(...args),plan,next_actions:[{id:'sample',description:'Call about the lease',change_id:12}]});
 },plan);
 await page.getByRole('button',{name:'Back to deals',exact:true}).click();
 await page.locator('.kanban-card[data-id="d14"] .card-open').click();
 await page.getByRole('button',{name:'Lease signing expected Oct 17'}).click({timeout:3000});
 return page.getByRole('tabpanel',{name:'Plan'});
}

for(const [width,height,touch] of [[1280,640,false],[1440,900,false],[390,844,true]]) {
 test(`Plan keeps the chart on screen at ${width} × ${height}`,async t=>{
  const {page,errors}=await open(t,{width,height,touch});
  const tab=await showPlan(page);
  await tab.getByRole('button',{name:'Sign the lease',exact:true}).first().waitFor();
  if(touch) {
   await tab.getByRole('button',{name:'Sign the lease',exact:true}).first().tap();
   await tab.getByRole('region',{name:'Sign the lease'}).waitFor();
   assert.equal(await tab.getByRole('button',{name:/Change date for/}).count(),0);
   assert.equal(await tab.locator('.timeline-scroll').evaluate(node=>node.scrollWidth>node.clientWidth),true);
  } else {
   await tab.getByRole('button',{name:'Recorded only'}).click();
   assert.equal(await tab.getByRole('button',{name:/Sign the lease/}).count(),0);
   assert.equal(await tab.getByRole('button',{name:/Review the lease/}).count()>0,true);
   await tab.getByRole('button',{name:'Recorded only'}).click();
  }
  await mkdir(new URL('out/test-artifacts/',root),{recursive:true});
  await page.screenshot({path:new URL(`out/test-artifacts/deal-plan-${width}.png`,root).pathname});
  const box=await tab.locator('.timeline').boundingBox();
  assert.ok(box.y+box.height <= height);
  assert.deepEqual(errors,[]);
 });
}

for(const [width,height,touch] of [[1280,640,false],[1440,900,false],[390,844,true]]) test(`Deals Timeline expands one row per open deal at ${width} × ${height}`,async t=>{
 const {page}=await open(t,{width,height,touch});
 await page.evaluate(async ({planPhase,planRows})=>{
  const {state}=await import('/js/pipeline.js');
  const get=state.client.getBoard.bind(state.client);
  const timeline={phase_spans:[planPhase],rows:planRows,arrows:[],dates:[],at_risk_count:0,expected_signing_on:'2026-10-17',stale:null};
  state.client.getBoard=async (...args)=>{
    const board=await get(...args);
    const rows=board.deals.filter(row=>row.id==='d14').map(row=>({...row,name:'Example active deal',short_name:'Example active deal',owner:'dell',timeline}));
    const more=Array.from({length:23},(_,index)=>({...rows[0],id:`sample-${index}`,name:`Example timeline deal ${index+1}`,short_name:null,owner:index%2?'joe':'dell'}));
    return {...board,board_from_engine:true,deals:[...rows,...more]};
  };
 },{planPhase,planRows});
 await page.getByRole('button',{name:'Back to deals',exact:true}).click();
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByRole('button',{name:'Timeline',exact:true}).click();
 const chart=page.locator('#boardTimeline');
 assert.equal(await chart.getByRole('link',{name:'Example active deal',exact:true}).count(),1);
 assert.equal(await chart.locator('[data-group]').count(),24);
 assert.equal(await chart.locator('.timeline-scroll').evaluate(node=>node.scrollWidth>node.clientWidth),true);
 assert.equal(await chart.getByRole('button',{name:'Sign the lease',exact:true}).count(),0);
 await chart.getByRole('button',{name:'Show rows for Example active deal'}).click();
 await chart.getByRole('button',{name:'Sign the lease',exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Month',exact:true}).click();
 assert.equal(await chart.locator('.timeline').getAttribute('data-day-width'),'4');
 await mkdir(new URL('out/test-artifacts/',root),{recursive:true});
 await page.screenshot({path:new URL(`out/test-artifacts/deals-timeline-${width}.png`,root).pathname});
});
