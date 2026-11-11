import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {readAppRelease} from './app-release-reader.mjs';

const insufficient = message => Object.assign(Error(message), {exitCode:78});

export async function observeWindow(page, origin) {
  await page.goto(`${origin}/leads#contactReasons`);
  const host=page.locator('#contactReasons');
  // Use the app client so authentication stays inside the signed-in same-origin page.
  const payload=await page.evaluate(async()=>{
    const {createLeadBoardClient}=await import('/js/leads-client.js');
    return createLeadBoardClient({docContext:false}).listPracticeOrigination({limit:25});
  }).catch(()=>{throw insufficient('Natural reasons read unavailable');});
  if(payload?.contract!=='practice-origination.v1'||!payload.cards?.length) throw insufficient('No natural reasons');
  await host.getByLabel('Evidence from',{exact:true}).waitFor({timeout:5000});
  const source=await host.getByLabel('Source',{exact:true}).inputValue();
  const category=await host.getByLabel('Action category').inputValue();
  const query=(await host.getByRole('searchbox').inputValue()).trim().toLocaleLowerCase('en-US');
  const eligible=payload.cards.filter(row=>(!source||row.source===source)&&(!category||row.route===category)&&(!query||[row.name,row.city,row.state,...row.client_refs].some(value=>value.toLocaleLowerCase('en-US').includes(query))));
  const date=eligible[0]?.evidence_date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')) throw insufficient('No natural dated reason');
  let reads=0;
  const onRequest=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/mcp') reads++;};
  page.on('request',onRequest);
  try {
    await host.getByLabel('Evidence from',{exact:true}).fill(date);
    await host.getByLabel('Evidence through',{exact:true}).fill(date);
    await host.getByRole('button',{name:'Apply evidence window',exact:true}).click();
    const show=host.getByRole('button',{name:/Show .* more/});
    if(await show.count()) await show.click();
    const expected=eligible.filter(row=>row.evidence_date===date).map(row=>row.id);
    const observed=await host.locator('article [data-reason-key^="source:"]').evaluateAll(links=>links.map(link=>link.getAttribute('data-reason-key').slice(7)));
    assert.deepEqual(observed,expected,'natural date intersection ids');
    assert.deepEqual(await host.locator('time').evaluateAll(nodes=>nodes.map(node=>node.dateTime)),expected.map(()=>date));
    assert.equal(await host.getByRole('status').innerText(),`${expected.length} matching loaded ${expected.length===1?'reason':'reasons'}`);
    assert.equal(await host.locator('.contact-reason-note').innerText(),'Registry and publication dates do not confirm when a practice opened.');
    await host.getByRole('button',{name:'Clear',exact:true}).click();
    assert.equal(await host.getByLabel('Evidence from',{exact:true}).inputValue(),'');
    assert.equal(await host.getByLabel('Evidence through',{exact:true}).inputValue(),'');
    assert.equal(await host.getByRole('searchbox').evaluate(el=>document.activeElement===el),true);
    assert.equal(reads,0,'selection and Clear must not read');
    page.off('request',onRequest);
    await page.goto(`${origin}/review-workflows`);
    const home=page.locator('#homeContactReasons');
    await home.waitFor({state:'attached'});
    const preview=await page.evaluate(async()=>{
      const {createLeadBoardClient}=await import('/js/leads-client.js');
      const {homeListLimit}=await import('/js/ui-limit.generated.js');
      const data=await createLeadBoardClient({docContext:false}).listPracticeOrigination({limit:100});
      return data.cards?.filter(row=>row.route==='research').slice(0,homeListLimit(window)).map(row=>row.id);
    }).catch(()=>{throw insufficient('Natural Home preview read unavailable');});
    if(!preview?.length)throw insufficient('No natural Home research preview');
    await page.locator('.home-grid').scrollIntoViewIfNeeded();
    await home.locator('article').first().waitFor();
    assert.deepEqual(await home.locator('article [data-reason-key^="source:"]').evaluateAll(links=>links.map(link=>link.getAttribute('data-reason-key').slice(7))),preview,'Home research preview ids');
    assert.equal(await home.getByLabel('Evidence from',{exact:true}).count(),0);
    assert.equal(await home.getByLabel('Evidence through',{exact:true}).count(),0);
    return {date,ids:observed,local_reads:reads,home_ids:preview};
  } finally {page.off('request',onRequest);}
}

