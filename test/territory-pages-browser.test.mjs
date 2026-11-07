import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { territoryFixture } from './fixtures/territory-pages/fixture.mjs';
const assets = await uiAssets(path => readFile(path, 'utf8'));
async function setup(t, count) {
  const server = await startFixture({ routes: new Map([['/', { body: '<body></body>', contentType: 'text/html' }], ...[...assets].map(([p,body])=>['/'+p,{body,contentType:'text/javascript'}])]) });
  t.after(()=>server.close());
  const browser = await chromium.launch(); t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(server.origin);
  await page.evaluate(async response => {
    const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.js');
    window.calls=0; window.payload=response; window.failure=null; window.pending=null;
    const host=document.createElement('div'); document.body.append(host);
    window.view=mountTerritoryEvidence(host,{getTerritoryStateBoard:async()=>{window.calls++;if(window.failure)throw window.failure;return window.pending||window.payload;}},()=>{});
  }, territoryFixture(count));
  await page.getByText('Recorded territory conditions',{exact:true}).press('Enter');
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  await page.getByRole('status').first().waitFor();
  return page;
}
for (const count of [0,1,20,21,45]) test(`contract checked ${count} areas appear once in server order`,async t=>{
  const page=await setup(t,count), seen=[];
  for(let offset=0;offset<Math.max(1,count);offset+=20){
    const expected=territoryFixture(count).submarkets.slice(offset,offset+20).map(r=>`${r.city}, ${r.state}`);
    const actual=await page.locator('tbody th').allTextContents();assert.deepEqual(actual,expected);seen.push(...actual);
    assert.equal(await page.getByRole('status').first().textContent(),`Showing ${count?offset+1:0}–${Math.min(offset+20,count)} of ${count} matching loaded areas / ${count} total loaded areas`);
    if(offset+20<count)await page.getByRole('button',{name:'Next areas',exact:true}).press('Enter');
  }
  assert.equal(new Set(seen).size,count);assert.equal(await page.evaluate(()=>window.calls),1);
  if(count>20){await page.getByRole('button',{name:'Previous areas',exact:true}).press('Enter');assert.equal(await page.locator('tbody th').first().textContent(),`${territoryFixture(count).submarkets[Math.floor((count-1)/20)*20-20].city}, TX`);}
});
test('condition resets, evidence retains, refresh and clear reset, stale completion cannot resurrect',async t=>{
  const page=await setup(t,45), next=page.getByRole('button',{name:'Next areas',exact:true});
  await next.click(); await page.getByLabel('Evidence view',{exact:true}).selectOption('historical');
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0020, TX');
  await page.locator('select').first().selectOption('conflicting');
  assert.equal(await page.locator('tbody tr').count(),20);await next.click();
  assert.equal(await page.locator('tbody tr').count(),3);
  await page.getByRole('button',{name:'Refresh evidence',exact:true}).click();
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.locator('select').first().selectOption('all');await next.click();
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.pending=null;await window.view.refresh();release({...window.payload,submarkets:[]});await stale;});
  assert.equal(await page.locator('tbody tr').count(),20);
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.view.clear();release(window.payload);await stale;window.pending=null;});
  assert.equal(await page.locator('tbody tr').count(),0);
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await next.click();await page.evaluate(async()=>{window.failure={code:'unauthorized'};await window.view.refresh();window.failure=null;});
  assert.equal(await page.locator('tbody tr').count(),0);
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.locator('tbody summary').first().press('Enter');assert.equal(await page.locator('tbody details').first().getAttribute('open'),'');
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.view.dispose();release(window.payload);await stale;});
  assert.equal(await page.locator('.territory-evidence').count(),0);
});
test('empty condition, boundary guards, refusal, oversized payload and retry preserve limits',async t=>{
  const page=await setup(t,45),next=page.getByRole('button',{name:'Next areas',exact:true}),previous=page.getByRole('button',{name:'Previous areas',exact:true});
  await previous.dispatchEvent('click');assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await next.click();await next.click();await next.dispatchEvent('click');assert.equal(await page.locator('tbody tr').count(),5);
  await page.locator('select').first().selectOption('tight');
  assert.equal(await page.getByRole('status').first().textContent(),'Showing 0–0 of 0 matching loaded areas / 45 total loaded areas');
  await page.locator('select').first().selectOption('all');await next.click();
  await page.evaluate(async()=>{window.failure={code:'territory_board_limit_exceeded'};await window.view.refresh();window.failure=null;});
  assert.match(await page.getByRole('alert').textContent(),/no partial results/);assert.equal(await page.locator('tbody tr').count(),0);
  await page.evaluate(async()=>{const original=window.payload;window.payload={...original,submarkets:Array.from({length:1001},()=>original.submarkets[0])};await window.view.refresh();window.payload=original;});
  assert.equal(await page.getByRole('alert').textContent(),'Territory evidence unavailable. Refresh to try again.');assert.equal(await page.locator('tbody tr').count(),0);
  await page.getByRole('button',{name:'Refresh evidence',exact:true}).click();assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.evaluate(()=>window.view.dispose());
});
