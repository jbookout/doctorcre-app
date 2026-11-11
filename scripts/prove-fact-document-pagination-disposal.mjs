import { proofFetch, launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observePagination({ mountFactReview, document }) {
  const assertions = [];
  const check = (condition, name) => { if (!condition) throw Error(name); assertions.push(name); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const terms = { base_rent_per_sf: { label: 'Base rent', units: { 'USD/SF/year': 1 } } };
  const page = (cursor = null) => {
    const result = { ok: true, schema_version: 'deal-documents.v1', documents: [{ id: '00000000-0000-4000-8000-000000000030', display_name: 'Synthetic Lease.pdf', document_type: 'application/pdf', page_count: null, content_hash: 'a'.repeat(64), stored_at: '2026-01-01T00:00:00Z' }], has_more: cursor !== null, next_cursor: cursor };
    if (result.schema_version !== 'deal-documents.v1' || result.documents.some(doc => !/^[0-9a-f-]{36}$/.test(doc.id) || typeof doc.display_name !== 'string' || !Number.isFinite(Date.parse(doc.stored_at)) || !/^[a-f0-9]{64}$/.test(doc.content_hash))) throw Error('Document fixture violates pinned fact_review.json contract');
    return result;
  };
  let writes = 0;
  for (const stop of ['disposed', 'expired', 'stale']) {
    for (const later of [false, true]) {
      for (const reject of [false, true]) {
        const root = document.body.appendChild(document.createElement('div'));
        const waiting = [];
        let documentCalls = 0, factCalls = 0;
        const client = {
          listDealDocuments: () => {
            documentCalls++;
            if (later && documentCalls === 1) return Promise.resolve(page('second'));
            return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
          },
          listFactReview: async () => { factCalls++; return { ok: true, schema_version: 'fact-review.v1', items: [], has_more: false, next_cursor: null }; },
          prepareTermsComparison: async () => { writes++; throw Error('Write refused'); },
          recordHumanFact: async () => { writes++; throw Error('Write refused'); },
          resolveFactReview: async () => { writes++; throw Error('Write refused'); },
        };
        const panel = mountFactReview(root, { client, entityRef: 'synthetic', terms });
        try {
          await tick();
          check(waiting.length === 1, 'deferred-page-started');
          let fresh;
          if (stop === 'disposed') panel.dispose();
          if (stop === 'expired') document.defaultView.dispatchEvent(new document.defaultView.Event('doctorcre-session-invalidated'));
          if (stop === 'stale') {
            fresh = panel.refresh();
            await tick();
          }
          const before = root.innerHTML, calls = documentCalls;
          if (reject) waiting[0].reject(Error('Late rejection'));
          else waiting[0].resolve(page('obsolete-next'));
          await tick();
          check(documentCalls === calls, `${stop}-${later ? 'later' : 'first'}${reject ? '-rejection' : ''}`);
          check(factCalls === 0 && root.innerHTML === before, 'obsolete-read-cannot-publish');
          if (fresh) { waiting[1].resolve(page()); await fresh; check(factCalls === 1, 'newest-refresh-completes'); }
        } finally { panel.dispose(); root.remove(); }
      }
    }
  }
  for (const mode of ['healthy', 'repeated', 'capacity', 'unavailable', 'invalid']) {
    const root = document.body.appendChild(document.createElement('div'));
    let documentCalls = 0, factCalls = 0;
    const client = {
      listDealDocuments: async () => {
        documentCalls++;
        if (mode === 'unavailable') throw Error('Offline');
        if (mode === 'invalid') return { ...page(), schema_version: 'wrong' };
        return page(mode === 'capacity' ? `page-${documentCalls}` : mode === 'repeated' || documentCalls === 1 ? 'second' : null);
      },
      listFactReview: async () => { factCalls++; return { ok: true, schema_version: 'fact-review.v1', items: [], has_more: false, next_cursor: null }; },
    };
    const panel = mountFactReview(root, { client, entityRef: 'synthetic', terms });
    try {
      await tick();
      check(documentCalls === (mode === 'capacity' ? 100 : ['healthy', 'repeated'].includes(mode) ? 2 : 1), `${mode}-bounded-reads`);
      check(factCalls === 1 && root.textContent.includes('No sourced terms recorded.'), `${mode}-fact-review-usable`);
      check(mode === 'healthy' ? !!root.querySelector('[data-fact-record]') : root.textContent.includes('Stored documents unavailable'), `${mode}-document-availability`);
      if (mode === 'healthy') { await panel.refresh(); check(factCalls === 2, 'reviewing-refresh'); }
    } finally { panel.dispose(); root.remove(); }
  }
  check(writes === 0, 'no-writes');
  return { assertions, synthetic_write_calls: writes };
}

export async function observeOnPage(page, assetUrl) {
  return page.evaluate(`(async () => {
    const { mountFactReview } = await import(${JSON.stringify(assetUrl)});
    return (${observePagination.toString()})({ mountFactReview, document });
  })()`);
}

export async function prove({ origin, timeoutMs }) {
  const { chromium } = await import('playwright');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  const browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() });
  const shutdown = setTimeout(() => { void browser.close(); }, Math.max(1, deadline - Date.now() - 100));
  const assets = [];
  let requests = 0, bytes = 0, routeError;
  const refusal = message => Object.assign(Error(message), { exitCode: 78 });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const get = async url => {
      if (++requests > 32 || Date.now() >= deadline) throw Error('Proof request budget exhausted');
      const raw = await proofFetch(url, { signal: AbortSignal.timeout(remaining()) });
      const response = { status: () => raw.status, headers: () => Object.fromEntries(raw.headers), body: async () => Buffer.from(await raw.arrayBuffer()) };
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw refusal('Protected asset or sign-in required');
      const body = await response.body();
      bytes += body.length;
      if (bytes > 10 * 1024 * 1024) throw Error('Proof byte budget exhausted');
      return { response, body };
    };
    const identity = await readAppRelease(origin, async url => {
      const { response, body } = await get(url.href);
      return { type: response.headers()['content-type'] || '', body };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET' || url.origin !== origin) throw Error('Business network request refused');
        if (url.pathname === '/__fact-pagination-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic document pagination proof</title>' });
        if (!/^\/js\/[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(url.pathname) || url.search) throw Error('Business network request refused');
        if (assets.length >= 30) throw Error('Asset budget exhausted');
        const { response, body } = await get(url.href);
        if (response.status() !== 200 || !/javascript/.test(response.headers()['content-type'] || '')) throw refusal('Protected or missing JavaScript asset');
        assets.push({ url: url.href, sha256: createHash('sha256').update(body).digest('hex') });
        await route.fulfill({ contentType: 'text/javascript', body });
      } catch (error) { routeError = error; await route.abort(); }
    });
    await page.goto(`${origin}/__fact-pagination-proof`, { timeout: remaining() });
    let observation;
    try { observation = await observeOnPage(page, `${origin}/js/ui-facts.generated.js`); }
    catch (error) { throw routeError || error; }
    if (routeError) throw routeError;
    const final = await readAppRelease(origin, async url => {
      const { response, body } = await get(url.href);
      return { type: response.headers()['content-type'] || '', body };
    });
    if (JSON.stringify(final) !== JSON.stringify(identity)) throw Error('Release changed during proof');
    return { schema: 'fact-document-pagination-disposal-proof.v1', status: 'passed', origin, release: identity, assets, requests, ...observation, limitation: 'Deployed synthetic resilience only; natural private-data coverage unproven.' };
  } finally { clearTimeout(shutdown); await browser.close(); }
}

async function main() {
  let timer;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error('Use --origin URL --timeout-ms MILLISECONDS');
    const url = new URL(args[1]), timeoutMs = Number(args[3]);
    if (url.href !== `${url.origin}/` || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw Error('Expected HTTPS origin or loopback fixture');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw Error('Invalid timeout');
    console.log(JSON.stringify(await prove({ origin: url.origin, timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'unproven' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
