import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {CHROMIUM_SAFETY_ARGS} from '../scripts/chromium-safety-args.mjs';
import {prove, exerciseSourceFilter} from '../scripts/prove-contact-reasons-source-filter.mjs';
const exec=promisify(execFile);
const snapshot = await proofAssetSnapshot();
async function serverFor(t,mode='pass') {
  const routes = new Map(snapshot);
  routes.set('/app-release', { contentType: 'application/json', body: JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)}) });
  if (mode === 'fail') routes.set('/js/contact-reasons.mjs', { contentType: 'text/javascript', body: 'export const missing=true;' });
  const server = await startFixture({ routes });
  t.after(() => server.close());
  return server.origin;
}
for(const mode of ['pass','fail']) test(`source proof CLI fixture ${mode}`,async t=>{
  const origin=await serverFor(t,mode);
  await assert.rejects(exec(process.execPath,['scripts/prove-contact-reasons-source-filter.mjs','--origin',origin,'--timeout-ms','20000'],{timeout:25000}),error=>{
    assert.equal(error.code,mode==='pass'?78:1,error.stdout+error.stderr);
    const receipt=JSON.parse(error.stdout);
    if(mode==='pass') {
      assert.equal(receipt.deployed_module.status,'passed');
      assert.equal(receipt.natural.status,'insufficient_evidence');
      assert.equal(receipt.deployed_module.assertions.length,9);
    } else assert.equal(receipt.status,'failed');
    return true;
  });
});
for(const mode of ['late launch','stalled evaluation']) test(`deadline cleans ${mode}`,async t=>{
  const origin=await serverFor(t);
  const browsers=[];
  let release;
  const acquired=new Promise(resolve=>{release=resolve;});
  const engine={launch:async()=>{
    const browser=await chromium.launch({args:[...CHROMIUM_SAFETY_ARGS]});
    browsers.push(browser);
    if(mode==='late launch') await acquired;
    return browser;
  }};
  t.after(async()=>{release();await Promise.all(browsers.map(browser=>browser.close()));});
  const pending=prove({origin,timeoutMs:1000,engine,observe:page=>page.evaluate(()=>new Promise(()=>{}))});
  await assert.rejects(pending,error=>error.exitCode===78);
  release();
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(browsers.length,1);
  assert.equal(browsers.filter(browser=>browser.isConnected()).length,0,'zero owned browsers survive');
});

for (const hostname of ['dataXcms.gov', 'data.cmsXgov']) test(`source proof rejects lookalike citation host ${hostname}`, async t => {
  const origin = await serverFor(t);
  await assert.rejects(prove({origin, observe: async (page, moduleUrl) => {
    await page.evaluate(hostname => {
      new MutationObserver(() => {
        for (const link of document.querySelectorAll('article a')) {
          const url = new URL(link.href);
          if (url.hostname === 'data.cms.gov') {
            url.hostname = hostname;
            link.href = url.href;
          }
        }
      }).observe(document.body, {childList: true, subtree: true});
    }, hostname);
    return exerciseSourceFilter(page, moduleUrl);
  }}), {code: 'ERR_ASSERTION', actual: `https://${hostname.toLowerCase()}`, expected: 'https://data.cms.gov'});
});
