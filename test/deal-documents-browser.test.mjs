import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { componentDocument, chromium } from './browser-harness.mjs';

const deal = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const document = { id, display_name: 'Demo email LOI.pdf', document_type: 'application/pdf', page_count: null, content_hash: 'a'.repeat(64), stored_at: '2026-01-01T00:00:00Z' };
const result = (documents, has_more = false, next_cursor = null) => ({ ok: true, schema_version: 'deal-documents.v1', documents, has_more, next_cursor });

test('Documents shows a canonical email PDF and follows the panel statechart', async t => {
  const artifact = await temporaryDirectory('doctorcre-documents-', t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}}); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const fixture = (await readFile(new URL('../data/fixtures/fact-review.mjs',import.meta.url),'utf8')).replaceAll("'d14'", JSON.stringify(deal))
    .replace(/async listDealDocuments\([^\n]+/, `async listDealDocuments(args) { const response = await fetch('/fixture-documents', {method:'POST',body:JSON.stringify(args)}); if (!response.ok) throw Object.assign(new Error('private diagnostic'),{status:response.status}); return response.json(); },`);
  const seed = JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)).replaceAll('"d15"',JSON.stringify(other)));
  seed.deals.push({...seed.deals.find(row => row.id === deal),id:other,name:'Demo other deal'});
  await mkdir(new URL('../out/test-artifacts/deal-documents/',import.meta.url),{recursive:true});
  for (const width of [390,1440]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:1000}});
    try {
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.route('**/data/board-seed.json',route => route.fulfill({json:seed}));
      await page.route('**/data/fixtures/fact-review.mjs',route => route.fulfill({body:fixture,contentType:'text/javascript'}));
      let mode = 'ready', held, requested;
      const requests = [];
      await page.route('**/fixture-documents',async route => {
        const args = route.request().postDataJSON();
        if (args.limit !== 50) return route.fulfill({json:result([])});
        requests.push(args);
        if (mode === 'held') { held = () => route.fulfill({json:result([document])}).catch(() => {}); requested?.(); return; }
        if (mode === 'outage' || mode === 'expired') return route.fulfill({status:mode === 'expired' ? 401 : 503,json:{error:'private diagnostic'}});
        if (mode === 'malformed') return route.fulfill({json:result([{...document,content_hash:'bad'}])});
        if (mode === 'empty' || args.deal_id === other) return route.fulfill({json:result([])});
        const row = !args.cursor ? document : {
          ...document,
          id:args.cursor === 'page-2' ? other : '44444444-4444-4444-8444-444444444444',
          display_name:args.cursor === 'page-2' ? 'Demo site plan.pdf' : 'Demo rejected page.pdf',
        };
        return route.fulfill({json:result([row],true,args.cursor ? 'page-3' : 'page-2')});
      });
      await page.goto(`${server.url}/deals?deal=${deal}`);
      await page.getByRole('tab',{name:'Documents',exact:true}).click({timeout:3000});
      const panel = page.getByRole('region',{name:'Deal documents',exact:true});
      await panel.getByText(document.display_name,{exact:true}).waitFor();
      assert.equal(await panel.locator(`[data-document-id="${id}"]`).getAttribute('data-content-hash'),document.content_hash);
      assert.equal(await panel.getByRole('link').count(),0);
      assert.equal(requests.at(-1).limit,50);
      await page.screenshot({path:new URL(`../out/test-artifacts/deal-documents/${width}-${theme}.png`,import.meta.url).pathname});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      await panel.getByRole('button',{name:'Load more documents'}).click();
      await panel.getByText('Demo site plan.pdf',{exact:true}).waitFor();
      assert.equal(requests.at(-1).cursor,'page-2');
      await panel.getByRole('button',{name:'Load more documents'}).click();
      await panel.getByText('Documents unavailable.',{exact:false}).waitFor();
      assert.equal(await panel.locator('[data-document-id]').count(),2);
      assert.equal(await panel.getByText('Demo rejected page.pdf',{exact:true}).count(),0);
      mode = 'empty'; await panel.getByRole('button',{name:'Refresh documents'}).click();
      await panel.getByText('No documents filed for this deal.',{exact:true}).waitFor();
      mode = 'outage'; await panel.getByRole('button',{name:'Refresh documents'}).click();
      await panel.getByText('Documents unavailable.',{exact:false}).waitFor();
      assert.doesNotMatch(await panel.textContent(),/private diagnostic/);
      mode = 'ready'; await panel.getByRole('button',{name:'Retry documents'}).click();
      await panel.getByText(document.display_name,{exact:true}).waitFor();
      mode = 'malformed'; await panel.getByRole('button',{name:'Refresh documents'}).click();
      await panel.getByText('Documents unavailable.',{exact:false}).waitFor();
      assert.equal(await panel.getByText(document.display_name,{exact:true}).count(),1);
      assert.equal(await panel.locator(`[data-document-id="${id}"]`).getAttribute('data-content-hash'),document.content_hash);
      await panel.getByText('Last successful read. Documents may be out of date.',{exact:true}).waitFor();
      mode = 'held'; const started = new Promise(resolve => { requested = resolve; });
      await panel.getByRole('button',{name:'Retry documents'}).click(); await started;
      await panel.getByText('Loading documents…',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Back to deals',exact:true}).click();
      mode = 'empty';
      await page.locator(`.kanban-column [data-id="${other}"] .card-open`).click();
      await page.getByRole('tab',{name:'Documents',exact:true}).click();
      mode = 'empty'; await held();
      await panel.getByText('No documents filed for this deal.',{exact:true}).waitFor();
      assert.equal(await page.getByText(document.display_name,{exact:true}).count(),0);
      mode = 'expired';
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      await page.getByText('Session expired. Sign in again to view documents.',{exact:true}).waitFor();
      assert.equal(await page.locator('[data-document-id]').count(),0);
      await page.goto(`${server.url}/deals?deal=${deal}`);
      await page.getByRole('tab',{name:'Documents',exact:true}).click();
      await page.getByText('Session expired. Sign in again to view documents.',{exact:true}).waitFor();
      assert.equal(await page.locator('[data-document-id]').count(),0);
      await componentDocument(page, server.url, {owner:'documents cap', dispose: page => page.evaluate(() => window.documentCap?.dispose())});
      await page.evaluate(async document => {
        const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
        const target = window.document.createElement('div'); window.document.body.append(target);
        let offset = 0;
        window.documentCap = mountDealDocuments(target, {dealId: '11111111-1111-4111-8111-111111111111', client: {
          async listDealDocuments(args) {
            if (args.limit !== 50) throw Error('Unbounded page');
            const documents = Array.from({length:49},() => ({...document,id:`00000000-0000-4000-8000-${String(++offset).padStart(12,'0')}`}));
            return {ok:true,schema_version:'deal-documents.v1',documents,has_more:true,next_cursor:String(offset)};
          },
        }});
      },document);
      const cap = page.getByRole('region',{name:'Deal documents',exact:true}).last();
      for (let count = 49; count < 500; count += 49) {
        await page.waitForFunction(count => window.document.querySelectorAll('[data-document-id]').length === count,count);
        await cap.getByRole('button',{name:'Load more documents'}).focus();
        await page.keyboard.press('Enter');
      }
      await cap.getByText('Showing the first 500 documents. Refresh to start again.',{exact:true}).waitFor();
      assert.equal(await cap.locator('[data-document-id]').count(),500);
      assert.equal(await cap.getByRole('button',{name:'Load more documents'}).count(),0);
      await page.evaluate(() => window.documentCap.dispose());
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  });
});

