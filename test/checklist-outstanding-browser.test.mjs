import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { chromium } from './browser-harness.mjs';

const recording = JSON.parse(await readFile(new URL('./fixtures/checklist-outstanding/recordings.json',import.meta.url)));
const snapshot = recording.response;
const all = snapshot.phases.flatMap(p=>p.items);
const outstanding = all.filter(i=>['not_recorded','due','overdue','upcoming'].includes(i.status));
for(const width of [390,1280]) for(const theme of ['light','dark']) test(`checklist local selection and lifetime ${width} ${theme}`,async t=>{
 const assets=await uiAssets(path=>readFile(new URL('../'+path,import.meta.url),'utf8'));
 const routes=new Map([...assets].map(([path,body])=>['/'+path,{body,contentType:'text/javascript'}]));
 routes.set('/',{body:`<html data-theme="${theme}"><main id="host"></main></html>`,contentType:'text/html'});
 const server=await startFixture({routes});t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:960}});
 await page.goto(server.origin);await page.evaluate(async snapshot=>{const {mountDealChecklist}=await import('/js/ui-checklist.generated.js');window.panel=mountDealChecklist(document.querySelector('#host'),{dealId:'a',checklist:snapshot});},snapshot);
 const root=page.locator('.deal-checklist');await root.locator(':scope > summary').click();
 const filter=page.getByLabel('Requirements view');await filter.focus();await page.keyboard.press('o');await page.keyboard.press('Tab');assert.equal(await filter.inputValue(),'outstanding');
 assert.deepEqual(await root.locator('[data-checklist-item]').evaluateAll(rows=>rows.map(r=>r.dataset.checklistItem)),outstanding.map(i=>i.id));
 assert.equal(await root.locator('[data-checklist-count]').textContent(),`${outstanding.length} matching of ${all.length} recorded requirements.`);
 assert.match(await root.locator(':scope > summary').textContent(),/2 due/);
 await root.locator('[data-checklist-item="requirements"] summary').click();await filter.focus();
 await page.evaluate(snapshot=>window.panel.update({dealId:'a',checklist:snapshot}),snapshot);
 assert.equal(await filter.inputValue(),'outstanding');assert.equal(await filter.evaluate(n=>n===document.activeElement),true);
 assert.equal(await root.locator('[data-checklist-item="requirements"] details').evaluate(n=>n.open),true);
 await filter.selectOption('all');assert.equal(await root.locator('[data-checklist-item]').count(),all.length);
 assert.equal(await root.locator('[data-checklist-item="requirements"] details').evaluate(n=>n.open),true);
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:snapshot}),snapshot);
 await root.locator(':scope > summary').click();assert.equal(await filter.inputValue(),'all');assert.equal(await root.locator('[data-checklist-item="requirements"] details').evaluate(n=>n.open),false);
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:{...snapshot,phases:[]}}),snapshot);assert.match(await root.textContent(),/No requirements recorded/);
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:{...snapshot,phases:snapshot.phases.map(p=>({...p,items:p.items.filter(i=>['received','complete'].includes(i.status))}))}}),snapshot);
 await filter.selectOption('outstanding');assert.match(await root.textContent(),/All recorded requirements are received or complete/);
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:{...snapshot,phases:[null]}}),snapshot);assert.equal(await root.locator('[data-checklist-item]').count(),0);assert.match(await root.textContent(),/Checklist unavailable/);
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:snapshot}),snapshot);assert.equal(await filter.inputValue(),'outstanding');
 await page.evaluate(snapshot=>window.panel.update({dealId:'b',checklist:{...snapshot,phases:[null]}}),snapshot);
 await page.evaluate(()=>{window.panel.dispose();window.panel.update({dealId:'a',checklist:null});});assert.equal(await page.locator('#host').textContent(),'');
});

