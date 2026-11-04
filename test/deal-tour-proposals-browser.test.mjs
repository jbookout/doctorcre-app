import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {uiBundle} from '../scripts/ui-bundle.mjs';
import {buildArtifact} from '../scripts/artifact.mjs';
import {temporaryDirectory} from '../scripts/temp-directory.mjs';
import {startFixtureServer} from '../scripts/fixture-server.mjs';
import {chromium} from './browser-harness.mjs';
import {CHROMIUM_SAFETY_ARGS} from '../scripts/chromium-safety-args.mjs';
const deal='11111111-1111-4111-8111-111111111111';
test('proposal workspace comparison at phone and desktop in both themes',async t=>{
  const artifact=await temporaryDirectory('doctorcre-tour-proposals-',t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server=await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}});t.after(()=>server.stop());
  const browser=await chromium.launch({args:CHROMIUM_SAFETY_ARGS});t.after(()=>browser.close());
  const bundle=await uiBundle(path=>readFile(new URL('../'+path,import.meta.url),'utf8'));
  const out=new URL('../out/test-artifacts/deal-tour-proposals/',import.meta.url);await mkdir(out,{recursive:true});
  for(const width of [390,1440]) for(const theme of ['light','dark']) await t.test(`${width} ${theme}`,async()=>{
    const page=await browser.newPage({viewport:{width,height:1000}});
    try {
      await page.route(/^https:\/\//,route=>route.abort());
      const seed=JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)));
      await page.route('**/data/board-seed.json',route=>route.fulfill({json:seed}));
      await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.goto(`${server.url}/deals`);
      await page.locator(`.card-open[data-open="${deal}"]:visible`).click();
      await page.locator('#workspace-tour-proposals .deal-tour-proposals').waitFor({state:'attached'});
      await page.evaluate(async({code,deal})=>{
        const ui=await import('data:text/javascript;base64,'+code);
        const live=await import('/js/ui-deal-tour-proposals.js');
        window.proposalsFixture=ui.createTourProposalFixture(deal);
        const element=document.createElement('div');
        document.querySelector('#workspace-tour-proposals').replaceChildren(element);
        window.proposalsPanel=await live.bootDealTourProposals(element,{dealId:deal,mode:'fixture',client:window.proposalsFixture.client});
      },{code:bundle.toString('base64'),deal});
      await page.locator('[data-compare]').click();
      await page.getByText('Demo addition',{exact:true}).waitFor();
      const region=page.locator('.deal-tour-proposals:has([data-use-theirs])');
      for(const label of ['Added','Removed','Unchanged']) assert.match(await region.textContent(),new RegExp(label));
      assert.ok(await page.locator('#tab-tours [data-tour-proposal-badge]').count());
      await page.locator('[data-use-theirs]').click();
      assert.equal(await page.evaluate(()=>window.proposalsFixture.writes.length),0);
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:new URL(`${width}-${theme}-comparison.png`,out).pathname,fullPage:true});
      await page.locator('[data-accept-proposal]').click();
      await page.getByText('Shortlist confirmed',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.proposalsFixture.writes.length),1);
      assert.equal(await page.locator('#tab-tours [data-tour-proposal-badge]').count(),0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:new URL(`${width}-${theme}-accepted.png`,out).pathname,fullPage:true});
      await writeFile(new URL(`${width}-${theme}-receipt.json`,out),JSON.stringify(await page.evaluate(()=>({writes:window.proposalsFixture.writes,shortlist:window.proposalsFixture.shortlist()})),null,2));
    } catch(error) {await page.screenshot({path:new URL(`${width}-${theme}-failure.png`,out).pathname,fullPage:true}); throw error;} finally {await page.close();}
  });
});
