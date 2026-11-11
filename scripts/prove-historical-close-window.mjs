import { guardProofReads } from './proof-verb-registry.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';

const insufficient = message => Object.assign(Error(message), { exitCode: 78 });
async function windowAssertions(page, payload) {
  assert.equal(payload.schema_version, 'ideal-client-profile.v1');
  assert.equal(payload.coverage, 'recorded_closed_won_only');
  const date = payload.profiles.flatMap(row => row.evidence)[0]?.closed_on;
  if (!date) throw insufficient('No completed wins available');
  const host = page.getByRole('region', { name: 'Historical client fit', exact: true });
  await host.getByRole('table').waitFor();
  await host.getByLabel('Closed from', { exact: true }).fill(date);
  await host.getByLabel('Closed through', { exact: true }).fill(date);
  await host.getByRole('button', { name: 'Apply date window', exact: true }).click();
  const expected = payload.profiles.map(row => ({ ...row, evidence: row.evidence.filter(e => e.closed_on === date) })).filter(row => row.evidence.length);
  const rows = host.locator('tbody tr');
  assert.equal(await rows.count(), expected.length, 'one-day group membership');
  for (let i = 0; i < expected.length; i++) {
    const row = rows.nth(i), profile = expected[i];
    const cells = await row.locator('td').allTextContents();
    assert.deepEqual(cells.slice(0,3), [profile.vertical || 'Unrecorded', profile.deal_type || 'Unrecorded', `${profile.city || 'Unrecorded'} / ${profile.state || 'Unrecorded'}`]);
    assert.equal(cells[3], `${profile.won_deals} ${profile.won_deals === 1 ? 'deal' : 'deals'}`);
    assert.equal(cells[4], `${profile.clients} ${profile.clients === 1 ? 'client' : 'clients'}`);
    assert.equal(cells[5], String(profile.evidence.length));
    await row.locator('details summary').click();
    assert.deepEqual(await row.locator('a').allTextContents(), profile.evidence.map(e => `${e.deal_name?.trim() || 'Won deal'} · ${e.closed_on}`));
    assert.deepEqual(await row.locator('time').allTextContents(), profile.evidence.map(e => e.closed_on));
    assert.deepEqual(await row.locator('time').evaluateAll(times => times.map(time => time.getAttribute('datetime'))), profile.evidence.map(e => e.closed_on));
    assert.deepEqual(await row.locator('a').evaluateAll(links => links.map(a => a.getAttribute('href'))), profile.evidence.map(e => `/deals?deal=${e.deal_id}`));
  }
  const table = host.getByRole('table');
  for (const name of ['Full-history wins','Full-history distinct clients','Matching evidence']) assert.ok(await table.getByRole('columnheader', { name, exact: true }).count());
  await host.getByRole('button', { name: 'Clear date window', exact: true }).click();
  assert.equal(await rows.count(), payload.profiles.length, 'clear restores loaded groups');
  assert.deepEqual(await rows.locator('a').evaluateAll(links => links.map(a => a.getAttribute('href'))), payload.profiles.flatMap(row => row.evidence.map(e => `/deals?deal=${e.deal_id}`)));
  return { date, groups: expected.length, evidence: expected.reduce((sum,row) => sum + row.evidence.length,0) };
}

