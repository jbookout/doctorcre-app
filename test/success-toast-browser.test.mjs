import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,fixtureServer} from './browser-harness.mjs';

for (const surface of ['tasks','prototype']) test(`${surface} success uses the shared two-second hold and fade`,async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-04T17:00:00Z')});
 await page.goto(server.origin+(surface==='tasks'?'/doc-chats/work':'/design-business.html'));
 if(surface==='tasks') {
  await page.waitForFunction(()=>document.querySelector('#quickAddForm')?.hidden===false);
  await page.locator('#quickAddInput').fill('Call the synthetic practice');
  await page.locator('#quickAddForm button[type=submit]').click();
 }else {
  await page.getByRole('tab',{name:'Work',exact:true}).click();
  await page.locator('#workList [data-handover]').first().click();
  await page.clock.runFor(1000);
 }
 await page.locator('.toast').waitFor();
 await page.clock.runFor(2001);
 assert.equal(await page.locator('.toast').evaluate(n=>n.classList.contains('is-leaving')),true);
 await page.clock.runFor(800);
 assert.equal(await page.locator('.toast').count(),0);
 assert.deepEqual(errors,[]);
});
