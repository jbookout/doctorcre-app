import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
import {dealHref} from '../js/home-dashboard-model.js';
const root=new URL('../',import.meta.url);
async function open(t,{width=1440,link=false,reducedMotion='no-preference',fixtureDelayMs=0}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960},reducedMotion});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-04T17:00:00Z')});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/api/system-work/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'joe'},csrf_token:'synthetic-only'})});
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
   return {...detail,deal:{...detail.deal,phase:'Legal'},lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3'},
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
 await page.locator('.kanban-card[data-id="d14"]').click();await page.locator('#timelineRange').waitFor();
 return {page,errors};
}
test('timeline fixture waits for delayed client initialization before instrumenting reads',async t=>{
 const {page,errors}=await open(t,{fixtureDelayMs:250});
 assert.equal(await page.locator('.kanban-card[data-id="d14"]').count(),1);
 assert.equal(await page.locator('#timelineRange').isVisible(),true);
 assert.deepEqual(errors,[]);
});
test('W9 horizontal phase dates, countdowns, dated originals, wide layout and phone renders',async t=>{
 await mkdir(new URL('out/test-artifacts/w9/',root),{recursive:true});
 for(const width of [1440,390,320])await t.test(String(width),async t=>{
  const {page,errors}=await open(t,{width,reducedMotion:'reduce'});
  assert.equal(await page.locator('.phase-rail [aria-current] time').textContent(),'Oct 3, 2026');
  assert.equal(await page.locator('[data-countdown="2026-10-05"]').textContent(),'1 day');
  assert.equal(await page.locator('.timeline-entry[data-kind="Document"]').count(),1);
  assert.equal(await page.locator('.timeline-entry[data-kind="email"]').count(),1);
  assert.equal(await page.locator('[data-add-date="rent_start"]').count(),1);
  assert.equal(await page.locator('#appLayout').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  assert.ok((await page.locator('#recordPanel').boundingBox()).width>=Math.min(1100,width-30));
  assert.equal(await page.locator('.timeline-entry').evaluateAll(es=>es.every(e=>getComputedStyle(e).transitionDuration==='0s'&&getComputedStyle(e).transform==='none')),true);
  await page.screenshot({path:new URL(`out/test-artifacts/w9/deal-${width}.png`,root).pathname});
  await page.locator('.timeline-entry[data-kind="email"] summary').click();
  assert.match(await page.locator('.timeline-entry[data-kind="email"] .note-original').textContent(),/Original synthetic email/);
  assert.ok((await page.locator('.timeline-entry[data-kind="email"] > p').textContent()).length<=150);
  await page.screenshot({path:new URL(`out/test-artifacts/w9/timeline-${width}.png`,root).pathname});
  assert.equal(await page.locator('#timelineRange').inputValue(),'full');
  assert.equal(await page.getByText('Demo historic entry',{exact:true}).count(),1);
  await page.locator('#timelineRange').selectOption('recent');
  assert.equal(await page.getByText('Demo historic entry',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 });
});
test('W9 live refresh preserves expanded originals, range, scroll, focus and drafts through outages',async t=>{
 const {page,errors}=await open(t);
 await page.locator('#timelineRange').selectOption('full');
 const summary=page.locator('.timeline-entry[data-kind="email"] summary');await summary.click();await summary.focus();
 await page.evaluate(()=>{window.timelineProbe.changed=true;});
 await page.locator('[data-date-id="loi"] details').evaluate(n=>n.open=true);
 await page.locator('.full-record').evaluate(n=>n.open=true);
 const before=await page.locator('#recordPanel').evaluate(e=>e.scrollTop);
 await page.clock.fastForward(16000);
 assert.equal(await page.locator('[data-countdown="2026-10-09"]').textContent(),'5 days');
 assert.equal(await page.locator('#timelineRange').inputValue(),'full');
 assert.equal(await page.locator('[data-date-id="loi"] details').evaluate(n=>n.open),true);
 assert.equal(await page.locator('.full-record').evaluate(n=>n.open),true);
 assert.equal(await page.locator('.timeline-entry[data-kind="email"] details').evaluate(e=>e.open),true);
 assert.equal(await summary.evaluate(e=>document.activeElement===e),true);
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.scrollTop),before);
 await page.locator('#detailNextForm textarea').fill('Demo unsaved next step');
 await page.evaluate(()=>{window.timelineProbe.fail=true;});await page.clock.fastForward(16000);
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-retry-detail]').count(),0);
 assert.equal(await page.locator('#detailNextForm textarea').inputValue(),'Demo unsaved next step');
 await page.evaluate(()=>{window.timelineProbe.fail=false;});await page.clock.fastForward(16000);
 await page.waitForFunction(()=>!document.querySelector('#detailReadStatus').textContent);
 await page.clock.fastForward(86400000);
 assert.equal(await page.locator('[data-countdown="2026-10-09"]').textContent(),'4 days');
 assert.deepEqual(errors,[]);
});
test('W9 Add date records an explicit contract reference and lost answers never duplicate the date',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const add=state.client.addCriticalDate;let lose=true;state.client.addCriticalDate=async args=>{const result=await add(args);if(lose){lose=false;throw new Error('Synthetic lost reply');}return result;};});
 await page.locator('[data-add-date="rent_start"]').click();
 await page.locator('#dealDateForm [name="date"]').fill('2026-12-01');
 await page.locator('#dealDateForm [name="evidence"]').fill('Demo lease clause 4');
 await page.locator('#dealDateForm button[type="submit"]').click();
 await page.getByText('Date not confirmed',{exact:true}).waitFor();
 await page.locator('#dealDateForm button[type="submit"]').click();
 await page.waitForFunction(()=>!document.querySelector('#dealDateDialog').open);
 assert.equal(await page.locator('[data-add-date="rent_start"]').count(),0);
 assert.equal(await page.locator('[data-countdown="2026-12-01"]').count(),1);
 const events=await page.evaluate(async()=> (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events);
 assert.equal(events.filter(e=>e.verb==='add-critical-date'&&e.new_value==='2026-12-01').length,1);
 assert.deepEqual(errors,[]);
});
test('PR129 finding 11 header, timeline, date cards and inputs retain readable theme pairs',async t=>{
 for (const theme of ['light','dark']) for (const width of [1440,390]) await t.test(`${theme} ${width}`,async t=>{
  const {page,errors}=await open(t,{width,reducedMotion:'reduce'});
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const pairs=[
   ['#panelTitle','#recordPanel > header'],
   ['.timeline-heading h3','.deal-timeline'],
   ['.timeline-entry[data-kind="email"] > p','.timeline-entry[data-kind="email"]'],
   ['.timeline-entry[data-kind="email"] summary','.timeline-entry[data-kind="email"]'],
   ['.timeline-actor','.timeline-entry'],
   ['.timeline-date-links button','.timeline-date-links button'],
   ['[data-date-id="loi"] > span','[data-date-id="loi"]'],
   ['[data-date-id="loi"] strong','[data-date-id="loi"]'],
   ['[data-add-date="rent_start"] strong','[data-add-date="rent_start"]'],
  ];
  const contrasts=await page.evaluate(pairs=>{
   const rgba=s=>s.match(/[\d.]+/g).map(Number);
   const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*(fg[3]??1)+bg[i]*(1-(fg[3]??1)));
   const background=e=>e?over(rgba(getComputedStyle(e).backgroundColor),background(e.parentElement)):[255,255,255];
   const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
   return pairs.map(([text,surface])=>{
    const node=document.querySelector(text),panel=document.querySelector(surface),style=getComputedStyle(panel);
    const base=background(panel);
    const stops=style.backgroundImage.match(/rgba?\([^)]+\)/g)||[];
    const backgrounds=stops.length?stops.map(s=>over(rgba(s),base)):[base];
    const foreground=rgba(getComputedStyle(node).color);
    const ratio=Math.min(...backgrounds.map(bg=>{
     const a=luminance(over(foreground,bg)),b=luminance(bg);
     return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }));
    return {text,ratio};
   });
  },pairs);
  for(const {text,ratio} of contrasts) assert.ok(ratio>=4.5,`${theme} ${width} ${text}: ${ratio.toFixed(2)}:1`);
  await page.locator('[data-add-date="rent_start"]').click();
  const inputPair=await page.locator('#dealDateForm [name="evidence"]').evaluate(e=>{
   const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,colorScheme:s.colorScheme};
  });
  // The entry field follows the same semantic text/ground pair as its dialog.
  assert.equal(inputPair.colorScheme,theme);
  const inputContrast=await page.locator('#dealDateForm [name="evidence"]').evaluate(e=>{
   const l=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
   const s=getComputedStyle(e),a=l(s.color),b=l(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(inputContrast>=4.5,`${theme} input: ${inputContrast.toFixed(2)}:1`);
  assert.deepEqual(errors,[]);
 });
});
test('W9 board/list use the same addressable popup and Home href opens it directly',async t=>{
 const {page,errors}=await open(t,{link:true});
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 await page.getByLabel('Close deal',{exact:true}).click();
 assert.equal(new URL(page.url()).searchParams.has('deal'),false);
 await page.locator('#listView').click();await page.locator('.deal-row[data-id="d14"]').click();
 assert.equal(await page.locator('#recordPanel').evaluate(e=>e.open),true);
 await page.getByLabel('Close deal',{exact:true}).click();
 await page.locator('#homeDealFlag').click();
 await page.locator('#recordPanel[open] #timelineRange').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
 assert.equal(await page.locator('#recordPanel[open]').count(),1);
 assert.deepEqual(errors,[]);
});