for(const lateAfterAuth of [false,true]) test(`pipeline refresh preserves filter and draft; stale read cannot repaint another deal; auth retires island, late after auth ${lateAfterAuth}`,async t=>{
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {buildArtifact}=await import('../scripts/artifact.mjs');const {createQaServer}=await import('../scripts/qa-fixture-server.mjs');
 const {fileURLToPath}=await import('node:url');
 const out=temporaryDirectory('checklist-pipeline-',t);await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:out});
 const server=await(await createQaServer({buildRoot:out+'/site'})).start();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.request.post(server.origin+'/api/test/seed',{data:{namespace:'checklist-lifetime',viewer:'joe',reset:true}});
 await page.goto(server.origin+'/deals?mode=live');await page.locator('.card-open').first().waitFor();
 await page.evaluate(async snapshot=>{
  const {state}=await import('/js/pipeline.js');const get=state.client.getDeal.bind(state.client);
  window.reads=0;window.mode='normal';window.getChecklist=get;
  state.client.getDeal=async(...args)=>{window.reads++;const detail=await get(...args);if(window.mode==='failure')throw Error('Synthetic transient failure');if(window.mode==='denied')throw Object.assign(Error('Denied'),{status:403});if(window.mode==='recovery')await new Promise(resolve=>window.releaseRecovery=resolve);if(window.mode==='held')await new Promise(resolve=>window.release=resolve);return {...detail,checklist:snapshot};};
 },snapshot);
 await page.locator('.card-open').first().click();await page.locator('.deal-checklist > summary').click();
 const filter=page.getByLabel('Requirements view');const beforeFilterReads=await page.evaluate(()=>window.reads);await filter.selectOption(lateAfterAuth?'outstanding':'all');assert.equal(await page.evaluate(()=>window.reads),beforeFilterReads);await page.locator('#dealUpdate').fill('First deal unsaved edit');
 await page.evaluate(()=>window.mode='failure');await page.locator('.deal-freshness [data-refresh-detail]').click();
 await page.getByText('Updates temporarily unavailable',{exact:true}).waitFor();assert.equal(await filter.inputValue(),lateAfterAuth?'outstanding':'all');assert.equal(await page.locator('#dealUpdate').inputValue(),'First deal unsaved edit');
 await page.evaluate(()=>window.mode='recovery');await page.locator('.deal-freshness [data-refresh-detail]').click();
 await page.waitForFunction(()=>!!window.releaseRecovery);
 const status=page.locator('#detailReadStatus');
 assert.equal(await status.textContent(),'Updates temporarily unavailable');assert.equal(await status.isVisible(),true);
 const recovery=page.waitForFunction(()=>document.querySelector('#detailReadStatus')?.textContent==='');
 assert.equal(await Promise.race([recovery.then(()=> 'completed'),new Promise(resolve=>setTimeout(()=>resolve('pending'),200))]),'pending','recovery must stay pending while its response is held');
 assert.equal(await status.textContent(),'Updates temporarily unavailable');assert.equal(await status.isVisible(),true);
 await page.evaluate(()=>window.releaseRecovery());await recovery;
 assert.equal(await status.textContent(),'');assert.equal(await status.isHidden(),true);
 assert.equal(await filter.inputValue(),lateAfterAuth?'outstanding':'all');assert.equal(await page.locator('#dealUpdate').inputValue(),'First deal unsaved edit');
 await page.evaluate(()=>window.mode='held');await page.locator('.deal-freshness [data-refresh-detail]').click();await page.waitForFunction(()=>!!window.release);
 const firstId=await page.evaluate(async()=>(await import('/js/pipeline.js')).state.panelDeal);
 await page.locator('#panelClose').click();await page.locator(`.kanban-card:not([data-id="${firstId}"]) .card-open`).first().waitFor();
 await page.evaluate(()=>window.mode='normal');await page.locator(`.kanban-card:not([data-id="${firstId}"]) .card-open`).first().click();await page.locator('#dealUpdate').fill('Second deal unsaved edit');
 await filter.waitFor({state:'attached'});assert.equal(await filter.inputValue(),'all');
 if(!lateAfterAuth){await page.evaluate(()=>window.release());await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 assert.equal(await page.locator('#dealUpdate').inputValue(),'Second deal unsaved edit');assert.notEqual(await page.evaluate(async()=>(await import('/js/pipeline.js')).state.panelDeal),firstId);
 if(lateAfterAuth){await page.locator('.deal-checklist > summary').click();await filter.selectOption('outstanding');}
 await page.evaluate(()=>window.mode='denied');await page.locator('.deal-freshness [data-refresh-detail]').click();await page.getByText('Unavailable. Sign in to reload this record.',{exact:false}).waitFor();
 if(lateAfterAuth){await page.evaluate(()=>window.release());await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 assert.equal(await page.locator('.deal-checklist').count(),0);assert.equal(await page.locator('#dealUpdate').count(),0);
});
