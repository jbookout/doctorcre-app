import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { applyPhoneProfile, profile } from '../scripts/performance-scenarios.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';

const deal = '11111111-1111-4111-8111-111111111111';
const tour = '33333333-3333-4333-8333-333333333333';
const other = '22222222-2222-4222-8222-222222222222';
const created = '44444444-4444-4444-8444-444444444444';
const routeId = '55555555-5555-4555-8555-555555555555';
const row = {id:tour,deal_id:deal,deal_name:'Demo deal',name:'Demo deal tour',status:'draft'};

test('deal Tours lists, opens, starts and recovers on the fixture server', async t => {
  const artifact = await temporaryDirectory('doctorcre-deal-tours-', t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}}); t.after(() => server.stop());
  const browser = await chromium.launch({args:[...CHROMIUM_SAFETY_ARGS]}); t.after(() => browser.close());
  await mkdir(new URL('../out/test-artifacts/deal-tours/',import.meta.url),{recursive:true});
  for (const width of [390,1024,1440]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:1000}});
    const errors = [];
    try { page.on('pageerror',error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.route(/^https:\/\//, route => route.abort());
      const seed = JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)));
      await page.route('**/data/board-seed.json',route => route.fulfill({json:seed}));
      await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
      let mode = 'populated', hidden = false, write, notes = '', revision = 0, creates = 0;
      await page.route('**/api/tours/**',route => {
        const url = new URL(route.request().url());
        if(url.pathname === '/api/tours/library') {
          if(mode === 'outage') return route.fulfill({status:503,json:{error:'database private diagnostic'}});
          return route.fulfill({json:{data:{tours:mode === 'empty' ? [] : [row,{...row,id:other,deal_id:other,name:'Other deal tour'}]},csrf_token:'synthetic-session'}});
        }
        if(url.pathname === '/api/tours/create') {
          ++creates;
          write = route.request().postDataJSON();
          return route.fulfill({json:{data:{tour_id:created},csrf_token:'synthetic-session'}});
        }
        if(url.pathname === '/api/tours/cheat-sheet/autosave') {
          const body = route.request().postDataJSON();
          assert.equal(body.tour_id, tour); assert.equal(body.expected_revision_number, revision);
          notes = body.content.notes; ++revision;
          return route.fulfill({json:{data:{cheat_sheet_revision_id:created,revision_number:revision},csrf_token:'synthetic-session'}});
        }
        if(url.pathname === '/api/tours/detail') {
          if(hidden) return route.fulfill({status:404,json:{error:'tour_not_found'}});
          const newTour = url.searchParams.get('tour_id') === created;
          return route.fulfill({json:{data:{...row,id:newTour ? created : tour,name:newTour ? 'Demo newly bound tour' : row.name,
            cheat_sheet:revision ? {revision_number:revision,content:{notes}} : {},stops:[],routes:[{id:routeId,route_version:1,accepted:false,stops:[]}],route_version_id:routeId,
            route_version_state:'draft',accepted_route_version:0},csrf_token:'synthetic-session'}});
        }
        return route.fulfill({status:404,json:{error:'not_found'}});
      });
      await page.goto(`${server.url}/deals`);
      await page.locator(`.card-open[data-open="${deal}"]:visible`).waitFor();
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}-board.png`,import.meta.url).pathname,fullPage:true});
      await page.locator(`.card-open[data-open="${deal}"]:visible`).click();
      await page.getByRole('tab',{name:'Tours',exact:true}).click();
      await page.locator('[data-open-tour]').waitFor({timeout:10000});
      assert.equal(await page.locator('[data-open-tour]').count(),1);
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}-list.png`,import.meta.url).pathname,fullPage:true});
      assert.doesNotMatch(await page.locator('#workspace-tours').textContent(),/Other deal tour/);
      await page.locator('[data-open-tour]').click();
      const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
      await editor.locator('#tour-name').filter({hasText:row.name}).waitFor();
      assert.ok(page.url().includes('/deals?'));
      await page.goBack();
      await page.locator('[data-open-tour]').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('tab'),'tours');
      await page.locator('[data-open-tour]').click();
      await editor.locator('#tour-name').filter({hasText:row.name}).waitFor();
      await editor.getByText('Hard-copy packet',{exact:true}).waitFor();
      await editor.locator('#cheat-content').fill('Synthetic workspace edit');
      await editor.locator('#save-sheet').click();
      await editor.locator('#sheet-state').filter({hasText:/save confirmed/}).waitFor();
      assert.equal(notes,'Synthetic workspace edit');
      const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js',import.meta.url),'utf8');
      const scans = [];
      for (const frame of page.frames()) {
        await frame.evaluate(axeSource);
        scans.push({url:frame.url(),violations:await frame.evaluate(async () => (await window.axe.run(document)).violations.map(v => ({id:v.id,nodes:v.nodes.map(n => n.target)})))});
      }
      await writeFile(new URL(`../out/test-artifacts/deal-tours/axe-${width}-${theme}.json`,import.meta.url),JSON.stringify(scans,null,2));
      for (const scan of scans) assert.deepEqual(scan.violations,[],scan.url);
      await page.evaluate(() => scrollTo(0,0));
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}.png`,import.meta.url).pathname,fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      await page.locator('[data-back-tours]').click();
      hidden = true; await page.locator('[data-open-tour]').click();
      await page.getByText('Tour not available.',{exact:false}).waitFor();
      assert.equal(await page.locator('iframe').count(),0);
      hidden = false; mode = 'empty'; await page.locator('[data-refresh-tours]').click();
      await page.getByText('No tours for this deal.',{exact:false}).waitFor();
      mode = 'outage'; await page.locator('[data-refresh-tours]').click();
      await page.getByText('Tours unavailable.',{exact:false}).waitFor();
      assert.doesNotMatch(await page.locator('#workspace-tours').textContent(),/database private/);
      mode = 'populated'; await page.locator('[data-refresh-tours]').click(); await page.locator('[data-open-tour]').waitFor({timeout:10000});
      await page.locator('[data-start-tour]').click();
      await editor.locator('#create-tour:enabled').waitFor();
      assert.equal(await editor.locator('html').getAttribute('data-theme'),await page.locator('html').getAttribute('data-theme'));
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}-creating.png`,import.meta.url).pathname,fullPage:true});
      assert.equal(await editor.locator('#create-subject-type').inputValue(),'deal');
      assert.equal(await editor.locator('#create-subject-id').inputValue(),deal);
      await editor.locator('#create-tour-name').fill('Demo newly bound tour');
      await editor.locator('#create-dataset').fill('synthetic-v1');
      for(const role of ['start','end']) {
        await editor.locator(`#${role}-latitude`).fill('30.5'); await editor.locator(`#${role}-longitude`).fill('-87.2');
        await editor.locator(`#${role}-source`).fill(`fixture:${role}`);
      }
      await editor.locator('#create-tour').click();
      await editor.locator('#tour-name').filter({hasText:'Demo newly bound tour'}).waitFor();
      await page.waitForURL(url => url.searchParams.get('tour') === created);
      assert.equal(write.subject_type,'deal'); assert.equal(write.subject_id,deal);
      await page.evaluate(() => scrollTo(0,0));
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-tours/${width}-${theme}-created.png`,import.meta.url).pathname,fullPage:true});
      await page.goto(`${server.url}/tours`);
      await page.locator(`a[href="/deals?deal=${deal}&tab=tours&tour=${tour}"]`).waitFor({state:'attached'});
      assert.equal(await page.locator('#plan-form').count(),0);
      await page.locator(`a[href="/deals?deal=${deal}&tab=tours&tour=${tour}"]`).click();
      await editor.locator('#tour-name').filter({hasText:row.name}).waitFor();
      await page.goto(`${server.url}/tours/route-editor.html?tour=${tour}`);
      await page.waitForURL(url => url.pathname === '/deals' && url.searchParams.get('tour') === tour);
      await editor.locator('#tour-name').filter({hasText:row.name}).waitFor();
      await page.goto(`${server.url}/tours/route-editor.html`);
      assert.equal(await page.locator('#create-tour-panel').isHidden(),true);
      await page.locator('#create-tour-form').dispatchEvent('submit');
      await page.getByText('Open a deal workspace to create a tour.',{exact:true}).waitFor();
      assert.equal(creates,1);
      assert.deepEqual(errors,[]);
    } catch (error) { console.error('tour fixture failure', width, theme, page.url(), await page.locator('#workspace-tours').textContent().catch(() => ''), await Promise.all(page.frames().map(async f => [f.url(), await f.locator('body').innerText().catch(() => '')])), errors); throw error; }
    finally { await page.close(); }
  });
  if (process.env.DOCTORCRE_PERF_BASELINE_SITE) await t.test('phone deal workspace LCP compared with main in alternating runs', async () => {
    await readFile(process.env.DOCTORCRE_PERF_BASELINE_SITE+'/pipeline.html');
    const baseline = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:process.env.DOCTORCRE_PERF_BASELINE_SITE}});
    try {
      const samples = {main:[],head:[]};
      for (let run=0;run<5;run++) for (const [side,url] of [['main',baseline.url],['head',server.url]]) {
        const context = await browser.newContext({viewport:profile.viewport,isMobile:true,hasTouch:true,serviceWorkers:'block'});
        const page = await context.newPage(); const errors=[];
        await page.route('**/data/board-seed.json',route => route.fulfill({path:fileURLToPath(new URL('../data/board-seed.json',import.meta.url)),contentType:'application/json'}));
        await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
        page.on('pageerror',error => errors.push(error.message));
        await applyPhoneProfile(context,page);
        await page.addInitScript(() => {
          window.__tourLcp = 0;
          new PerformanceObserver(entries => { window.__tourLcp = entries.getEntries().at(-1).startTime; }).observe({type:'largest-contentful-paint',buffered:true});
        });
        await page.goto(url+'/deals',{waitUntil:'networkidle'});
        await page.locator('.kanban-card[data-id="d14"]').first().waitFor();
        samples[side].push(await page.evaluate(() => window.__tourLcp));
        assert.deepEqual(errors,[]); await context.close();
      }
      await writeFile(new URL('../out/test-artifacts/deal-tours/phone-lcp.json',import.meta.url),JSON.stringify(samples,null,2));
      t.diagnostic(JSON.stringify(samples));
    } finally { await baseline.stop(); }
  });
});

test('tour departure and pending Open preserve the active editor', async t => {
  const artifact = await temporaryDirectory('doctorcre-tour-departure-', t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}}); t.after(() => server.stop());
  const browser = await chromium.launch({args:[...CHROMIUM_SAFETY_ARGS]}); t.after(() => browser.close());
  for (const width of [390,1440]) for (const theme of ['light','dark']) {
    for (const scenario of ['dirty departure','late success','late rejection']) await t.test(`${width} ${theme} ${scenario}`, async () => {
      const page = await browser.newPage({viewport:{width,height:1000}});
      try {
        await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
        await page.route(/^https:\/\//,route => route.abort());
        const seed = JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)));
        await page.route('**/data/board-seed.json',route => route.fulfill({json:seed}));
        await page.route('**/auth/session',route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
        let release, held = false;
        const gate = new Promise(resolve => { release = resolve; });
        const properties = [created,other].map((property_id,index) => ({property_id,name:`Synthetic property ${index+1}`,address:`${index+1} Clinic Way`,county:'Escambia'}));
        await page.route('**/api/tours/**',async route => {
          const path = new URL(route.request().url()).pathname;
          if(path === '/api/tours/library') return route.fulfill({json:{data:{tours:[row]},csrf_token:'synthetic-session'}});
          if(path === '/api/tours/properties/search') return route.fulfill({json:{data:{search:{items:properties,count:2,has_more:false}},csrf_token:'synthetic-session'}});
          if(path === '/api/tours/detail') {
            if(scenario !== 'dirty departure' && !held) {
              held = true; await gate;
              if(scenario === 'late rejection') return route.fulfill({status:503,json:{error:'unavailable'}});
            }
            return route.fulfill({json:{data:{...row,stops:[],routes:[{id:routeId,route_version:1,accepted:false,stops:[]}],route_version_id:routeId,route_version_state:'draft',accepted_route_version:0},csrf_token:'synthetic-session'}});
          }
          return route.fulfill({status:404,json:{error:'not_found'}});
        });
        await page.goto(`${server.url}/deals?deal=${deal}&tab=tours`);
        await page.locator('[data-open-tour]').click();
        const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
        if(scenario !== 'dirty departure') {
          await page.getByText('Opening tour…',{exact:true}).waitFor();
          await page.locator('[data-start-tour]').click();
          await editor.locator('#create-tour:enabled').waitFor();
          await editor.locator('#create-tour-name').fill('New draft while prior tour opens');
          const response = page.waitForResponse(response => response.url().includes('/api/tours/detail'));
          release(); await response;
          await page.waitForLoadState('networkidle');
          assert.equal(await editor.locator('#create-tour-name').inputValue(),'New draft while prior tour opens');
          assert.equal(new URL(page.url()).searchParams.get('tour'),'new');
          assert.equal(await page.locator('iframe').count(),1);
        } else {
          await editor.locator('#tour-name').filter({hasText:row.name}).waitFor();
          await editor.locator('#property-search-form').evaluate(form => form.requestSubmit());
          await editor.getByRole('button',{name:'Add to selection',exact:true}).first().click();
          await editor.getByRole('button',{name:'Add to selection',exact:true}).click();
          await editor.locator('#add-cart-stops').click();
          await editor.locator('#route-stops li').nth(1).getByRole('button',{name:'Up',exact:true}).click();
          const order = () => editor.locator('#route-stops > li').evaluateAll(rows => rows.map(row => row.dataset.propertyId));
          assert.deepEqual(await order(),[other,created]);
          const editorUrl = page.url();
          await page.goBack();
          const prompt = page.getByRole('dialog',{name:'Leave this tour?'});
          await prompt.waitFor({timeout:3000});
          await prompt.getByRole('button',{name:'Keep editing',exact:true}).click();
          await page.waitForURL(editorUrl);
          assert.deepEqual(await order(),[other,created]);
          assert.match(await editor.locator('#selection-list').textContent(),/Synthetic property 1.*Synthetic property 2/s);
          await page.locator('#panelClose').click();
          await prompt.getByRole('button',{name:'Keep editing',exact:true}).click();
          assert.deepEqual(await order(),[other,created]);
          await page.locator('[data-back-tours]').click();
          await prompt.getByRole('button',{name:'Keep editing',exact:true}).click();
          assert.deepEqual(await order(),[other,created]);
          await page.goBack();
          await prompt.getByRole('button',{name:'Leave tour',exact:true}).click();
          await page.locator('[data-open-tour]').waitFor();
          assert.equal(new URL(page.url()).searchParams.has('tour'),false);
        }
      } finally { await page.close(); }
    });
  }
});
