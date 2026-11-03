import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';

const deal = '11111111-1111-4111-8111-111111111111';
const tour = '33333333-3333-4333-8333-333333333333';
const other = '22222222-2222-4222-8222-222222222222';
const created = '44444444-4444-4444-8444-444444444444';
const routeId = '55555555-5555-4555-8555-555555555555';
const row = {id:tour,deal_id:deal,deal_name:'Demo deal',name:'Demo deal tour',status:'draft'};
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url)), 'src/ui/deal-tours.tsx');

test('deal Tours lists, opens, starts and recovers on the fixture server', async t => {
  const server = await startFixtureServer(); t.after(() => server.stop());
  const browser = await chromium.launch({args:[...CHROMIUM_SAFETY_ARGS]}); t.after(() => browser.close());
  await mkdir(new URL('../out/test-artifacts/deal-tours/',import.meta.url),{recursive:true});
  for (const width of [390,1024,1440]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:1000}});
    try {
      const errors = []; page.on('pageerror',error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.route(/^https:\/\//, route => route.abort());
      const seed = JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)));
      await page.route('**/data/board-seed.json',route => route.fulfill({json:seed}));
      // PR 642 owns bundle registration. Exercise this island without changing its files.
      await page.route('**/js/ui-deal-tours.js',route => route.fulfill({body:bundle,contentType:'text/javascript'}));
      await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
      let mode = 'populated', hidden = false, write;
      await page.route('**/api/tours/**',route => {
        const url = new URL(route.request().url());
        if(url.pathname === '/api/tours/library') {
          if(mode === 'outage') return route.fulfill({status:503,json:{error:'database private diagnostic'}});
          return route.fulfill({json:{data:{tours:mode === 'empty' ? [] : [row,{...row,id:other,deal_id:other,name:'Other deal tour'}]},csrf_token:'synthetic-session'}});
        }
        if(url.pathname === '/api/tours/create') {
          write = route.request().postDataJSON();
          return route.fulfill({json:{data:{tour_id:created},csrf_token:'synthetic-session'}});
        }
        if(url.pathname === '/api/tours/detail') {
          if(hidden) return route.fulfill({status:404,json:{error:'tour_not_found'}});
          const newTour = url.searchParams.get('tour_id') === created;
          return route.fulfill({json:{data:{...row,id:newTour ? created : tour,name:newTour ? 'Demo newly bound tour' : row.name,
            stops:[],routes:[{id:routeId,route_version:1,accepted:false,stops:[]}],route_version_id:routeId,
            route_version_state:'draft',accepted_route_version:0},csrf_token:'synthetic-session'}});
        }
        return route.fulfill({status:404,json:{error:'not_found'}});
      });
      await page.goto(`${server.url}/deals?deal=${deal}`);
      await page.getByRole('tab',{name:'Tours',exact:true}).click();
      await page.locator('[data-open-tour]').waitFor();
      assert.equal(await page.locator('[data-open-tour]').count(),1);
      assert.doesNotMatch(await page.locator('#workspace-tours').textContent(),/Other deal tour/);
      await page.locator('[data-open-tour]').click();
      await page.locator('[data-edit-tour]').waitFor();
      assert.match(await page.locator('[data-edit-tour]').getAttribute('href'),new RegExp(`tour=${tour}&deal=${deal}`));
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}.png`,import.meta.url).pathname});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      hidden = true; await page.locator('[data-open-tour]').click();
      await page.getByText('Tour not available.',{exact:false}).waitFor();
      assert.equal(await page.locator('[data-edit-tour]').count(),0);
      hidden = false; mode = 'empty'; await page.locator('[data-refresh-tours]').click();
      await page.getByText('No tours for this deal.',{exact:false}).waitFor();
      mode = 'outage'; await page.locator('[data-refresh-tours]').click();
      await page.getByText('Tours unavailable.',{exact:false}).waitFor();
      assert.doesNotMatch(await page.locator('#workspace-tours').textContent(),/database private/);
      mode = 'populated'; await page.locator('[data-refresh-tours]').click(); await page.locator('[data-open-tour]').waitFor();
      await page.locator('[data-start-tour]').click();
      await page.waitForFunction(() => document.querySelector('#create-subject-type').disabled && !document.querySelector('#create-tour').disabled);
      assert.equal(await page.locator('#create-subject-type').inputValue(),'deal');
      assert.equal(await page.locator('#create-subject-id').inputValue(),deal);
      await page.locator('#create-tour-name').fill('Demo newly bound tour');
      await page.locator('#create-dataset').fill('synthetic-v1');
      for(const role of ['start','end']) {
        await page.locator(`#${role}-latitude`).fill('30.5'); await page.locator(`#${role}-longitude`).fill('-87.2');
        await page.locator(`#${role}-source`).fill(`fixture:${role}`);
      }
      await page.locator('#create-tour').click();
      await page.waitForFunction(() => document.querySelector('#tour-name').textContent === 'Demo newly bound tour');
      assert.equal(write.subject_type,'deal'); assert.equal(write.subject_id,deal);
      await page.goto(`${server.url}/tours`);
      await page.locator(`a[href="/deals?deal=${deal}&tab=tours&tour=${tour}"]`).waitFor({state:'attached'});
      assert.equal(await page.locator(`a[href="/deals?deal=${deal}&tab=tours&tour=${tour}"]`).textContent(),'Demo deal');
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  });
});