test('review 3: an old date submission cannot disable, close or change a later draft',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const add=state.client.addCriticalDate;
  window.dateRequests=[];
  state.client.addCriticalDate=args=>new Promise(resolve=>{
   window.dateRequests.push(args);window.finishDate=async()=>resolve(await add(args));
  });
 });
 await page.locator('[data-add-date="rent_start"]').click();
 await page.locator('#dealDateForm [name="date"]').fill('2026-12-01');
 await page.locator('#dealDateForm [name="evidence"]').fill('Demo lease clause 4');
 // A date command requires the captured deal to remain the authorized detail.
 await page.evaluate(async()=>{(await import('/js/pipeline.js')).state.panelDeal='d21';});
 await page.locator('#dealDateForm button[type="submit"]').click();
 assert.equal(await page.evaluate(()=>window.dateRequests.length),0);
 await page.evaluate(async()=>{(await import('/js/pipeline.js')).state.panelDeal='d14';});
 await page.locator('#dealDateForm button[type="submit"]').click();
 await page.waitForFunction(()=>window.dateRequests.length===1);
 assert.equal(await page.evaluate(()=>window.dateRequests[0].deal),'d14');
 await page.locator('#dealDateCancel').click();
 await page.locator('[data-add-date="option_window"]').click();
 await page.locator('#dealDateForm [name="date"]').fill('2027-01-15');
 await page.locator('#dealDateForm [name="evidence"]').fill('Demo option clause 5');
 assert.equal(await page.locator('#dealDateForm button[type="submit"]').isEnabled(),true);
 await page.evaluate(()=>window.finishDate());
 await page.waitForFunction(()=>document.querySelector('[data-op="critical-date:d14:rent_start"]').dataset.state==='confirmed');
 assert.equal(await page.locator('#dealDateDialog').evaluate(e=>e.open),true);
 assert.equal(await page.locator('#dealDateTitle').textContent(),'Options');
 assert.equal(await page.locator('#dealDateForm [name="date"]').inputValue(),'2027-01-15');
 assert.equal(await page.locator('#dealDateForm [name="evidence"]').inputValue(),'Demo option clause 5');
 assert.equal(await page.locator('#dealDateStatus').textContent(),'');
 assert.deepEqual(errors,[]);
});
test('review 4: poll restores each focusable timeline control by stable identity',async t=>{
 for(const selector of ['.timeline-entry[data-kind="email"]','[data-date-id="loi"] summary','[data-timeline-day="2026-10-02"]']) await t.test(selector,async t=>{
  const {page,errors}=await open(t);const control=page.locator(selector);
  await control.focus();
  await page.evaluate(()=>window.timelineProbe.changed=true);
  await page.clock.fastForward(16000);
  await page.waitForFunction(()=>document.querySelector('[data-countdown="2026-10-09"]'));
  assert.equal(await control.evaluate(e=>document.activeElement===e),true);
  assert.deepEqual(errors,[]);
 });
});
test('review 5: hanging date writes become unknown and reconcile only the retained request on explicit action',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{
  const {state}=await import('/js/pipeline.js');const add=state.client.addCriticalDate;
  window.dateRequests=[];
  state.client.addCriticalDate=async args=>{
   window.dateRequests.push(args);
   if(window.dateRequests.length===1)return new Promise(resolve=>{window.finishLateDate=resolve;});
   return add(args);
  };
 });
 await page.locator('[data-add-date="rent_start"]').click();
 await page.locator('#dealDateForm [name="date"]').fill('2026-12-01');
 await page.locator('#dealDateForm [name="evidence"]').fill('Demo lease clause 4');
 await page.locator('#dealDateForm button[type="submit"]').click();
 await page.waitForFunction(()=>window.dateRequests.length===1);
 await page.clock.fastForward(60000);
 await page.waitForFunction(()=>document.querySelector('#dealDateStatus').textContent);
 assert.equal(await page.locator('#dealDateStatus').textContent(),'Date not confirmed');
 assert.equal(await page.locator('#dealDateForm button[type="submit"]').isEnabled(),true);
 const receipt=page.locator('.receipt[data-op="critical-date:d14:rent_start"]');
 assert.equal(await receipt.getAttribute('data-state'),'unknown');
 assert.equal(await receipt.getByRole('button',{name:'Check outcome'}).count(),1);
 assert.equal(await page.evaluate(()=>window.dateRequests.length),1,'no automatic resend');
 await page.locator('#dealDateCancel').click();
 await page.locator('[data-add-date="option_window"]').click();
 assert.equal(await page.locator('#dealDateForm button[type="submit"]').isEnabled(),true);
 await page.locator('#dealDateCancel').click();
 await page.getByLabel('Close deal',{exact:true}).click();
 await receipt.getByRole('button',{name:'Check outcome'}).click();
 await page.waitForFunction(()=>document.querySelector('.receipt[data-op="critical-date:d14:rent_start"]').dataset.state==='confirmed');
 const requests=await page.evaluate(()=>window.dateRequests);
 assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);
 assert.ok(requests[0].idempotency_key);
 // An abandoned transport answer cannot overwrite the reconciled outcome.
 await page.evaluate(()=>window.finishLateDate({ok:false}));
 assert.equal(await receipt.getAttribute('data-state'),'confirmed');
 const events=await page.evaluate(async()=> (await (await import('/js/pipeline.js')).state.client.getChanges(null)).events);
 assert.equal(events.filter(e=>e.verb==='add-critical-date'&&e.new_value==='2026-12-01').length,1);
 assert.deepEqual(errors,[]);
});
