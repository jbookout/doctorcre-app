import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

class ProtectedAsset extends Error {}
let browser, timer;
const errors = [];
try {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
  const origin = new URL(values.origin);
  const timeout = Number(values['timeout-ms'] ?? 30000);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) throw Error('Invalid origin or timeout');
  const abort = new AbortController();
  const started = Date.now();
  const assets = new Map();
  let requests = 0, bytesLoaded = 0;
  const request = async url => {
    if (++requests > 64) throw Error('Request limit exceeded');
    const response = await proofFetch(url, { redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(timeout, 10000))]) });
    if ([401, 403].includes(response.status) || response.status >= 300 && response.status < 400) throw new ProtectedAsset('Protected asset or sign-in');
    if (!response.ok) throw Object.assign(Error(`HTTP ${response.status}`), { status: response.status });
    const reader = response.body.getReader(), chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesLoaded += value.length;
      if (bytesLoaded > 1024 * 1024) { await reader.cancel(); throw Error('Asset byte limit exceeded'); }
      chunks.push(Buffer.from(value));
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  };
  const run = async () => {
    const releaseUrl = new URL('/app-release', origin).href;
    const release = await readAppRelease(origin, request);
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, timeout - (Date.now() - started)) }, { signal: abort.signal });
    abort.signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on('pageerror', error => errors.push(error));
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() !== 'GET' || url.origin !== origin.origin || !url.pathname.startsWith('/js/') || !url.pathname.endsWith('.js') || url.search) return route.abort();
      try {
        let asset = assets.get(url.href);
        if (!asset) {
          const response = await request(url.href);
          if (!/javascript/.test(response.type)) throw new ProtectedAsset('Asset is protected or not JavaScript');
          asset = { ...response, hash: createHash('sha256').update(response.body).digest('hex') };
          assets.set(url.href, asset);
        }
        await route.fulfill({ body: asset.body, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
      } catch (error) { errors.push(error); await route.abort(); }
    });
    await page.setContent('<!doctype html><html><body><main id="documents"></main></body></html>');
    await page.evaluate(async entry => {
      const { mountDealDocuments } = await import(entry);
      let offset = 0;
      window.proofRequests = 0;
      window.proofPanel = mountDealDocuments(document.querySelector('#documents'), {
        dealId: '11111111-1111-4111-8111-111111111111',
        client: { async listDealDocuments(args) {
          if (args.limit !== 50) throw Error('Changed server page contract');
          if (++window.proofRequests > 11) throw Error('Pagination exceeded cap');
          const documents = Array.from({ length: 49 }, () => ({
            id: `00000000-0000-4000-8000-${String(++offset).padStart(12, '0')}`,
            display_name: `Synthetic document ${offset}`, document_type: null, page_count: null,
            content_hash: 'a'.repeat(64), stored_at: '2026-01-01T00:00:00Z',
          }));
          return { ok: true, schema_version: 'deal-documents.v1', documents, has_more: true, next_cursor: String(offset) };
        } },
      });
    }, new URL('/js/ui-deal-documents.generated.js', origin).href);
    for (let index = 1; index <= 10; index++) {
      await page.waitForFunction(count => document.querySelectorAll('[data-document-id]').length === count, index * 49);
      await page.getByRole('button', { name: 'Load more documents', exact: true }).click();
    }
    await page.getByText('Showing the first 500 documents. Refresh to start again.', { exact: true }).waitFor();
    const observed = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-document-id]').length, requests: window.proofRequests }));
    if (observed.rows !== 500 || observed.requests !== 11 || await page.getByRole('button', { name: 'Load more documents', exact: true }).count()) throw Error('Hard cap assertion failed');
    if (errors.length) throw errors[0];
    await page.evaluate(() => window.proofPanel.dispose());
    const readback = await readAppRelease(origin, request);
    if (readback.source_commit !== release.source_commit) throw Error('Release changed during proof');
    return { schema: 'deal-documents-hard-cap-proof.v1', origin: origin.origin, release_url: releaseUrl, release,
      assets: [...assets].map(([url, asset]) => ({ url, sha256: asset.hash, bytes: asset.body.length })),
      assertions: { passed: 4, failed: 0 }, observed, network_requests: requests,
      limitation: 'Deployed synthetic resilience only. Natural private-data coverage remains unproven.' };
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(Error('Whole-run timeout')); reject(abort.signal.reason); }, timeout); });
  console.log(JSON.stringify(await Promise.race([run(), deadline])));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = error.exitCode || (error instanceof ProtectedAsset || errors.some(error => error instanceof ProtectedAsset) ? 78 : 1);
} finally {
  clearTimeout(timer);
  await browser?.close();
}
