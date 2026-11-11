import test from 'node:test';
import assert from 'node:assert/strict';
import { componentDocument, chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { assertChartGaps } from '../scripts/prove-answer-chart-missing-value-gaps.mjs';

test('answer gaps and inspection transitions at phone and desktop widths in both themes',async t=>{
  const server=await fixtureServer();t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  for (const width of [390,1280]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`,async()=>{
    const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme});
    try {
      await componentDocument(page, server.origin);
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;const host=document.createElement('div');host.id='proof';host.className='turn-answer';document.body.replaceChildren(host);},theme);
      assert.equal((await assertChartGaps(page)).every(result=>result.passed),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    } finally {await page.close();}
  });
});
