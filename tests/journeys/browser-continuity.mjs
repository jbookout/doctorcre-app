import assert from 'node:assert/strict';
import { retainDraftThroughRefresh, assertFocusRoundTrip, assertFitsViewport, waitForAsync, animationsSettled } from '../../test/browser-harness.mjs';

export async function exerciseContinuity(page, origin) {
  await page.goto(`${origin}/deals`);
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  await page.locator('.kanban-card[data-id="d14"]').click();
  const field='#detailNextForm textarea';
  await page.locator(field).fill('Demo unsaved draft '+ 'long supported text '.repeat(20));
  await page.locator(field).focus();
  await page.locator(field).evaluate(el => el.setSelectionRange(7,19,'backward'));
  await page.evaluate(async () => {
    const {state}=await import('/js/pipeline.js'); const get=state.client.getDeal.bind(state.client);
    state.client.getDeal=async (...args) => {const detail=await get(...args);return {...detail,deal:{...detail.deal,name:'Demo '+ 'long-name'.repeat(25),next_step:'Demo polling changed the stored next step'}};};
  });
  await retainDraftThroughRefresh(page,field,async()=>{
    await page.evaluate(()=>dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.querySelector('.detail-next')?.textContent==='Demo polling changed the stored next step');
  });
  await assertFocusRoundTrip(page,'[data-add-date="rent_start"]',()=>page.locator('[data-add-date="rent_start"]').click(),()=>page.keyboard.press('Escape'));
  assert.equal(await page.locator('#recordPanel').evaluate(el=>el.open),true,'closing a nested dialog keeps its parent open');
  await animationsSettled(page);
  await assertFitsViewport(page,['#recordPanel']);
  await page.getByLabel('Close deal',{exact:true}).click();
  assert.equal(await page.locator('.kanban-card[data-id="d14"]').evaluate(el=>document.activeElement===el),true,'outer close returns to the current card after polling');
}

export async function exerciseReload(page, origin, {dropWrite=false}={}) {
  await page.route(/\/api\/(tours|v1\/business)\//,route=>{
    const path=new URL(route.request().url()).pathname;
    const data=path==='/api/tours/library'?{tours:[]}:path==='/api/v1/business/clients'?{rows:[],page:1,page_count:1}:{};
    return route.fulfill({json:{data,csrf_token:'synthetic-proof-only'}});
  });
  await page.goto(`${origin}/tours`);
  await page.waitForFunction(()=>document.querySelector('#upcoming-tours .empty-library')?.textContent==='No upcoming tours');
  if(dropWrite) await page.evaluate(()=>{Storage.prototype.setItem=function() {};});
  const value='Demo persisted draft with ground floor and accessible entry';
  await page.locator('#space-requirements').fill(value);
  await page.locator('#space-area').fill('Demo market');
  await page.locator('#save-search').click();
  await page.waitForFunction(()=>document.querySelector('#space-message')?.textContent.toLowerCase().includes('saved'));
  const written=await page.locator('#space-requirements').inputValue();
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#upcoming-tours .empty-library')?.textContent==='No upcoming tours');
  const readback=await page.locator('#space-requirements').inputValue();
  assert.equal(readback,written,'draft missing after independent reload despite saved confirmation');
  return {written,readback};
}
