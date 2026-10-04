import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForState } from './browser-state.mjs';
test('browser state waits await an async false result and keep polling until true',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await assert.rejects(waitForState(page,async()=>false,undefined,{timeoutMs:50}),/timed out|Timeout/i);
 await page.evaluate(()=>window.checks=0);await waitForState(page,async()=>++window.checks>=3);assert.ok(await page.evaluate(()=>window.checks>=3));
});