test('Documents retries next pages and clears or disposes every in-flight state', async t => {
  const artifact = await temporaryDirectory('doctorcre-documents-lifecycle-', t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}}); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390,1440]) for (const theme of ['light','dark']) {
    for (const scenario of ['retry next page','expire ready','expire loading','expire loading more','expire unavailable','dispose loading more']) {
      await t.test(`${scenario} ${width} ${theme}`, async () => {
        const page = await browser.newPage({viewport:{width,height:1000}});
        try {
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
          await componentDocument(page, server.url, {owner:'documents lifecycle', dispose: page => page.evaluate(() => window.documentsTest?.panel.dispose())});
          await page.evaluate(async ({deal,document}) => {
            const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
            const target = window.document.createElement('div');
            window.document.body.replaceChildren(target);
            const pending = [], requests = [];
            const panel = mountDealDocuments(target,{dealId:deal,client:{
              listDealDocuments(args,{signal}) {
                requests.push(args);
                return new Promise((resolve,reject) => pending.push({resolve,reject,signal}));
              },
            }});
            window.documentsTest = {
              requests, panel,
              resolve(next = 'page-2') {
                pending.shift().resolve({ok:true,schema_version:'deal-documents.v1',documents:[{...document,id:requests.length === 1 ? document.id : '44444444-4444-4444-8444-444444444444'}],has_more:next !== null,next_cursor:next});
              },
              reject() { pending.shift().reject(new Error('Synthetic outage')); },
              aborted() { return pending[0].signal.aborted; },
            };
          },{deal,document});
          const panel = page.getByRole('region',{name:'Deal documents',exact:true});
          const rows = panel.locator('[data-document-id]');
          await panel.getByText('Loading documents…',{exact:true}).waitFor();
          if (scenario !== 'expire loading') {
            await page.evaluate(() => window.documentsTest.resolve());
            await rows.first().waitFor();
            assert.equal(await rows.count(),1);
          }
          if (!['expire ready','expire loading'].includes(scenario)) {
            await panel.getByRole('button',{name:'Load more documents'}).click();
            await panel.getByText('Loading documents…',{exact:true}).waitFor();
            assert.equal(await rows.count(),1);
          }
          if (['retry next page','expire unavailable'].includes(scenario)) {
            await page.evaluate(() => window.documentsTest.reject());
            await panel.getByText('Documents unavailable.',{exact:false}).waitFor();
            assert.equal(await rows.count(),1);
          }
          if (scenario === 'retry next page') {
            await panel.getByRole('button',{name:'Retry documents'}).click();
            await panel.getByText('Loading documents…',{exact:true}).waitFor();
            assert.equal(await rows.count(),1);
            assert.deepEqual(await page.evaluate(() => window.documentsTest.requests),[
              {deal_id:deal,limit:50},{deal_id:deal,limit:50,cursor:'page-2'},{deal_id:deal,limit:50,cursor:'page-2'},
            ]);
            await page.evaluate(() => window.documentsTest.resolve(null));
            await page.waitForFunction(() => document.querySelectorAll('[data-document-id]').length === 2);
            assert.equal(await panel.getByRole('button',{name:'Load more documents'}).count(),0);
          } else {
            if (scenario === 'dispose loading more') {
              await page.evaluate(() => window.documentsTest.panel.dispose());
              assert.equal(await page.getByRole('region',{name:'Deal documents',exact:true}).count(),0);
            } else {
              await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
              await panel.getByText('Session expired. Sign in again to view documents.',{exact:true}).waitFor();
              assert.equal(await rows.count(),0);
              assert.equal(await panel.getByRole('button').count(),0);
            }
            if (['expire loading','expire loading more','dispose loading more'].includes(scenario)) {
              assert.equal(await page.evaluate(() => window.documentsTest.aborted()),true);
              await page.evaluate(async () => {
                window.documentsTest.resolve(null);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              });
              assert.equal(await page.locator('[data-document-id]').count(),0);
              if (scenario !== 'dispose loading more') await panel.getByText('Session expired. Sign in again to view documents.',{exact:true}).waitFor();
              else assert.equal(await page.getByRole('region',{name:'Deal documents',exact:true}).count(),0);
            }
          }
          await page.evaluate(() => window.documentsTest.panel.dispose());
          assert.deepEqual(errors,[]);
        } finally { await page.close(); }
      });
    }
  }
});
