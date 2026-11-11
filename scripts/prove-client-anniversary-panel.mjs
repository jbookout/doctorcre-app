import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from './proof-browser.mjs';
import { chromium as driver } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';

const insufficient = message => Object.assign(Error(message),{exitCode:78});
export async function prove({origin,expectedCommit,cdpUrl,timeoutMs=30000}) {
  const controller = new AbortController();
  const deadline = performance.now()+timeoutMs;
  const remaining = () => { const ms=Math.ceil(deadline-performance.now()); if(ms<=0)throw insufficient('Total proof deadline expired'); return ms; };
  const timer = setTimeout(()=>controller.abort(insufficient('Total proof deadline expired')),timeoutMs);
  let browser, page, containing = false, snapshotObserved = false;
  const release = () => readAppRelease(origin, async url => {
    const response = await proofFetch(url,{signal:controller.signal,cache:'no-store'});
    return {type:response.headers.get('content-type')||'',body:Buffer.from(await response.arrayBuffer())};
  });
  const bounded = pending => new Promise((resolve,reject)=>{
    const abort=()=>reject(controller.signal.reason);
    controller.signal.addEventListener('abort',abort,{once:true});
    if(controller.signal.aborted)abort();
    Promise.resolve(pending).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
  });
  try {
    const before = await bounded(release());
    if(!/^[a-f0-9]{40}$/.test(expectedCommit||''))throw insufficient('Expected merge commit required');
    if(before.source_commit !== expectedCommit) {
      try {
        await new Promise((resolve,reject)=>{
          const child=execFile('git',['merge-base','--is-ancestor',expectedCommit,before.source_commit],{timeout:remaining(),signal:controller.signal},error=>error?reject(error):resolve());
          child.on('error',reject);
        });
      } catch { throw insufficient('Release ancestry is insufficient'); }
    }
    containing = true;
    let pendingPage, closing;
    const selected = cdpUrl ? {async launch(options) {
      const connection = await driver.connectOverCDP(cdpUrl,{timeout:options.timeout});
      return {
        newPage() { return pendingPage=connection.contexts()[0].newPage(); },
        close() { return closing ||= (async () => {
          try { const ownedPage=await pendingPage; await ownedPage?.close(); }
          finally { await connection.close(); }
        })(); },
      };
    }} : chromium;
    browser=await launchProofBrowser(selected,{timeout:remaining()},{signal:controller.signal});
    page=await browser.newPage();
    await page.goto(origin+'/leases?mode=live',{timeout:remaining()});
    const snapshot = await page.evaluate(async () => {
      const {createClientAnniversariesClient}=await import('/js/ui-client-anniversaries.generated.js');
      return createClientAnniversariesClient().read();
    });
    if(!['ready','empty'].includes(snapshot.state))throw insufficient('Natural anniversary snapshot unavailable');
    snapshotObserved = true;
    const section=page.getByRole('region',{name:'Closing anniversaries',exact:true});
    assert.equal(await section.locator('button[aria-controls="anniversaryContent"]').getAttribute('aria-expanded'),'true');
    await section.locator('[aria-busy="false"]').waitFor({timeout:remaining()});
    assert.equal(await section.locator('#anniversaryContent').isVisible(),true);
    const text=await section.innerText();
    if(await section.getByRole('alert').count())throw insufficient('Anniversary panel read unavailable');
    assert.ok(text.includes('America/Chicago'));
    assert.equal(await section.locator('#anniversaryContent > p').filter({hasText:'As of '}).innerText(),`As of ${snapshot.as_of}. Scanned ${snapshot.coverage.scanned}. Skipped invalid ${snapshot.coverage.skipped_invalid}.`);
    const rows=section.locator('ol > li');
    assert.equal(await rows.count(),snapshot.rows.length);
    for(let i=0;i<snapshot.rows.length;i++) {
      const r=snapshot.rows[i],row=rows.nth(i);
      assert.equal(await row.locator('a').nth(0).innerText(),r.client_name);
      assert.equal(await row.locator('a').nth(1).innerText(),r.deal_name);
      assert.equal(await row.locator('p').innerText(),`Closed ${r.closed_on} · Anniversary ${r.anniversary_on} · ${r.years} years · ${r.days_until} days until`);
      assert.equal(await row.locator('a').nth(0).getAttribute('href'),`/clients?record=${encodeURIComponent(r.client_id)}`);
      assert.equal(await row.locator('a').nth(1).getAttribute('href'),`/deals?deal=${encodeURIComponent(r.deal_id)}`);
    }
    assert.equal(text.includes('More anniversary rows exist'),snapshot.next_offset!==null);
    if(snapshot.state==='empty')assert.ok(text.includes('No closing anniversaries in this slice.'));
    const after=await bounded(release());
    if(after.source_commit!==before.source_commit)throw insufficient('Release changed during observation');
    return {status:'passed',state:snapshot.state,rows:snapshot.rows.length,source_commit:before.source_commit};
  } catch(error) {
    if(error.exitCode===78)throw error;
    if(!snapshotObserved || !containing || controller.signal.aborted || error.name==='TimeoutError' || !page || /session|unavailable|sign in/i.test(error.message))throw insufficient('Natural session or observation unavailable');
    throw error;
  } finally { clearTimeout(timer); await page?.close().catch(()=>{}); await browser?.close().catch(()=>{}); }
}
async function main() {
  try {
    const args=process.argv.slice(2),values={};
    for(let i=0;i<args.length;i+=2)values[args[i]]=args[i+1];
    const url=new URL(values['--origin']);
    if(url.username||url.password||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw insufficient('HTTPS or loopback origin required');
    const timeoutMs=Number(values['--timeout-ms']||30000);
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw insufficient('Invalid deadline');
    console.log(JSON.stringify(await prove({origin:url.origin,expectedCommit:values['--expected-commit'],cdpUrl:values['--cdp-url'],timeoutMs})));
  }catch(error){ console.log(JSON.stringify({status:'unproven',error:error.message}));process.exitCode=error.exitCode||1; }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
