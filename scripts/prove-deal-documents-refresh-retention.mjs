import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const refreshRecordings = JSON.parse(readFileSync(new URL('../test/fixtures/deal-documents-refresh-retention/recordings.json', import.meta.url), 'utf8'));

export async function observeRefreshRetention({ assetUrl, recordings, failure = 'network', replacement = 'nonempty' }) {
  const { mountDealDocuments } = await import(assetUrl);
  const target = document.createElement('main'); document.body.replaceChildren(target);
  const pending = [], requests = [];
  const panel = mountDealDocuments(target, { dealId: '11111111-1111-4111-8111-111111111111', client: {
    listDealDocuments(args, { signal }) { requests.push(args); return new Promise((resolve, reject) => pending.push({ resolve, reject, signal })); },
  } });
  const response = name => structuredClone(recordings[name].response);
  const names = name => response(name).documents.map(row => row.display_name).join();
  const oldNames = [names('initial'), names('second')].join();
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rows = () => [...target.querySelectorAll('[data-document-id]')].map(node => node.querySelector('h3').textContent);
  const click = name => { const button = [...target.querySelectorAll('button')].find(node => node.textContent === name); if (!button) throw Error(`Missing ${name}`); button.click(); };
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const deliver = name => {
    const { request: expectedRequest } = recordings[name];
    check(JSON.stringify(requests.at(-1)) === JSON.stringify(expectedRequest), `recorded ${name} request matches production call`);
    pending.shift().resolve(response(name));
  };
  try {
    deliver('initial'); await settle();
    check(rows().join() === names('initial'), 'initial metadata validated');
    target.querySelector('summary').click(); check(target.querySelector('details').open, 'identity disclosure');
    click('Load more documents'); deliver('second'); await settle();
    click('Refresh documents'); await settle();
    check(rows().join() === oldNames, 'pending refresh retains last successful read');
    check(target.textContent.includes('Last successful read'), 'pending stale notice');
    if (failure === 'malformed') pending.shift().resolve({ ...response('empty'), schema_version: 'wrong' });
    else pending.shift().reject(Object.assign(Error('Synthetic outage'), failure === 'network' ? {} : { status: Number(failure) }));
    await settle();
    if (['401', '403'].includes(failure)) {
      check(rows().length === 0 && target.textContent.includes('Session expired'), 'authorization clears metadata');
      return { authorizationCleared: true };
    }
    check(rows().join() === oldNames && target.textContent.includes('Last successful read'), 'failed refresh retains stale metadata');
    click('Retry documents'); await settle();
    check(requests.at(-1).cursor === undefined, 'refresh retry starts at null');
    check(rows().length === 100, 'retry retains display');
    if (replacement === 'dispose' || replacement === 'invalidate') {
      const held = pending.shift();
      let nextPanel;
      if (replacement === 'dispose') {
        panel.dispose();
        nextPanel = mountDealDocuments(target, { dealId: '22222222-2222-4222-8222-222222222222', client: { async listDealDocuments() { return response('empty'); } } });
      }
      else window.dispatchEvent(new Event('doctorcre-session-invalidated'));
      check(held.signal.aborted, 'pending refresh aborted');
      held.resolve(response('late')); await settle();
      check(rows().length === 0, 'late result cannot restore metadata');
      nextPanel?.dispose();
    } else {
      deliver(replacement === 'empty' ? 'empty' : 'replacement'); await settle();
      check(rows().join() === (replacement === 'empty' ? '' : names('replacement')), 'replacement is atomic, permits repeated old ID and cursor');
      check(!target.textContent.includes('Last successful read'), 'successful refresh removes stale notice');
      if (replacement === 'empty') check(target.textContent.includes('No documents filed'), 'empty success clears listing');
      else {
        click('Load more documents'); pending.shift().reject(Error('Synthetic page outage')); await settle();
        click('Retry documents'); check(requests.at(-1).cursor === recordings.replacement.response.next_cursor, 'failed load more retries same cursor');
        check(rows().join() === names('replacement'), 'failed load more retains rows');
        deliver('next'); await settle();
        check(rows().join() === [names('replacement'), names('next')].join(), 'load more appends new scan only');
      }
    }
    return { retained: true, retryCursor: null, replacement, requestCount: requests.length };
  } finally { panel.dispose(); }
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(base.origin === origin && ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password, 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 300000, 'bounded timeout');
  const abort = new AbortController();
  const timeoutError = Object.assign(Error('Proof deadline exceeded'), { exitCode: 78 });
  const timer = setTimeout(() => abort.abort(timeoutError), timeoutMs);
  let browser, requests = 0, bytes = 0;
  const assets = new Map();
  async function read(url) {
    assert.ok(++requests <= 64, 'request cap');
    const response = await proofFetch(url, { signal: abort.signal });
    if (!response.ok) throw Object.assign(Error(`Asset HTTP ${response.status}`), { exitCode: 78 });
    const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 4 * 1024 * 1024, 'byte cap'); chunks.push(chunk); }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  }
  try {
    const release = await readAppRelease(base, read);
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: abort.signal });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.origin !== origin) return route.abort();
      if (url.pathname === '/__documents-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      if (!/^\/js\/[\w.-]+\.js$/.test(url.pathname)) return route.abort();
      try {
        if (!assets.has(url.href)) {
          const asset = await read(url); assert.match(asset.type, /javascript/);
          assets.set(url.href, asset);
        }
        await route.fulfill({ contentType: 'text/javascript', body: assets.get(url.href).body });
      } catch { await route.abort(); }
    });
    const page = await context.newPage();
    await page.goto(`${origin}/__documents-proof`);
    const observed = await page.evaluate(observeRefreshRetention, { assetUrl: `${origin}/js/ui-deal-documents.js`, recordings: refreshRecordings });
    const after = await readAppRelease(base, read);
    assert.deepEqual(after, release, 'unchanged app release');
    return { ok: true, release, after, deployed_asset_fixture: observed, natural_authenticated_observation: 'insufficient_evidence',
      production_acceptance: false, requests, assets: [...assets].map(([url, asset]) => ({ url, sha256: createHash('sha256').update(asset.body).digest('hex') })) };
  } catch (error) { throw abort.signal.aborted ? timeoutError : error; }
  finally { clearTimeout(timer); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    console.log(JSON.stringify(await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms'] || 30000) })));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, production_acceptance: false })); process.exitCode = error.exitCode || 1; }
}
