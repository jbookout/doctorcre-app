import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { readFile } from 'node:fs/promises';
const publication = JSON.parse(await readFile(new URL('./fixtures/ownership/example-health.market-study.json',import.meta.url)));
const second = structuredClone(publication.properties[0]);
second.id='second'; second.address='Second synthetic property'; second.ownership.asking_price=1200000;
publication.properties.push(second);
const bundle = await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {OwnershipModeler} from './src/ui/portal/ownership-modeler'; const root=createRoot(document.getElementById('root')); window.render=p=>root.render(<OwnershipModeler publication={p} onOpenProperty={id=>{document.getElementById('opened').textContent=id}}/>); window.render(${JSON.stringify(publication)});`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife'});
for(const width of [390,1280]) for(const theme of ['light','dark']) {
 test(`ownership DOM at ${width}px in ${theme} theme`,async()=>{
  const browser=await chromium.launch({headless:true,args: [...CHROMIUM_SAFETY_ARGS]});
  try {
   const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
   const page=await context.newPage(); const errors=[]; const requests=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{if(route.request().url()==='https://ownership.test/')return route.fulfill({contentType:'text/html',body:`<html data-theme="${theme}"><body><div id="root"></div><output id="opened"></output></body></html>`}); requests.push(route.request().url()); return route.abort();});
   const mount=async()=>{await page.goto('https://ownership.test/');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.locator('#ownership-comparison').waitFor();};
   await mount();
   assert.equal(await page.locator('#ownership-property').inputValue(),'sample-property-1');
   assert.equal(await page.locator('#ownership-form input').count(),14);
   for(const id of ['ownership-comparison','ownership-carry-table','ownership-outcome-table','ownership-lease-table']) assert.ok(await page.locator(`#${id}`).isVisible());
   await page.locator('#assumption-rate').fill('0');
   assert.equal(await page.locator('#ownership-form input[name=rate]').inputValue(),'0');
   assert.match(await page.locator('#ownership-comparison').innerText(),/2,666.67/);
   await page.locator('#ownership-form input[name=price]').fill('');
   await page.locator('#ownership-message[role=alert]').waitFor();
   assert.equal(await page.locator('#ownership-comparison').count(),0);
   await page.locator('#ownership-form input[name=price]').fill('1000000');
   await page.locator('#ownership-comparison').waitFor();
   await page.locator('#ownership-form').evaluate(form=>form.requestSubmit());
   await page.locator('[data-property-occupancy]').first().fill('40');
   assert.equal(await page.locator('#ownership-form input[name=share]').inputValue(),'40');
   await page.locator('.ti-toggle').first().getByRole('radio').nth(1).check();
   assert.equal(await page.locator('#tenant-ti').inputValue(),'40');
   assert.equal(await page.locator('.ti-toggle input:checked').count(),2);
   await page.locator('#practice-lease-rate').fill('30');
   await page.locator('#equity-year').fill('5');
   assert.match(await page.locator('#equity-year-label').innerText(),/5/);
   await page.locator('#line-view').selectOption('lease');
   assert.match(await page.locator('#ownership-line-legend').innerText(),/Lease/);
   await page.locator('#line-property').selectOption('second');
   await page.locator('#coverage-chart .coverage-row').first().click();
   assert.equal(await page.locator('#opened').innerText(),'sample-property-1');
   await page.locator('#ownership-property').selectOption('second');
   assert.equal(await page.locator('#ownership-form input[name=price]').inputValue(),'1200000');
   assert.equal(await page.locator('#ownership-form input[name=rate]').inputValue(),'6.5');
   await page.getByRole('button',{name:'Restore published defaults'}).click();
   assert.equal(await page.locator('#ownership-property').inputValue(),'sample-property-1');
   const before=await page.locator('#ownership-outcome-table').innerText();
   await page.locator('#ownership-form input[name=collection_pct]').fill('0');
   assert.notEqual(await page.locator('#ownership-outcome-table').innerText(),before);
   assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie})),{local:0,session:0,cookie:''});
   await mount(); assert.equal(await page.locator('#ownership-form input[name=collection_pct]').inputValue(),'95');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.ok(!/NaN|Infinity/.test(await page.locator('#strategy').innerText()));
   await page.evaluate(p=>window.render({...p,ownership:undefined}),publication);
   await page.locator('#strategy').waitFor({state:'detached'});
   await page.evaluate(p=>window.render({...p,properties:[]}),publication);
   await page.getByText('No eligible ownership properties').waitFor();
   await page.evaluate(p=>window.render(p),publication);
   await page.locator('#ownership-comparison').waitFor();
   assert.equal(await page.locator('#ownership-form input[name=rate]').inputValue(),'6.5');
   assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  } finally {await browser.close();}
 });
}

function regression(name, check) {
 test(name,async()=>{
  const browser=await chromium.launch({headless:true,args:[...CHROMIUM_SAFETY_ARGS]});
  try {
   const page=await browser.newPage();
   await page.setContent('<div id="root"></div><output id="opened"></output>');
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   await page.locator('#ownership-comparison').waitFor();
   await check(page);
  } finally {await browser.close();}
 });
}
regression('crossing summary uses exactly the plotted series',async page=>{
 const assertCrossing=async()=>{
  const year=await page.locator('#ownership-line-chart').evaluate(svg=>{
   const lines=[...svg.querySelectorAll('polyline')].map(line=>[...line.points].map(p=>p.y));
   return lines[0].findIndex((y,index)=>y<=lines[1][index]);
  });
  assert.equal((await page.locator('#line-summary').innerText()).split(' Annual points')[0],year<0?'No crossing in the ten-year illustration.':`First annual crossing at year ${year}.`);
 };
 await page.locator('#line-view').selectOption('lease');
 await assertCrossing();
 assert.match(await page.locator('#line-summary').innerText(),/year 7\./);
 await page.locator('#line-property').selectOption('second');
 await assertCrossing();
 await page.locator('#line-view').selectOption('equity');
 await assertCrossing();
 await page.locator('#ownership-form input[name=appreciation_pct]').fill('0');
 await assertCrossing();
});
regression('currency blur formats presentation without changing the assumption or derived outputs',async page=>{
 const input=page.locator('#ownership-form input[name=rent_psf]');
 await input.fill('24.005');
 const tables=page.locator('.ownership table');
 const before=await tables.allTextContents();
 assert.match(before[0],/84,017.50/);
 assert.match(before[0],/39,908.31/);
 await input.press('Tab');
 assert.deepEqual(await tables.allTextContents(),before);
 assert.equal(await input.inputValue(),'24.01');
 await input.focus();
 assert.equal(await input.inputValue(),'24.005');
 assert.equal(await page.locator('#assumption-rent_psf').inputValue(),'24.01');
 await page.locator('#assumption-rent_psf').focus();
 assert.equal(await page.locator('#assumption-rent_psf').inputValue(),'24.005');
 assert.deepEqual(await tables.allTextContents(),before);
});
