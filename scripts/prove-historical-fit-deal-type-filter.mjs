import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';

const insufficient = message => Object.assign(Error(message), { exitCode: 78 });
export async function recordings() {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/ideal-client-profile.json', import.meta.url)));
  const recorded = JSON.parse(await readFile(new URL('../test/fixtures/historical-fit-deal-type-filter/recordings.json', import.meta.url)));
  assert.equal(contract.write, false);
  assert.equal(contract.profiles.deal_type, 'string|null');
  for (const payload of Object.values(recorded)) {
    assert.equal(payload.schema_version, contract.schema_version);
    assert.equal(payload.coverage, contract.coverage);
    assert.ok(payload.profiles.length <= contract.limit);
    for (const row of payload.profiles) {
      assert.ok(row.deal_type === null || typeof row.deal_type === 'string');
      assert.ok(row.clients > 0 && row.clients <= row.won_deals);
      assert.equal(row.evidence.length, row.won_deals);
      assert.equal(row.hypothesis, contract.profiles.hypothesis);
    }
  }
  return recorded;
}

export async function filterAssertions(page, moduleURL) {
  const recorded = await recordings();
  await page.evaluate(async ({ moduleURL, recorded }) => {
    const { mountIdealClientProfile } = await import(moduleURL);
    const host = document.createElement('main'); document.body.replaceChildren(host);
    const p = window.filterProof = { recorded, payload: recorded.full, reads: [], hold: false, pending: [] };
    p.remount = () => {
      p.mount?.dispose();
      p.mount = mountIdealClientProfile(host, { getIdealClientProfile(filters) {
        p.reads.push(filters);
        const result = structuredClone(p.payload);
        return p.hold ? new Promise(resolve => p.pending.push(() => resolve(result))) : Promise.resolve(result);
      } });
    };
    p.remount();
  }, { moduleURL, recorded });
  const host = page.locator('main');
  const selector = host.getByLabel('Deal type', { exact: true });
  const rows = host.locator('tbody tr');
  const open = () => host.locator('summary').first().click();
  const refresh = () => host.getByRole('button', { name: 'Refresh history' }).click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await open(); await host.getByRole('table').waitFor();
  assert.equal(await selector.count(), 1, 'loaded history offers a local deal type selector');
  const options = await selector.locator('option').evaluateAll(options => options.map(o => ({label:o.textContent,value:o.value})));
  assert.deepEqual(options.map(o=>o.label), ['All deal types', ...recorded.full.profiles.map(r=>r.deal_type ?? 'Unrecorded')]);
  const all = options[0].value;
  const expectedLinks = recorded.full.profiles.flatMap(r=>r.evidence.map(e=>`/deals?deal=${e.deal_id}`));
  assert.deepEqual(await host.locator('tbody a').evaluateAll(links=>links.map(a=>a.getAttribute('href'))), expectedLinks);
  const reads = await page.evaluate(()=>window.filterProof.reads.length);
  for (let i=0;i<recorded.full.profiles.length;i++) {
    await selector.selectOption(options[i+1].value);
    assert.equal(await rows.count(), 1);
    assert.match(await host.getByRole('status').innerText(), /1 of 5/);
    assert.equal(await rows.locator('td').nth(0).innerText(), recorded.full.profiles[i].vertical ?? 'Unrecorded');
    await rows.locator('summary').click();
    assert.equal(await rows.locator('a').getAttribute('href'), expectedLinks[i]);
    assert.match(await rows.innerText(), /Historical fit, not a prediction or qualification rule/);
    assert.equal(await rows.locator('td').nth(3).innerText(), '1 deal');
    assert.equal(await rows.locator('td').nth(4).innerText(), '1 client');
  }
  assert.equal(await page.evaluate(()=>window.filterProof.reads.length), reads);
  await selector.selectOption(all); assert.equal(await rows.count(), 5);
  await selector.selectOption(options[1].value); await refresh(); await host.getByRole('table').waitFor();
  assert.equal(await selector.inputValue(), options[1].value);
  await host.getByLabel('City', {exact:true}).fill('Synthetic city');
  await host.getByRole('button',{name:'Apply filters'}).click(); await host.getByRole('table').waitFor();
  assert.equal(await selector.inputValue(), options[1].value);
  assert.deepEqual(await page.evaluate(()=>window.filterProof.reads.at(-1)), {city:'Synthetic city'});
  await selector.selectOption(options[2].value);
  await page.evaluate(()=>{window.filterProof.payload=window.filterProof.recorded.subset;});
  await refresh(); await host.getByRole('table').waitFor();
  assert.equal(await selector.inputValue(), all);
  assert.match(await host.getByRole('status').innerText(), /no longer available.*All deal types/i);
  await page.evaluate(()=>{window.filterProof.payload=window.filterProof.recorded.empty;});
  await refresh(); await host.getByText(/No completed wins match/).waitFor();
  assert.match(await host.getByRole('status').innerText(), /0 of 0/);
  assert.equal(await rows.count(),0);
  await page.evaluate(()=>{const p=window.filterProof;p.payload=structuredClone(p.recorded.full);p.payload.profiles[0].evidence[0].closed_on='2026-02-31';});
  await refresh(); await host.getByRole('alert').waitFor(); assert.equal(await rows.count(),0);
  await page.evaluate(()=>{const p=window.filterProof;p.hold=true;p.payload=p.recorded.subset;});
  await refresh();
  await page.evaluate(()=>{const p=window.filterProof;p.hold=false;p.payload=p.recorded.full;});
  await refresh(); await host.getByRole('table').waitFor();
  await page.evaluate(()=>window.filterProof.pending.splice(0).forEach(resolve=>resolve())); await settle();
  assert.equal(await rows.count(),5);
  await selector.selectOption(options[1].value);
  await page.evaluate(()=>window.filterProof.mount.clear()); await settle();
  assert.equal(await rows.count(),0); await open(); await host.getByRole('table').waitFor();
  assert.equal(await selector.inputValue(),all);
  for (const action of ['retire','dispose']) {
    await selector.selectOption(options[1].value);
    await page.evaluate(()=>{window.filterProof.hold=true;}); await refresh();
    await page.evaluate(action=>{
      const p=window.filterProof;
      if(action==='retire') window.dispatchEvent(new Event('doctorcre-session-invalidated')); else p.mount.dispose();
      p.pending.splice(0).forEach(resolve=>resolve());
    },action); await settle();
    assert.equal(await rows.count(),0); assert.equal(await selector.count(),0);
    if(action==='retire') {
      await page.evaluate(()=>{window.filterProof.mount.clear();});
      assert.match(await host.getByRole('status').innerText(),/Sign in again/);
      await page.evaluate(()=>{window.filterProof.hold=false;window.filterProof.remount();});
      await open(); await host.getByRole('table').waitFor();
    }
  }
  return ['exact and null options', 'local filtering preserves ordered evidence and group counts', 'clear restores all without a read', 'refresh and server filters retain choice', 'disappearing choice resets explicitly', 'empty snapshot', 'invalid dates refuse evidence', 'latest response wins', 'clear evicts selection', 'retirement and disposal reject late responses'];
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(base.origin === origin && !base.username && !base.password && (base.protocol === 'https:' || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)), 'HTTPS or loopback origin required');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 300000);
  assert.ok(!fixture || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname), 'fixture success only on loopback');
  const signal = AbortSignal.timeout(timeoutMs);
  let browser, transportFailure, requests = 0, bytes = 0;
  const read = async url => {
    if (++requests > 40) throw insufficient('request budget exhausted');
    const response = await proofFetch(url, { signal });
    if (!response.ok) throw insufficient(`Asset unavailable ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer()); bytes += body.length;
    if(bytes > 16*1024*1024) throw insufficient('asset byte budget exhausted');
    return {body,type:response.headers.get('content-type')||''};
  };
  try {
    const before = await readAppRelease(base, read);
    browser = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], timeout:timeoutMs }, {signal});
    const context = await browser.newContext({serviceWorkers:'block'});
    const page = await context.newPage(); page.setDefaultTimeout(timeoutMs);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if(route.request().method()!=='GET' || url.origin!==origin) return route.abort();
      if(url.pathname==='/__historical_filter_proof') return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic filter proof</title>'});
      if(!/^\/js\/[\w.-]+\.js$/.test(url.pathname)) return route.abort();
      try { const asset=await read(url); if(!/javascript/.test(asset.type)) throw insufficient('JavaScript asset unavailable'); await route.fulfill({body:asset.body,contentType:asset.type}); }
      catch (error) { transportFailure = error; await route.abort(); }
    });
    await page.goto(`${origin}/__historical_filter_proof`);
    const assertions = await filterAssertions(page,`${origin}/js/ui-ideal-client-profile.generated.js`);
    const after = await readAppRelease(base, read); assert.equal(after.source_commit,before.source_commit,'stable release');
    if(!fixture) throw insufficient('Deployed fixture assertions passed; signed-in natural observation is still required');
    return {status:'fixture_pass',release:after,assertions,requests};
  } catch(error) {
    if(transportFailure) throw transportFailure;
    if(signal.aborted || error.name==='TimeoutError') throw insufficient('Proof deadline exceeded');
    throw error;
  } finally { await browser?.close(); }
}

if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {
    const {values}=parseArgs({options:{origin:{type:'string'},'timeout-ms':{type:'string',default:'30000'},fixture:{type:'boolean'},help:{type:'boolean'}}});
    if(values.help) console.log('Usage: --origin URL [--timeout-ms 30000] [--fixture]. Exit 0 fixture pass, 1 contradiction, 78 insufficient_evidence. Natural production proof requires a separate signed-in walk.');
    else console.log(JSON.stringify(await prove({origin:values.origin,timeoutMs:Number(values['timeout-ms']),fixture:values.fixture})));
  } catch(error) { console.error(JSON.stringify({status:error.exitCode===78?'insufficient_evidence':'failed',error:error.message}));process.exitCode=error.exitCode||1; }
}
