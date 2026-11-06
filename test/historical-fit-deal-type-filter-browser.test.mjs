import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { filterAssertions } from '../scripts/prove-historical-fit-deal-type-filter.mjs';
for(const width of [390,1280]) for(const colorScheme of ['light','dark']) {
  test(`deal type transitions and invariants at ${width} ${colorScheme}`,async t=>{
    const server=await startFixtureServer();t.after(()=>server.stop());
    const browser=await chromium.launch();t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:900},colorScheme});
    await page.route(`${server.url}/__filter`,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Filter</title>'}));
    await page.goto(`${server.url}/__filter`);
    assert.equal((await filterAssertions(page,`${server.url}/js/ui-ideal-client-profile.js`)).length,10);
  });
}
