import assert from 'node:assert/strict';
import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { overdueFixture } from './prove-home-overdue-task-slice.mjs';
import { init, parse } from 'es-module-lexer';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeSearch(page, snapshot, calls) {
  const search = page.getByRole('searchbox', { name: 'Search loaded cards' });
  await search.waitFor();
  const inboxCalls = () => calls.filter(name => /home-inbox|one-action|home-waiting|home-review/.test(name)).length;
  const before = inboxCalls();
  await search.fill('  PIPELINE  ');
  await page.getByText(`1 matching loaded cards of ${snapshot.items.length} loaded`, { exact: true }).waitFor();
  const ids = await page.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => row.dataset.inboxRow));
  assert.deepEqual(ids, snapshot.items.filter(item => [item.title, item.context_label, item.kind_label].some(value => value?.toLowerCase().includes('pipeline'))).map(item => item.item_id));
  await search.fill('[does not exist]');
  await page.getByText('No loaded cards match your search.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  await page.getByRole('search').getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByText(`${snapshot.items.length} matching loaded cards of ${snapshot.items.length} loaded`, { exact: true }).waitFor();
  assert.equal(inboxCalls(), before, 'typing and clearing perform no inbox RPC or mutation');
  return ['trimmed-case-insensitive-title-subset', 'literal-empty-state', 'clear-restores-loaded-count', 'search-makes-no-RPC'];
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium, observe = observeSearch }) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('Expected bare http(s) origin');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('timeout-ms must be 1..30000');
  let browser, timer, bytes = 0;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const assets = new Map();
  const allowed = new Set(['/js/ui-inbox.generated.js', '/js/boot-mode.js', '/js/private-session.js', '/js/mcp-requests.mjs']);
  const receipt = { release: null, assets: [], assertions: [], synthetic: true, deployed_module: 'fixture assertions only', natural_acceptance: 'insufficient_evidence' };
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const fetchBytes = async path => {
    let response;
    try { response = await proofFetch(url.origin + path, { signal: controller.signal, redirect: 'error' }); }
    catch { throw unavailable(`Unavailable asset ${path}`); }
    if (!response.ok) throw unavailable(`Unavailable asset ${path}: ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) throw unavailable('Asset byte budget exceeded');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const asset = async path => {
    if (assets.has(path)) return assets.get(path);
    if (!allowed.has(path) || !/^\/js\/[a-zA-Z0-9_.-]+\.m?js$/.test(path) || assets.size >= 30) throw unavailable(`Asset outside allowlist or budget: ${path}`);
    const pending = (async () => {
      const body = await fetchBytes(path);
      const [imports] = parse(body.toString());
      for (const entry of imports) if (entry.n?.startsWith('.')) {
        const dependency = new URL(entry.n, url.origin + path);
        if (dependency.origin === url.origin) allowed.add(dependency.pathname);
      }
      receipt.assets.push({ path, sha256: createHash('sha256').update(body).digest('hex') });
      return body;
    })();
    assets.set(path, pending);
    return pending;
  };
  const worker = (async () => {
    try {
      await init;
      receipt.release = await readAppRelease(url, async url => ({ type: 'application/json', body: await fetchBytes(url.pathname) }));
      controller.signal.throwIfAborted();
      const snapshot = overdueFixture();
      snapshot.items[0].title = 'Synthetic pipeline follow-up';
      controller.signal.throwIfAborted();
      const calls = []; let assetFailure; let rpcCount = 0;
      browser = await launchProofBrowser(engine, { args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, Math.ceil(deadline - performance.now())) }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const context = await browser.newContext({ serviceWorkers: 'block' });
      context.setDefaultTimeout(Math.min(5000, Math.floor(timeoutMs / 2)));
      await context.route('**/*', async route => {
        const request = route.request(), target = new URL(request.url());
        if (target.origin !== url.origin) return route.abort();
        if (target.pathname === '/mcp' && request.method() === 'POST') {
          if (++rpcCount > 64) return route.abort();
          const { name, arguments: args } = request.postDataJSON().params;
          if (name !== 'read-home-inbox-v5') return route.abort();
          calls.push(name);
          try {
            assert.deepEqual(args, {}, 'read-home-inbox-v5 has no arguments');
            return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
          } catch { return route.abort(); }
        }
        if (request.method() !== 'GET') return route.abort();
        if (target.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
        if (target.pathname === '/js/app-shell.js') return route.fulfill({ contentType: 'text/javascript', body: 'export {}' });
        if (target.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof' } });
        try { return await route.fulfill({ contentType: 'text/javascript', body: await asset(target.pathname) }); }
        catch (error) { assetFailure = error; return route.abort(); }
      });
      controller.signal.throwIfAborted();
      const page = await context.newPage();
      controller.signal.throwIfAborted();
      await page.goto(url.origin + '/?mode=live');
      try { receipt.assertions = await observe(page, snapshot, calls); }
      catch (error) { throw assetFailure || error; }
      if (!receipt.assets.some(entry => entry.path === '/js/ui-inbox.generated.js')) throw unavailable('Inbox entry unavailable');
      receipt.fetched_bytes = bytes;
      if (Buffer.byteLength(JSON.stringify(receipt)) > 65536) throw Error('Receipt budget exceeded');
      return receipt;
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally { await browser?.close(); }
  })();
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = unavailable('Proof deadline exceeded');
      controller.abort(error);
      void browser?.close().catch(() => {});
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([expired, worker]); }
  finally {
    controller.abort();
    await worker.catch(() => {});
    clearTimeout(timer);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/prove-home-loaded-card-search.mjs --origin https://app.doctorcre.com --timeout-ms 30000');
    else { const receipt = await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) }); console.log(JSON.stringify(receipt)); process.exitCode = 78; }
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, natural_acceptance: 'insufficient_evidence' })); process.exitCode = error.exitCode || 1; }
}
