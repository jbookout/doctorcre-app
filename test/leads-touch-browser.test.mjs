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
 // Drive animation frames explicitly: CPU contention must not change the gesture's elapsed time.
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
