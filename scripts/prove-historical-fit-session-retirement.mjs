import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function responseFixture() {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/ideal-client-profile.json', import.meta.url)));
  assert.equal(contract.write, false);
  assert.equal(contract.schema_version, 'ideal-client-profile.v1');
  assert.equal(contract.coverage, 'recorded_closed_won_only');
  assert.deepEqual(contract.profiles.evidence, { deal_id: 'UUID', closed_on: 'date' });
  assert.equal(contract.profiles.won_deals, 'integer');
  assert.equal(contract.profiles.clients, 'distinct client integer');
  return { schema_version: contract.schema_version, coverage: contract.coverage, profiles: [{ vertical: 'Synthetic dental', deal_type: 'lease', city: 'Synthetic city', state: 'TX', won_deals: 1, clients: 1, hypothesis: contract.profiles.hypothesis, evidence: [{ deal_id: '00000000-0000-4000-8000-000000000001', closed_on: '2024-02-29' }] }] };
}

export async function retirementAssertions(page, moduleURL) {
  const payload = await responseFixture();
  const assertions = [];
  await page.evaluate(async ({ moduleURL, payload }) => {
    const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.generated.js');
    if (typeof mountIdealClientProfile !== 'function') throw Error('missing mountIdealClientProfile export');
    const host = document.createElement('main'); document.body.append(host);
    const p = window.retirementProof = { payload, reads: [], pending: [], mode: 'ready' };
    p.remount = mode => {
      p.mount?.dispose(); p.mode = mode; p.reads = []; p.pending = [];
      p.mount = mountIdealClientProfile(host, { getIdealClientProfile(filters) {
        p.reads.push(filters);
        if (p.mode === 'loading') return new Promise((resolve, reject) => p.pending.push({ resolve, reject }));
        if (p.mode === 'error') return Promise.reject(Error('synthetic failure'));
        return Promise.resolve(p.payload);
      } });
    };
    p.remount('ready');
  }, { moduleURL, payload });
  const host = page.locator('main').last();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const state of ['idle', 'loading', 'ready', 'error']) {
    await page.evaluate(state => window.retirementProof.remount(state), state);
    if (state !== 'idle') {
      await host.locator('summary').first().click();
      await host.getByRole(state === 'loading' ? 'status' : state === 'error' ? 'alert' : 'table').waitFor();
    }
    await page.evaluate(() => {
      const p = window.retirementProof;
      p.controls = [...document.querySelector('main').querySelectorAll('details,form,button,input')];
      window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    });
    assert.equal(await host.locator('table,input,button,details').count(), 0, `${state} removes private rows and controls`);
    await host.getByRole('status').filter({ hasText: 'Sign in again' }).waitFor();
    const reads = await page.evaluate(() => window.retirementProof.reads.length);
    for (const reject of [false, true]) {
      await page.evaluate(reject => {
        const p = window.retirementProof;
        p.mount.clear(); window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('doctorcre-session-invalidated'));
        p.controls.forEach(el => {
          el.click(); if (el.tagName === 'DETAILS') el.open = true;
          el.dispatchEvent(new Event(el.tagName === 'FORM' ? 'submit' : 'toggle', { bubbles: true, cancelable: true }));
        });
        p.pending.forEach(item => reject ? item.reject(Error('late failure')) : item.resolve(p.payload));
      }, reject);
      await settle();
      assert.equal(await page.evaluate(() => window.retirementProof.reads.length), reads);
      assert.equal(await host.locator('table').count(), 0);
      assert.doesNotMatch(await host.innerText(), /Synthetic city|Synthetic dental/);
      await host.getByRole('status').filter({ hasText: 'Sign in again' }).waitFor();
    }
    await page.evaluate(() => { const p = window.retirementProof; p.mount.dispose(); p.mount.clear(); p.mount.dispose(); });
    assert.equal(await host.innerText(), '');
    assertions.push(`${state}: terminal invalidation refuses former controls, clear, repeated events and late receipts; disposal unmounts`);
  }
  for (const action of ['clear', 'pagehide']) {
    await page.evaluate(() => window.retirementProof.remount('ready'));
    await host.locator('summary').first().click(); await host.getByRole('table').waitFor();
    await page.evaluate(action => {
      if (action === 'clear') window.retirementProof.mount.clear(); else window.dispatchEvent(new Event('pagehide'));
    }, action);
    assert.equal(await host.locator('table').count(), 0);
    await host.locator('summary').first().click(); await host.getByRole('table').waitFor();
    assert.equal(await page.evaluate(() => window.retirementProof.reads.length), 2);
    await page.evaluate(() => { window.retirementProof.mount.clear(); window.dispatchEvent(new Event('doctorcre-session-invalidated')); });
    assert.equal(await host.locator('details').count(), 0);
    assertions.push(`${action}: same-session recovery works; explicit clear before invalidation still retires`);
  }
  for (const reject of [false, true]) {
    await page.evaluate(() => window.retirementProof.remount('loading'));
    await host.locator('summary').first().click(); await host.getByRole('status').waitFor();
    await page.evaluate(reject => {
      const p = window.retirementProof; p.mount.dispose();
      p.pending.forEach(item => reject ? item.reject(Error('late failure')) : item.resolve(p.payload));
      p.mount.clear(); window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    }, reject);
    await settle(); assert.equal(await host.innerText(), '');
    assert.equal(await page.evaluate(() => window.retirementProof.reads.length), 1);
    assertions.push(`dispose: late ${reject ? 'failure' : 'success'} remains hidden and cannot read`);
  }
  return assertions;
}