export async function prove({origin,expectedCommit,cdpUrl,timeoutMs=30000,engine=chromium,observe=observeWindow,ancestryCwd=fileURLToPath(new URL('../',import.meta.url))}) {
  const url=new URL(origin);
  assert.ok(url.origin===origin&&!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)),'HTTPS or loopback origin required');
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000);
  const controller=new AbortController(), end=performance.now()+timeoutMs;
  const remaining=()=>{const ms=Math.ceil(end-performance.now());if(ms<=0||controller.signal.aborted)throw insufficient('Proof deadline exceeded');return ms;};
  let browser,page,pendingBrowser,pendingPage,timer,closing=false;
  const release=()=>readAppRelease(origin,{timeoutMs:remaining()});
  const contains=async actual=>{
    if(actual===expectedCommit)return;
    try {
      await new Promise((resolve,reject)=>execFile('git',['merge-base','--is-ancestor',expectedCommit,actual],{cwd:ancestryCwd,timeout:remaining(),signal:controller.signal},error=>error?reject(error):resolve()));
    } catch {throw insufficient('Release does not establish expected commit ancestry');}
  };
  const work=async()=>{
    const before=await release();
    if(!/^[a-f0-9]{40}$/.test(expectedCommit||''))throw insufficient('Expected commit required');
    await contains(before.source_commit);
    if(!cdpUrl)throw insufficient('Existing signed-in browser endpoint required');
    try {
      pendingBrowser=engine.connectOverCDP(cdpUrl,{timeout:remaining()}).then(async acquired=>{
        if(closing){await acquired.close();throw insufficient('Browser acquired after deadline');}browser=acquired;return acquired;
      });
      await pendingBrowser;
      const context=browser.contexts()[0];
      if(!context)throw insufficient('Signed-in browser context unavailable');
      pendingPage=context.newPage().then(async acquired=>{
        if(closing){await acquired.close();throw insufficient('Page acquired after deadline');}page=acquired;return acquired;
      });
      await pendingPage;
    } catch {throw insufficient('Signed-in browser acquisition unavailable');}
    page.setDefaultTimeout(remaining());page.setDefaultNavigationTimeout(remaining());
    const observation=await observe(page,origin);
    const after=await release();await contains(after.source_commit);
    if(before.source_commit!==after.source_commit)throw insufficient('Release changed during observation');
    return {status:'passed',exit_code:0,release:after,observation};
  };
  try {
    return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(insufficient('Proof deadline exceeded'));},timeoutMs);})]);
  } finally {
    closing=true;clearTimeout(timer);controller.abort();
    // Keep the borrowed transport alive until late page acquisitions can be closed.
    await Promise.allSettled([pendingPage]);
    await page?.close().catch(()=>{});
    await Promise.allSettled([pendingBrowser]);
    await browser?.close().catch(()=>{});
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const options={},args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2){assert.ok(['--origin','--expected-commit','--cdp-url','--timeout-ms'].includes(args[i])&&args[i+1],'Unknown or missing argument');options[args[i]]=args[i+1];}
    console.log(JSON.stringify(await prove({origin:options['--origin'],expectedCommit:options['--expected-commit'],cdpUrl:options['--cdp-url'],timeoutMs:Number(options['--timeout-ms']||30000)})));
  } catch(error){const code=error.exitCode||1;console.log(JSON.stringify({status:code===78?'insufficient_evidence':'failed',exit_code:code,error:error.message}));process.exitCode=code;}
}
