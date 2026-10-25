import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
import {dealHref} from '../js/home-dashboard-model.js';
const root=new URL('../',import.meta.url);
// A touch tablet: the iPad Mini portrait profile.
const ipad={viewport:{width:768,height:1024},deviceScaleFactor:2,isMobile:true,hasTouch:true};
async function open(t,{width=1440,device,link=false,reducedMotion='no-preference',fixtureDelayMs=0}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({...(device?ipad:{viewport:{width,height:960}}),reducedMotion});
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
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const get=state.client.getDeal;
  window.timelineProbe={reads:0,fail:false,changed:false};
  state.client.getDeal=async (...args)=>{
   window.timelineProbe.reads++;if(window.timelineProbe.fail)throw new Error('Synthetic unavailable');
   const detail=await get(...args);if(args[0]!=='d14')return detail;
   return {...detail,deal:{...detail.deal,phase:'Legal',phase_started_on:{research:'2026-09-20',legal:'2026-10-03'}},lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3'},
    history:[{id:'p1',field:'phase',new_value:'research',recorded_at:'2026-09-20T12:00:00Z'},{id:'p2',field:'phase',new_value:'legal',recorded_at:'2026-10-03T12:00:00Z'}],
    critical_dates:[...detail.critical_dates.filter(d=>d.kind),{id:'loi',kind:'loi_expiry',due_on:window.timelineProbe.changed?'2026-10-09':'2026-10-05',source:'Demo contract',note:'Demo LOI clause 2'}],
    activities:[{id:'mail',kind:'email',summary:window.timelineProbe.changed?'Demo updated allowance received':'Demo revised allowance received',detail:'Original synthetic email. '+ 'Clause text. '.repeat(30),occurred_at:'2026-10-02T12:00:00Z'},
     {id:'call',kind:'call',summary:'Demo lease terms discussed',detail:'Original synthetic call entry',occurred_at:'2026-10-01T12:00:00Z'},
     {id:'calendar',kind:'meeting',summary:'Demo premises appointment',detail:'Original synthetic calendar entry',source:'Demo calendar',occurred_at:'2026-10-03T12:00:00Z'},
     {id:'old',kind:'note',summary:'Demo historic entry',detail:'Original old entry',occurred_at:'2020-01-01T12:00:00Z'}],
    documents:[{id:'doc',prepared_at:'2026-10-03T12:00:00Z',note:'Demo revised lease entry. '+ 'Original document entry. '.repeat(20)}]};
  };
 });
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
 await page.evaluate(()=>window.timelineProbe.changed=true);await page.clock.fastForward(16000);
 await page.waitForFunction(()=>document.querySelector('.deal-updates').textContent.includes('Demo updated allowance received'));
 assert.equal(await page.locator('.deal-note[data-id="mail"] details').evaluate(e=>e.open),true);
 assert.equal(await summary.evaluate(e=>document.activeElement===e),true);
 await page.locator('#detailUpdateForm textarea').fill('Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=true);await page.clock.fastForward(16000);
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();
 assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(),'Demo unsaved update');
 await page.evaluate(()=>window.timelineProbe.fail=false);await page.clock.fastForward(16000);
 await page.waitForFunction(()=>!document.querySelector('#detailReadStatus').textContent);
 assert.deepEqual(errors,[]);
});

test('W9 board/list use the same addressable popup and Home href opens it directly',async t=>{
 const {page,errors}=await open(t,{link:true});
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 await page.getByLabel('Close deal',{exact:true}).click();
 assert.equal(new URL(page.url()).searchParams.has('deal'),false);
 await page.locator('#listView').click();await page.locator('.deal-row[data-id="d14"] .card-open').click();
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.open),true);
 await page.getByLabel('Close deal',{exact:true}).click();
 await page.locator('#homeDealFlag').click();
 await page.locator('#recordPanel[open] #detailUpdateForm').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 assert.equal(await page.locator('#recordPanel[open]').count(),1);
 assert.deepEqual(errors,[]);
});




for (const theme of ['light','dark']) test(`phone phase labels are legible along a dated rail in ${theme}`,async t=>{
 const {page,errors}=await open(t,{width:390,reducedMotion:'reduce'});
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
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