export function options(args) {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
  if (values.help) return { help: true };
  const url = new URL(values.origin);
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.href, `${url.origin}/`, 'origin must have no credentials, path, query or fragment');
  const timeout = Number(values['timeout-ms']);
  assert.ok(Number.isInteger(timeout) && timeout >= 100 && timeout <= 30000, 'timeout must be 100..30000 ms');
  return { origin: url.origin, timeout };
}

export async function prove({ origin, timeout }) {
  let browser, timer, expired = false, unavailable;
  const assets = [], signal = AbortSignal.timeout(timeout);
  const work = async () => {
    let release;
    try {
      release = await readAppRelease(origin, async url => {
        const response = await proofFetch(url, { redirect: 'error', signal, cache: 'no-store' });
        assert.ok(response.ok, 'release unavailable');
        return { type: response.headers.get('content-type') || '', body: Buffer.from(await response.arrayBuffer()) };
      });
    } catch (error) { unavailable = `release unavailable: ${error.message}`; throw error; }
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout });
    if (expired) { await browser.close(); throw Error('deadline exceeded'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(timeout);
    let bytes = 0, requests = 1;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'GET' && url.href === `${origin}/__historical_retirement_proof__`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic retirement proof</title>' });
      if (req.method() !== 'GET' || url.origin !== origin || !/^\/js\/(ui-ideal-client-profile\.generated\.js|ui-shared-[A-Z0-9]+\.generated\.js)$/.test(url.pathname) || ++requests > 31) {
        unavailable = `asset outside allowlist or asset cap: ${url.pathname}`; return route.abort();
      }
      try {
        const response = await proofFetch(url, { signal, redirect: 'error', cache: 'no-store' });
        assert.ok(response.ok && /javascript/.test(response.headers.get('content-type') || ''), `asset unavailable: ${url.pathname}`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; bytes += chunk.length;
          assert.ok(bytes <= 10 * 1024 * 1024, 'asset byte cap exceeded'); chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        assets.push({ path: url.pathname, bytes: size, sha256: createHash('sha256').update(body).digest('hex') });
        return route.fulfill({ contentType: 'text/javascript', body });
      } catch (error) { unavailable = error.message; return route.abort(); }
    });
    await page.goto(`${origin}/__historical_retirement_proof__`);
    const assertions = await retirementAssertions(page, `${origin}/js/ui-ideal-client-profile.generated.js`);
    assert.ok(!unavailable, unavailable);
    return { origin, release, assets, assertions, requests, bytes, scope: 'deployed synthetic behavior; no natural business journey' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(Error('deadline exceeded')); }, timeout); })]);
  } catch (error) {
    const failure = new Error(unavailable || (expired || signal.aborted ? 'deadline exceeded while fetching release or assets' : error.message), { cause: error });
    failure.exitCode = unavailable || expired || signal.aborted ? 78 : 1;
    throw failure;
  } finally { clearTimeout(timer); await browser?.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) console.log('Usage: node scripts/prove-historical-fit-session-retirement.mjs --origin <https-origin> --timeout-ms 30000\nGET deployed assets only. No retries. Exits 0 on success, 1 on contradiction, 78 on unavailable release/assets/deadline.');
    else console.log(JSON.stringify(await prove(parsed)));
  } catch (error) { console.error(`Historical fit retirement proof failed: ${error.message}`); process.exitCode = error.exitCode || 1; }
}
