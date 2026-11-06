import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from './browser-harness.mjs';
import {routeLeads} from './leads-browser-fixture.mjs';
import {practiceOriginationFixture} from '../data/fixtures/practice-origination.mjs';
import {exerciseSourceFilter} from '../scripts/prove-contact-reasons-source-filter.mjs';

for(const width of [390,1280]) for(const theme of ['light','dark']) test(`source filter lifecycle ${width}px ${theme}`,async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme});
  await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme,walkthroughSeen:{'example-partner':true}})),theme);
  let reads=0;
  await routeLeads(page,{getReasons:()=>{reads++;return practiceOriginationFixture();}});
  await page.goto('http://localhost/leads');
  const full=page.locator('#contactReasons');
  await full.getByLabel('Source',{exact:true}).waitFor();
  await full.getByLabel('Source',{exact:true}).selectOption('pecos');
  assert.equal(reads,1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const assertions=await exerciseSourceFilter(page,'http://localhost/js/contact-reasons.mjs');
  assert.equal(assertions.length,9);
  await page.goto('http://localhost/review-workflows');
  assert.equal(await page.locator('#homeContactReasons').getByRole('combobox').count(),0);
});
