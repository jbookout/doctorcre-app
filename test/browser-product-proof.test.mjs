import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { exerciseContinuity, exerciseReload } from '../tests/journeys/browser-continuity.mjs';
import { continuityCases, assertServedBuild } from '../scripts/browser-proof-contract.mjs';

for (const {width,motion,id} of continuityCases) test(`product continuity ${width}px ${motion}`,async t=>{
  const server=await fixtureServer(); t.after(()=>server.close());
  if(process.env.BROWSER_PROOF_BINDING) await assertServedBuild(server.origin,JSON.parse(process.env.BROWSER_PROOF_BINDING));
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const output=process.env.BROWSER_PROOF_DIR;
  const recording=output && width===390 && motion==='reduce';
  if(output) await mkdir(join(output,'raw'),{recursive:true});
  const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion,...(recording?{recordVideo:{dir:join(output,'raw'),size:{width,height:960}}}:{})});
  if(recording) await page.context().tracing.start({screenshots:true,snapshots:true,sources:true});
  let status='failed',values;
  try {
    await exerciseContinuity(page,server.origin);
    values=await exerciseReload(page,server.origin);
    if(recording) {
      await page.locator('#space-requirements').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,'checkpoint.png')});
      await delay(1200); // Retain a decodable checkpoint frame after the deciding reload.
    }
    status='passed';
  } finally {
    if(recording) {
      await page.context().tracing.stop({path:join(output,'trace.zip')});
      const video=page.video(); await page.context().close();
      await copyFile(await video.path(),join(output,'video.webm'));
    }
    if(output) {
      const binding=JSON.parse(await readFile(join(output,'binding.json'),'utf8'));
      await writeFile(join(output,`${id}.json`),JSON.stringify({binding,id,status,attempts:1,values}));
    }
  }
});

test('continuity waits for a queued outer-dialog close and focus restoration', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  if(process.env.BROWSER_PROOF_BINDING) await assertServedBuild(server.origin,JSON.parse(process.env.BROWSER_PROOF_BINDING));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:960},reducedMotion:'reduce'});
  // Deliver the close on a later browser task, as on a busy runner. The
  // oracle must read the completed close, not the return from input delivery.
  await page.addInitScript(() => {
    document.addEventListener('click', event => {
      const button = event.target.closest('#panelClose');
      if (!button || button.dataset.queuedClose) return;
      event.stopImmediatePropagation();
      button.dataset.queuedClose = 'true';
      setTimeout(() => button.click(), 100);
    }, true);
  });
  await exerciseContinuity(page, server.origin);
});

test('a dropped storage write shows saved but the independent reload oracle fails',async t=>{
  const server=await fixtureServer();t.after(()=>server.close());
  if(process.env.BROWSER_PROOF_BINDING) await assertServedBuild(server.origin,JSON.parse(process.env.BROWSER_PROOF_BINDING));
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  await assert.rejects(exerciseReload(page,server.origin,{dropWrite:true}),/draft missing after independent reload/);
  const clean=await browser.newPage();
  await exerciseReload(clean,server.origin);
  if(process.env.BROWSER_PROOF_DIR) {
    const output=process.env.BROWSER_PROOF_DIR;
    const binding=JSON.parse(await readFile(join(output,'binding.json'),'utf8'));
    await writeFile(join(output,'qualification.json'),JSON.stringify({binding,broken:'failed',repaired:'passed'}));
  }
});
