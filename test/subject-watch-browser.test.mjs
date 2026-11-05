import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
const fixture = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/subject-watch.fixture.json',import.meta.url),'utf8'));
const deal = fixture.write_request.arguments.subject_id;

test('Workspace watch follows the statechart in both themes and widths', async t => {
  const artifact = await temporaryDirectory('doctorcre-watch-',t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}}); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const client = (await readFile(new URL('../js/fixture-client.js',import.meta.url),'utf8')).replace('async listDealDocuments(args)', `async readSubjectWatch(args) { return watchRpc('read',args); },
    async watchSubject(args) { return watchRpc('watch',args); },
    async unwatchSubject(args) { return watchRpc('unwatch',args); },
    async listDealDocuments(args)`);
  const injected = `async function watchRpc(verb,args) { const r = await fetch('/fixture-watch',{method:'POST',body:JSON.stringify({verb,args})}); if (!r.ok) throw Object.assign(new Error('private diagnostic'),{status:r.status}); return r.json(); }\n${client}`;
  const seed = JSON.parse((await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8')).replaceAll('"d14"',JSON.stringify(deal)));
  await mkdir(new URL('../out/test-artifacts/subject-watch/',import.meta.url),{recursive:true});
  for (const width of [390,1440]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`,async () => {
    const page = await browser.newPage({viewport:{width,height:1000}});
    try {
      const errors = []; page.on('pageerror',e => errors.push(e.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.route('**/data/board-seed.json',r => r.fulfill({json:seed}));
      await page.route('**/js/fixture-client.js',r => r.fulfill({body:injected,contentType:'text/javascript'}));
      let watching = false, mode = 'ready', held, heldReady = () => {};
      const receipts = new Map(), writes = [];
      await page.route('**/fixture-watch',async route => {
        const {verb,args} = route.request().postDataJSON();
        assert.equal(args.subject_type,'deal'); assert.equal(args.subject_id,deal);
        if (verb === 'read') {
          const response = {...fixture.watch_response,watch:watching ? fixture.watch_response.watch : null}; delete response.rows_changed;
          if (mode === 'held') { held = () => route.fulfill({json:response}).catch(() => {}); heldReady(); return; }
          if (mode === 'failed') return route.fulfill({status:503,json:{}});
          if (mode === 'malformed') return route.fulfill({json:{...response,watch:undefined}});
          return route.fulfill({json:response});
        }
        writes.push({verb,args});
        let response = receipts.get(args.idempotency_key);
        if (response) response = {...response,replayed:true};
        else {
          watching = verb === 'watch'; response = structuredClone(watching ? fixture.watch_response : fixture.unwatch_response);
          receipts.set(args.idempotency_key,response);
        }
        if (mode === 'uncertain') return route.fulfill({status:503,json:{}});
        if (mode === 'held-write') { held = () => route.fulfill({json:response}).catch(() => {}); heldReady(); return; }
        return route.fulfill({json:response});
      });
      const open = () => page.goto(`${server.url}/deals?deal=${deal}`);
      const panel = page.getByRole('region',{name:'Watch this deal',exact:true});
      await open();
      const watch = panel.getByRole('button',{name:'Watch',exact:true}); await watch.waitFor({timeout:5000});
      assert.equal(await panel.evaluate(e => getComputedStyle(e).display),'flex');
      await watch.focus(); assert.equal(await watch.evaluate(e => e === document.activeElement),true);
      await page.keyboard.press('Enter');
      await panel.getByRole('button',{name:'Unwatch',exact:true}).waitFor();
      await panel.getByText('Watching',{exact:true}).waitFor();
      await page.reload(); await panel.getByText('Watching',{exact:true}).waitFor();
      mode = 'failed'; await page.reload();
      await panel.getByText('Watch status unavailable.',{exact:true}).waitFor();
      assert.equal(await watch.count(),0);
      mode = 'ready'; await panel.getByRole('button',{name:'Retry watch status'}).click();
      await panel.getByText('Watching',{exact:true}).waitFor();
      await panel.getByRole('button',{name:'Unwatch',exact:true}).click();
      await watch.waitFor(); await page.reload(); await watch.waitFor();
      assert.equal(watching,false);
      mode = 'failed'; await page.reload();
      await panel.getByText('Watch status unavailable.',{exact:true}).waitFor();
      assert.equal(await watch.count(),0);
      mode = 'malformed'; await panel.getByRole('button',{name:'Retry watch status'}).click();
      await panel.getByText('Watch status unavailable.',{exact:true}).waitFor();
      assert.equal(await watch.count(),0);
      mode = 'ready'; await panel.getByRole('button',{name:'Retry watch status'}).click(); await watch.waitFor();
      mode = 'uncertain'; await watch.click();
      await panel.getByRole('button',{name:'Check watch result'}).waitFor();
      assert.equal(await watch.count(),0);
      const first = writes.at(-1); mode = 'ready';
      await page.reload(); await panel.getByText('Watching',{exact:true}).waitFor();
      assert.deepEqual(writes.at(-1),first);
      mode = 'uncertain'; await panel.getByRole('button',{name:'Unwatch',exact:true}).click();
      await panel.getByRole('button',{name:'Check watch result'}).waitFor();
      const removal = writes.at(-1); mode = 'ready';
      await panel.getByRole('button',{name:'Check watch result'}).click(); await watch.waitFor();
      assert.deepEqual(writes.at(-1),removal);
      assert.equal(await panel.getByText('Watches notify you only when this record changes.',{exact:true}).count(),1);
      await page.screenshot({path:new URL(`../out/test-artifacts/subject-watch/${width}-${theme}.png`,import.meta.url).pathname});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      mode = 'held'; let heldStarted = new Promise(resolve => { heldReady = resolve; }); await page.reload(); await heldStarted;
      await panel.getByRole('status').filter({hasText:'Checking watch status…'}).waitFor();
      assert.equal(await watch.count(),0);
      await page.getByRole('button',{name:'Back to deals',exact:true}).click();
      await held(); assert.equal(await panel.count(),0);
      mode = 'held-write'; heldStarted = new Promise(resolve => { heldReady = resolve; }); await open(); await watch.waitFor(); await watch.click(); await heldStarted;
      await panel.getByRole('status').filter({hasText:'Saving watch…'}).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      await panel.getByText('Sign in again to view watches.',{exact:true}).waitFor();
      await held(); assert.equal(await panel.getByRole('button').count(),0);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('doctorcre.watch.')).length),0);
      assert.deepEqual(errors,[]);
    } finally { await page.unrouteAll({behavior:'ignoreErrors'}); await page.close(); }
  });
});
