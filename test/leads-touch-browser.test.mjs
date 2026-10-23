import test from 'node:test';import assert from 'node:assert/strict';import { chromium, pausedClock } from './browser-harness.mjs';
import {routeLeads} from './leads-browser-fixture.mjs';

test('blocking 10: real phone touch drag scrolls to an offscreen stage and opens its review',async t=>{
 const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:960},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
 const writes=[];await routeLeads(page,{onWrite:p=>writes.push(p)});await page.goto('http://localhost/leads');
 await page.locator('.market-marker').first().waitFor({state:'attached'});
 await pausedClock(page,new Date('2026-10-03T18:00:00Z'));
 const handle=page.locator('.lead-card [data-drag-handle]').first();await handle.scrollIntoViewIfNeeded();
 const initial=await page.evaluate(()=>scrollY);const box=await handle.boundingBox();const cdp=await page.context().newCDPSession(page);
 const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,radiusX:3,radiusY:3,id:1}]});
 await touch('touchStart',box.x+box.width/2,box.y+box.height/2);await touch('touchMove',195,945);
 await page.clock.runFor(500);assert.ok(await page.evaluate(start=>scrollY>start+150,initial),'edge drag scrolls after 500ms of animation frames');
 const target=page.locator('[data-stage="qualified"] .stage-head');
 const destinationVisible=()=>page.evaluate(()=>{const r=document.querySelector('[data-stage="qualified"] .stage-head').getBoundingClientRect();const top=document.querySelector('.app-layout-tabbar').getBoundingClientRect().bottom;const bottom=document.querySelector('.app-layout-status').getBoundingClientRect().top;return r.top>top&&r.bottom<bottom});
 for(let frame=0;frame<250&&!await destinationVisible();frame++)await page.clock.runFor(16);
 assert.ok(await destinationVisible(),'edge drag brings the target into the usable viewport');
 const destination=await target.boundingBox();await touch('touchMove',destination.x+destination.width/2,destination.y+destination.height/2);
 await page.waitForFunction(()=>document.querySelector('[data-stage="qualified"]').dataset.dropActive==='true');await touch('touchEnd');
 await page.locator('#stageDialog[open] .stage-proposal').waitFor();assert.match(await page.locator('.stage-proposal').innerText(),/New.*Qualified/s);assert.equal(writes.length,0);
 await page.locator('#closeStage').click();assert.equal(await page.locator('[data-drop-active]').count(),0);
});

for (const width of [320, 390]) test(`Slice A market filters and drag handles have separate 44px phone targets at ${width}`, async t => {
 const browser = await chromium.launch(); t.after(() => browser.close());
 const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
 const writes = [];
 await routeLeads(page, { onWrite: value => writes.push(value) });
 await page.goto('http://localhost/leads');
 await page.locator('.lead-card').first().waitFor();
 for (const selector of ['#marketCounts button', '.lead-card [data-drag-handle]']) {
  const targets = page.locator(selector);
  for (const target of await targets.all()) {
   await target.scrollIntoViewIfNeeded();
   const geometry = await target.evaluate(node => {
    const r = node.getBoundingClientRect();
    const peers = [...node.closest('.lead-card, #marketCounts').querySelectorAll('button, [data-drag-handle]')].filter(peer => peer !== node);
    return { width: r.width, height: r.height, overlap: peers.some(peer => {
     const p = peer.getBoundingClientRect();
     return Math.min(r.right, p.right) > Math.max(r.left, p.left) && Math.min(r.bottom, p.bottom) > Math.max(r.top, p.top);
    }), hit: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
   });
   assert.ok(geometry.width >= 44 && geometry.height >= 44, `${selector}: ${JSON.stringify(geometry)}`);
   assert.equal(geometry.overlap, false, selector);
   assert.equal(geometry.hit, true, selector);
  }
 }
 assert.equal(await page.locator('#stageFilter').isVisible(), true, 'stage select remains available');
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 assert.deepEqual(writes, []);
});
