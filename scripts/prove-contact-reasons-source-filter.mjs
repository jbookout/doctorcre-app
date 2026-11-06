import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {practiceOriginationFixture} from '../data/fixtures/practice-origination.mjs';
import {launchProofBrowser, proofFetch, readAppRelease} from './app-release-reader.mjs';
import {CHROMIUM_SAFETY_ARGS} from './chromium-safety-args.mjs';

export async function exerciseSourceFilter(page, moduleUrl) {
  const fixture = practiceOriginationFixture();
  const {response:contract}=JSON.parse(readFileSync(new URL('../contracts/carr-interface.v1/mcp_read_contracts/list-practice-origination.json',import.meta.url)));
  for(const key of contract.required_keys) assert.ok(Object.hasOwn(fixture,key),key);
  for(const row of fixture.cards) {
    for(const key of contract.card_keys) assert.ok(Object.hasOwn(row,key),key);
    assert.ok(contract.kinds.includes(row.kind));
    assert.ok(contract.routes.includes(row.route));
    assert.ok(contract.date_basis.includes(row.date_basis));
  }
  for(const row of fixture.coverage) {
    for(const key of contract.coverage_keys) assert.ok(Object.hasOwn(row,key),key);
    assert.ok(contract.coverage_statuses.includes(row.status));
  }
  assert.equal(fixture.contract, contract.contract);
  assert.equal(fixture.outreach_started, false);
  assert.deepEqual([...new Set(fixture.cards.map(row => row.source))].sort(), ['nppes', 'pecos']);
  await page.evaluate(async ({moduleUrl, fixture}) => {
    const {mountContactReasons} = await import(moduleUrl);
    document.body.innerHTML = '<main id="source-proof"></main>';
    const probe = window.sourceProof = {fixture, reads:[], held:false};
    probe.payload = structuredClone(fixture);
    probe.mount = mountContactReasons({host:document.querySelector('main'),window,client:{listPracticeOrigination: args => {
      probe.reads.push({before_id:args.before_id});
      return probe.held ? new Promise(resolve => {probe.resolve=resolve;}) : structuredClone(probe.payload);
    }}});
  }, {moduleUrl, fixture});
  const host = page.locator('#source-proof');
  try {
    await host.locator('article').first().waitFor();
    const source = host.getByLabel('Source', {exact:true});
    await source.waitFor();
    assert.deepEqual(await source.locator('option').allTextContents(), ['All sources','NPPES','PECOS']);
    const coverage = await host.getByRole('list', {name:'Source coverage'}).innerText();
    const show = host.getByRole('button', {name:/Show .* more/});
    if (await show.count()) await show.click();
    assert.equal(await host.locator('article').count(), fixture.cards.length, 'production parser admits contract fixture');
    await source.selectOption('pecos');
    assert.equal(await host.locator('article').count(),3);
    assert.equal(await host.getByRole('list', {name:'Source coverage'}).innerText(),coverage);
    assert.match(await host.innerText(),/3 matching loaded reasons/);
    assert.equal(await page.evaluate(() => window.sourceProof.reads.length),1);
    await host.getByLabel('Action category').selectOption('research');
    await host.getByRole('searchbox').fill('Group');
    assert.equal(await host.locator('article').count(),1);
    assert.match(await host.locator('article').innerText(),/Demo Group Practice/);
    assert.equal(await host.locator('time').getAttribute('datetime'), '2026-10-21');
    assert.equal(new URL(await host.locator('article a').getAttribute('href')).origin, 'https://data.cms.gov');
    await host.getByRole('button',{name:'Clear',exact:true}).click();
    assert.equal(await source.inputValue(),'');
    assert.equal(await host.getByLabel('Action category').inputValue(),'');
    assert.equal(await host.getByRole('searchbox').inputValue(),'');
    await source.selectOption('nppes');
    await host.getByLabel('Action category').selectOption('relationship_follow_up');
    assert.equal(await host.getByRole('link',{name:'Follow up with DEMO-CLIENT',exact:true}).getAttribute('href'),'/clients?record=demo-client');
    await host.getByRole('button',{name:'Clear',exact:true}).click();
    await source.selectOption('pecos');
    await page.evaluate(async () => {
      const p=window.sourceProof;
      p.payload={...p.fixture,cards:p.fixture.cards.filter(row=>row.source==='pecos'),next_cursor:'1'};
      await p.mount.refresh();
    });
    assert.equal(await source.inputValue(),'pecos');
    assert.deepEqual(await source.locator('option').allTextContents(),['All sources','PECOS']);
    await host.getByRole('searchbox').fill('no matching loaded practice');
    assert.equal(await host.locator('article').count(),0);
    await page.evaluate(() => {window.sourceProof.payload=window.sourceProof.fixture;});
    await host.getByRole('button',{name:'More reasons',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#source-proof').getAttribute('aria-busy')==='false');
    assert.equal(await page.evaluate(() => window.sourceProof.reads.at(-1).before_id),'1');
    assert.equal(await source.inputValue(),'pecos');
    await host.getByRole('searchbox').fill('');
    assert.equal(await host.locator('article').count(),3, 'append deduplicates');
    await page.evaluate(async () => {
      const p=window.sourceProof;
      p.payload={...p.fixture,contract:'invalid'};
      await p.mount.refresh();
    });
    await host.getByText(/Showing last update/).waitFor();
    assert.equal(await source.inputValue(),'pecos');
    assert.equal(await host.locator('article').count(),3);
    await page.evaluate(() => {window.sourceProof.payload=window.sourceProof.fixture;});
    await host.getByRole('button',{name:'Try again',exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('[data-retry-reasons]'));
    assert.equal(await source.inputValue(),'pecos');
    await page.evaluate(async () => {
      const p=window.sourceProof;
      p.payload={...p.fixture,cards:p.fixture.cards.filter(row=>row.source==='nppes')};
      await p.mount.refresh();
    });
    assert.equal(await source.inputValue(),'');
    assert.equal(await host.locator('article').count(),3);
    await source.selectOption('nppes');
    await page.evaluate(() => {const p=window.sourceProof;p.held=true;p.mount.refresh();});
    await page.waitForFunction(() => Boolean(window.sourceProof.resolve));
    await page.evaluate(() => {
      window.dispatchEvent(new Event('doctorcre-session-invalidated'));
      window.sourceProof.resolve(window.sourceProof.fixture);
    });
    await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
    assert.equal(await host.locator('article,select').count(),0);
    const reads = await page.evaluate(() => window.sourceProof.reads.length);
    await page.evaluate(async () => {await window.sourceProof.mount.refresh();});
    assert.equal(await page.evaluate(() => window.sourceProof.reads.length),reads);
    return ['contract fixture admitted through production parser','combined local filters and unfiltered coverage','citations dates and relationship routing','clear all filters','single source and successful refresh retain selection','zero matches still pages with cursor and deduplication','malformed refresh retains selection and retry recovers','source disappearance resets selection','retirement ignores late results'];
  } finally {await page.evaluate(() => window.sourceProof?.mount.dispose());}
}

export async function prove({origin,timeoutMs=30000,engine=chromium,observe=exerciseSourceFilter}) {
  const target=new URL(origin);
  assert.ok(target.origin===origin && !target.username && !target.password && (target.protocol==='https:' || target.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname)),'HTTPS or loopback origin required');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=300000,'invalid timeout');
  const controller=new AbortController();
  const timeout=Object.assign(new Error('proof deadline exceeded'),{exitCode:78});
  let browser, timer;
  const work=async () => {
    const before=await readAppRelease(origin,{timeoutMs});
    controller.signal.throwIfAborted();
    browser=await launchProofBrowser(engine,{args:[...CHROMIUM_SAFETY_ARGS]},{signal:controller.signal});
    const context=await browser.newContext({storageState:{cookies:[],origins:[]},serviceWorkers:'block'});
    const page=await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    let requests=0;
    await context.route('**/*',async route => {
      const request=route.request(), url=new URL(request.url());
      if(url.href===`${origin}/__source-proof__`) return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
      if(++requests>40 || request.method()!=='GET' || url.origin!==origin || !/^\/js\/[\w./-]+\.(m?js)$/.test(url.pathname)) return route.abort();
      const response=await proofFetch(url,{signal:controller.signal});
      return route.fulfill({status:response.status,contentType:response.headers.get('content-type')||'text/javascript',body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(`${origin}/__source-proof__`);
    const assertions=await observe(page,`${origin}/js/contact-reasons.mjs`);
    const after=await readAppRelease(origin,{timeoutMs});
    assert.equal(after.source_commit,before.source_commit,'release changed during observation');
    return {status:'insufficient_evidence',exit_code:78,origin,release:after,deployed_module:{status:'passed',assertions},natural:{status:'insufficient_evidence',reason:'Fresh browser has no authenticated natural observation. Signed-in Leads walk required.'},requests};
  };
  try {
    return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort(timeout);reject(timeout);},timeoutMs);})]);
  } finally {clearTimeout(timer);controller.abort(timeout);await browser?.close();}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i+=2) {
      assert.ok(['--origin','--timeout-ms'].includes(args[i]) && args[i+1],'Usage: node scripts/prove-contact-reasons-source-filter.mjs --origin https://app.doctorcre.com --timeout-ms 30000');
      options[args[i]]=args[i+1];
    }
    const receipt=await prove({origin:options['--origin'],timeoutMs:Number(options['--timeout-ms']||30000)});
    console.log(JSON.stringify(receipt));process.exitCode=receipt.exit_code;
  } catch(error) {
    const exit=error.exitCode||1;
    console.log(JSON.stringify({status:exit===78?'insufficient_evidence':'failed',exit_code:exit,error:error.message}));process.exitCode=exit;
  }
}