export async function prove({ origin, expectedCommit, cdpUrl, timeoutMs = 30000, fixture = false, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(base.origin === origin && !base.username && !base.password && (base.protocol === 'https:' || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)));
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000);
  assert.ok(!fixture || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname));
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(insufficient('Proof deadline exceeded')), timeoutMs);
  const remaining = () => { controller.signal.throwIfAborted(); const ms = Math.ceil(deadline-performance.now()); if (ms <= 0) throw insufficient('Proof deadline exceeded'); return ms; };
  let guard;
  let browser, page, requests = 0, bytes = 0;
  const read = async url => {
    remaining(); assert.equal(url.origin, origin);
    if (++requests > 40) throw insufficient('Request budget exceeded');
    const response = await proofFetch(url, { signal: controller.signal });
    if (!response.ok) throw insufficient('Evidence unavailable');
    const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16*1024*1024) throw insufficient('Byte budget exceeded'); chunks.push(chunk); }
    return { type: response.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  };
  try {
    const release = await readAppRelease(origin, read);
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw insufficient('Expected merge commit required');
    if (release.source_commit !== expectedCommit) {
      await new Promise((resolve,reject) => {
        let failure;
        const child = execFile('git', ['merge-base','--is-ancestor',expectedCommit,release.source_commit], { timeout: remaining(), signal: controller.signal, killSignal: 'SIGKILL' }, error => { failure = error; });
        child.once('close', () => failure ? reject(insufficient('Release does not prove merge containment')) : resolve());
      });
    }
    let payload, reads = 0;
    if (fixture) {
      browser = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
      page = await browser.newPage();
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/mcp') return route.continue();
        if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
        if (url.pathname === '/__window_proof') return route.fulfill({ contentType:'text/html',body:'<!doctype html><title>Window proof</title>' });
        if (!/^\/js\/[\w.-]+\.m?js$/.test(url.pathname)) return route.abort();
        try { const asset = await read(url); return route.fulfill({ contentType:asset.type,body:asset.body }); } catch { return route.abort(); }
      });
      guard = await guardProofReads(page, origin);
      await page.goto(`${origin}/__window_proof`);
      await guard.load(remaining());
      payload = JSON.parse(await readFile(new URL('../test/fixtures/historical-close-window/recordings.json',import.meta.url))).full;
      await page.evaluate(async ({ payload }) => {
        const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.generated.js');
        const host = document.createElement('main'); document.body.replaceChildren(host);
        window.closeProofReads = 0;
        mountIdealClientProfile(host,{ getIdealClientProfile() { window.closeProofReads++; return Promise.resolve(payload); } });
      },{payload});
      await page.getByText('Historical client fit',{exact:true}).click();
    } else {
      if (!cdpUrl) throw insufficient('Signed-in CDP session required');
      const cdp = new URL(cdpUrl);
      assert.ok(['http:', 'ws:'].includes(cdp.protocol) && ['localhost','127.0.0.1','[::1]'].includes(cdp.hostname) && !cdp.username && !cdp.password);
      const borrowed = { launch: async options => {
        let connection;
        try { connection = await engine.connectOverCDP(cdpUrl,{timeout:options.timeout}); }
        catch { throw insufficient('Signed-in CDP session unavailable'); }
        let pendingPage, cleanup;
        return { newPage: async () => {
          const context = connection.contexts()[0];
          if (!context) throw insufficient('Signed-in context unavailable');
          pendingPage = context.newPage().catch(() => { throw insufficient('Signed-in page unavailable'); });
          return pendingPage;
        }, close: () => cleanup ||= (async () => {
          try { await pendingPage?.then(page => page.close()).catch(() => {}); }
          finally { await connection.close(); }
        })() };
      } };
      browser = await launchProofBrowser(borrowed,{timeout:remaining()},{signal:controller.signal});
      page = await browser.newPage();
      guard = await guardProofReads(page, origin);
      page.on('request', request => {
        if (new URL(request.url()).origin !== origin) return;
        try { if (request.postDataJSON()?.params?.name === 'ideal-client-profile') reads++; } catch {}
      });
      page.on('response', response => {
        const request = response.request();
        if (new URL(response.url()).origin !== origin) return;
        let body; try { body = request.postDataJSON(); } catch { return; }
        if (body?.params?.name !== 'ideal-client-profile') return;
        payload = response.json().then(envelope => {
          const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
          if (!text) throw insufficient('Historical response unavailable');
          return JSON.parse(text);
        });
        payload.catch(() => {});
      });
      try { await page.goto(`${origin}/?view=charts`, { waitUntil: "domcontentloaded" }); } catch { throw insufficient('Signed-in page navigation unavailable'); }
      await guard.load(remaining());
      assert.notEqual(new URL(page.url()).pathname, '/leads', 'Historical client fit belongs on charts');
      const host = page.getByRole('region',{name:'Historical client fit',exact:true});
      if (!await host.count()) throw insufficient('Signed-in Historical client fit unavailable');
      await host.locator('summary').first().click();
      try { await host.getByRole('table').waitFor({timeout:remaining()}); } catch { throw insufficient('No readable completed wins in signed-in session'); }
      if (!payload) throw insufficient('Natural producer response not observed');
      payload = await payload;
    }
    page.setDefaultTimeout(remaining());
    const beforeReads = reads;
    const observation = await windowAssertions(page,payload);
    if (fixture) assert.equal(await page.evaluate(() => window.closeProofReads),1,'local edits cause no read');
    else assert.equal(reads,beforeReads,'local edits cause no read');
    guard.assertSafe();
    const after = await readAppRelease(origin,read);
    if (!fixture) assert.equal(reads,beforeReads,'local edits cause no request');
    if (after.source_commit !== release.source_commit) throw insufficient('Release changed during proof');
    guard.assertSafe();
    return {writes: guard.writes, status:fixture?'fixture_pass':'passed',release,observation,requests};
  } catch (error) {
    guard?.assertSafe();
    if (controller.signal.aborted || error.name === 'TimeoutError') throw insufficient('Proof deadline exceeded');
    throw error;
  } finally { guard?.dispose(); clearTimeout(timer); await browser?.close(); guard?.assertSafe(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const {values} = parseArgs({options:{origin:{type:'string'},'expected-commit':{type:'string'},'cdp-url':{type:'string'},'timeout-ms':{type:'string',default:'30000'},fixture:{type:'boolean'}}});
    console.log(JSON.stringify(await prove({origin:values.origin,expectedCommit:values['expected-commit'],cdpUrl:values['cdp-url'],timeoutMs:Number(values['timeout-ms']),fixture:values.fixture})));
  } catch(error) { console.log(JSON.stringify({status:error.exitCode===78?'insufficient_evidence':'assertion_failure',error:error.message})); process.exitCode=error.exitCode||1; }
}
