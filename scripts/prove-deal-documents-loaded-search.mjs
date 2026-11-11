import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';

const insufficient = message => Object.assign(Error(message), { exitCode: 78 });
const recordings = JSON.parse(await readFile(new URL('../test/fixtures/deal-documents-loaded-search/recordings.json', import.meta.url)));

export async function observeLoadedSearch(page, assetUrl) {
  await page.evaluate(async ({ assetUrl, recordings }) => {
    const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
    const { request: initialRequest } = recordings.initial;
    window.loadedSearchRequests = [];
    window.loadedSearchPanel = mountDealDocuments(document.querySelector('main'), {
      dealId: initialRequest.deal_id,
      client: { async listDealDocuments(args) {
        window.loadedSearchRequests.push(args);
        const { request: expectedRequest, response } = args.cursor ? recordings.second : recordings.initial;
        if (JSON.stringify(args) !== JSON.stringify(expectedRequest)) throw Error('Recorded request differs');
        return response;
      } },
    });
  }, { assetUrl, recordings });
  const search = page.getByRole('searchbox', { name: 'Search loaded documents', exact: true });
  const type = page.getByRole('combobox', { name: 'Document type', exact: true });
  const ids = () => page.locator('[data-document-id]').evaluateAll(rows => rows.map(row => row.dataset.documentId));
  const check = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(message); };
  await search.fill('lEaSe');
  check(await ids(), recordings.initial.response.documents.filter(doc => /lease/i.test(doc.display_name)).map(doc => doc.id), 'Case insensitive name match');
  await search.fill(''); await type.selectOption('type:application/pdf');
  check(await ids(), recordings.initial.response.documents.filter(doc => doc.document_type === 'application/pdf').map(doc => doc.id), 'Exact MIME match');
  await search.fill('lease'); check(await ids(), [], 'Both predicates apply');
  check(await page.evaluate(() => window.loadedSearchRequests.length), 1, 'Local changes made another call');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  check(await search.evaluate(el => el === document.activeElement), true, 'Clear focus');
  check(await ids(), recordings.initial.response.documents.map(doc => doc.id), 'Clear restores order');
  await search.fill('later'); check(await ids(), [], 'Loaded-only miss');
  await page.getByRole('button', { name: 'Load more documents', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-document-id]').length === 1);
  check(await ids(), recordings.second.response.documents.map(doc => doc.id), 'Later-page match');
  check(await page.evaluate(() => window.loadedSearchRequests.length), 2, 'Explicit pagination only');
  await page.evaluate(() => window.loadedSearchPanel.dispose());
  return { loaded: 51, matching: 1, list_calls: 2, assertions: 9 };
}

export async function proveLoadedSearch({ origin, timeout = 30000, syntheticOnly = false, engine = chromium }) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) throw Error('Invalid origin or timeout');
  if (syntheticOnly && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Synthetic success is loopback-only');
  const abort = new AbortController(), assets = new Map();
  let browser, timer, pendingBrowser, acquisition, requests = 0, bytes = 0;
  const read = async target => {
    if (++requests > 64) throw insufficient('Request budget exceeded');
    const response = await proofFetch(target, { signal: abort.signal, redirect: 'manual' });
    if (!response.ok) throw insufficient(`Protected or unavailable asset (${response.status})`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw insufficient('Asset byte budget exceeded');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  };
  const run = async () => {
    const before = await readAppRelease(url, read);
    pendingBrowser = launchProofBrowser({ launch(options) { acquisition = engine.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }); return acquisition; } }, { args: [...CHROMIUM_SAFETY_ARGS], timeout }, { signal: abort.signal });
    browser = await pendingBrowser;
    abort.signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
    const page = await context.newPage(); page.setDefaultTimeout(timeout);
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    await context.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (route.request().method() === 'GET' && target.origin === url.origin && target.pathname === '/__loaded-search-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' });
      if (route.request().method() !== 'GET' || target.origin !== url.origin || !/^\/js\/[\w/.-]+\.js$/.test(target.pathname) || target.search) return route.abort();
      try {
        let asset = assets.get(target.href);
        if (!asset) {
          asset = await read(target);
          if (!/javascript/.test(asset.type)) throw insufficient('Protected JavaScript');
          assets.set(target.href, asset);
        }
        await route.fulfill({ body: asset.body, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
      } catch (error) { errors.push(error); await route.abort().catch(() => {}); }
    });
    await page.goto(new URL('/__loaded-search-proof', url).href);
    const observed = await observeLoadedSearch(page, new URL('/js/ui-deal-documents.generated.js', url).href);
    if (errors.length) throw errors[0];
    const after = await readAppRelease(url, read);
    if (after.source_commit !== before.source_commit) throw insufficient('Release changed during observation');
    return { schema: 'deal-documents-loaded-search-proof.v1', release_before: before, release_after: after, observed,
      assets: [...assets].map(([url, asset]) => ({ url, sha256: createHash('sha256').update(asset.body).digest('hex') })),
      natural: { status: 'insufficient_evidence', reason: 'Fresh unsigned browser has no visible selected private deal. Signed-in observation belongs to WR649.S3.J3.' } };
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(insufficient('Whole-run deadline exceeded')); reject(abort.signal.reason); }, timeout); });
  try {
    const receipt = await Promise.race([run(), deadline]);
    return { code: syntheticOnly ? 0 : 78, receipt };
  } finally {
    clearTimeout(timer);
    abort.abort(insufficient('Observation retired'));
    await browser?.close().catch(() => {});
    await acquisition?.then(acquired => acquired.close(), () => {}).catch(() => {});
    await pendingBrowser?.then(acquired => acquired.close(), () => {}).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'synthetic-only': { type: 'boolean', default: false } } });
    const result = await proveLoadedSearch({ origin: values.origin, timeout: Number(values['timeout-ms'] || 30000), syntheticOnly: values['synthetic-only'] });
    console.log(JSON.stringify(result.receipt)); process.exitCode = result.code;
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = error.exitCode || 1; }
}
