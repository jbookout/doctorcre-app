import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/board_tour_proposals.json',import.meta.url),'utf8'));
const response = (deals = contract.response_fixture.deals, next_cursor = null) => ({...contract.response_fixture,deals,next_cursor});

test('board proposal badges', async t => {
  const artifact = await temporaryDirectory('doctorcre-proposal-badges-', t);
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifact,commit:'1'.repeat(40)});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:`${artifact}/site`}});
  t.after(()=>server.stop());
  const browser = await chromium.launch(); t.after(()=>browser.close());
  for (const width of [390,1440]) for (const theme of ['light','dark']) {
    let page, reads, answer;
    async function boot() {
      page = await browser.newPage({viewport:{width,height:1000}});
      reads=[]; answer=()=>response();
      await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
      await page.route('**/auth/session',route=>route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic'}}));
      await page.route('**/mcp',route=>{
        const request=route.request().postDataJSON();
        assert.equal(request.params.name,'list-board-tour-proposals');
        assert.equal(request.params.arguments.limit,100);
        assert.equal('deal_id' in request.params.arguments,false);
        reads.push(request.params.arguments);
        const payload=answer(request.params.arguments);
        return route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
      });
    }
    const badge = () => page.locator('[data-board-proposal-host="d14"] button:visible');
    const state = kind => page.locator(`[data-board-proposal-host="d14"] [data-proposal-state="${kind}"]`).first().waitFor({state:'attached'});
    for (const name of ['pending and one feed read per board load','zero is distinct from unavailable','service failure keeps navigation usable','more-than-one-page feed','keyboard activation opens proposal workspace','sign-out clears counts','keep resolution followed by refresh','use resolution followed by refresh','ordinary deal navigation unchanged','invalid second page never publishes zero','repeated cursor is bounded','sign-out discards a late response']) {
      await t.test(`${width} ${theme}: ${name}`,async()=>{
        await boot();
        try {
          if(name==='service failure keeps navigation usable') answer=()=>({ok:false,error:'synthetic outage'});
          if(name==='more-than-one-page feed') answer=({cursor})=>cursor ? response([{deal_id:'d14',pending_count:7}]) : response([{deal_id:'d23',pending_count:0}],'page-2');
          if(name==='invalid second page never publishes zero') answer=({cursor})=>cursor ? response([{deal_id:'d14',pending_count:-1}]) : response([],'page-2');
          if(name==='repeated cursor is bounded') answer=()=>response([],'same-cursor');
          if(name==='sign-out discards a late response') {
            await page.unroute('**/mcp');
            let release;
            const held=new Promise(resolve=>{release=resolve;});
            await page.route('**/mcp',async route=>{reads.push({});await held;await route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(response())}]}}}).catch(()=>{});});
            await page.goto(`${server.url}/deals`);
            await state('loading');
            await page.evaluate(()=>window.dispatchEvent(new Event('doctorcre-session-invalidated')));
            release();
            await state('idle');
            assert.equal(await badge().count(),0);
            await page.waitForLoadState('networkidle');
            assert.equal(await badge().count(),0);
            return;
          }
          if(name==='sign-out clears counts') {
            let signedIn=true;
            await page.route('**/auth/session',route=>route.fulfill({status:signedIn?200:401,json:signedIn?{actor:{slug:'joe'},csrf_token:'synthetic'}:{}}));
            await page.route('**/auth/signout',route=>{signedIn=false;return route.fulfill({status:302,headers:{location:'/'}});});
            await page.route('**/mcp',route=>{
              const request=route.request().postDataJSON();
              const payload=request.params.name==='list-board-tour-proposals' ? (reads.push(request.params.arguments),response()) :
                request.params.name==='deal-room-board' ? {actor:'joe',deals:[{id:'d14',name:'Demo proposal deal',phase:'legal',owner:'joe',operating_state:'active'}]} : {};
              return route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(payload)}]}}});
            });
            await page.goto(`${server.url}/deals?mode=live`);
            await state('pending');
            await page.locator('#selfAvatar').click();
            await page.getByRole('button',{name:'Sign out',exact:true}).click();
            await page.waitForURL('**/public-shell/session-ended.html');
            assert.equal(await page.locator('[data-board-proposal-host]').count(),0);
            assert.doesNotMatch(await page.locator('body').innerText(),/pending client tours/);
            assert.equal(reads.length,1);return;
          }
          await page.goto(`${server.url}/deals`);
          if(['service failure keeps navigation usable','invalid second page never publishes zero','repeated cursor is bounded'].includes(name)) {
            await state('unavailable');
            assert.equal(await badge().count(),0);
            assert.equal(reads.length,name==='service failure keeps navigation usable'?1:2);
            await page.locator('.card-open[data-open="d14"]:visible').click();
            await page.locator('#recordPanel:visible').waitFor();
            return;
          }
          await state('pending');
          assert.match(await badge().innerText(),name==='more-than-one-page feed'?/7 pending client tours/:/2 pending client tours/);
          if(name==='more-than-one-page feed') {assert.deepEqual(reads,[{limit:100},{limit:100,cursor:'page-2'}]);return;}
          assert.equal(reads.length,1);
          if(name==='zero is distinct from unavailable') {
            assert.equal(await page.locator('[data-board-proposal-host="d20"] button').count(),0);
            assert.match(await page.locator('[data-board-proposal-host="d20"]').first().innerText(),/No pending client tours/);
            return;
          }
          if(name==='pending and one feed read per board load') {
            assert.match(await page.locator('[data-board-proposal-host="d23"] button:visible').innerText(),/4 pending client tours/);
            await page.locator('#listView').click(); await state('pending');
            await page.locator('#boardView').click(); await state('pending');
            assert.equal(reads.length,1);
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            return;
          }
          if(name==='ordinary deal navigation unchanged') {
            await page.locator('.card-open[data-open="d14"]:visible').click();
            await page.locator('#recordPanel:visible').waitFor();
            assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
            assert.equal(await page.locator('#workspace-tour-proposals:focus').count(),0);
            assert.equal(reads.length,1);return;
          }
          // Synthetic holder boundary reproduces its existing host and onPending markers.
          await page.evaluate(()=>{
            new MutationObserver(()=>{
              const body=document.querySelector('#panelBody');
              if(!body?.querySelector('.deal-opening-snapshot') || document.getElementById('workspace-tour-proposals')) return;
              const host=document.createElement('section');host.id='workspace-tour-proposals';host.textContent='Synthetic client tour proposal card';body.prepend(host);
              for (const mode of ['keep','use']) {
                const button=document.createElement('button');button.textContent=`Confirm ${mode}`;
                button.onclick=async()=>{
                  const receipt=await fetch(`/synthetic/resolve?mode=${mode}`,{method:'POST'}).then(r=>r.json());
                  if(!receipt.confirmed) return;
                  const readback=await fetch('/synthetic/shortlist').then(r=>r.json());
                  if(!readback.confirmed) return;
                  document.querySelectorAll('[data-tour-proposal-badge="d14"]').forEach(node=>node.remove());
                };host.append(button);
              }
              const marker=document.createElement('span');marker.dataset.tourProposalBadge='d14';document.querySelector('[data-open="d14"]').append(marker);
            }).observe(document.getElementById('panelBody'),{childList:true,subtree:true});
          });
          if(name==='keyboard activation opens proposal workspace') {await badge().focus();await page.keyboard.press('Enter');}
          else await badge().click();
          await page.locator('#workspace-tour-proposals:focus').waitFor();
          assert.equal(new URL(page.url()).searchParams.get('deal'),'d14');
          if(name.includes('resolution followed')) {
            await state('pending');
            await page.waitForLoadState('networkidle');
            const prior=reads.length;
            const mode=name.startsWith('keep')?'keep':'use';
            let resolveCalls=0, readbackCalls=0;
            await page.route('**/synthetic/resolve?*',route=>{
              assert.equal(new URL(route.request().url()).searchParams.get('mode'),mode);
              ++resolveCalls;return route.fulfill({json:{confirmed:true}});
            });
            await page.route('**/synthetic/shortlist',route=>{
              ++readbackCalls;answer=()=>response([]);return route.fulfill({json:{confirmed:true}});
            });
            assert.equal(reads.length,prior);
            await page.getByRole('button',{name:`Confirm ${mode}`,exact:true}).click();
            await state('zero');
            assert.equal(reads.length,prior+1);
            assert.equal(resolveCalls,1);assert.equal(readbackCalls,1);
            assert.equal(await badge().count(),0);
          }
        } finally {await page.close();}
      });
    }
  }
});
