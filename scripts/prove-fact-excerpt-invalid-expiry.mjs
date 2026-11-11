import { proofFetch, launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeExcerpts(page, assetUrl) {
  await page.clock.setFixedTime(new Date('2026-02-01T00:00:00Z'));
  return page.evaluate(async url => {
    const { mountFactReview } = await import(url);
    const root = document.body.appendChild(document.createElement('div'));
    let expiry = 'invalid', text = 'Synthetic proof clause', writes = 0;
    const deny = async () => { writes++; throw Error('Synthetic write refused'); };
    const client = {
      listDealDocuments: async () => ({ ok: true, schema_version: 'deal-documents.v1', documents: [{ id: 'doc', display_name: 'Synthetic Lease.pdf', stored_at: '2026-01-01' }], has_more: false }),
      listFactReview: async () => ({ schema_version: 'fact-review.v1', has_more: false, items: [{ entity_ref: 'synthetic', fact_key: 'base_rent_per_sf', pending: true, reasons: ['human_review'], canonical_fact: null, canonical_version: 1, canonical_history: [{ version: 1, normalized_value: '24', canonical_unit: 'USD/SF/year', observation_ids: ['obs'] }], review_version: '0'.repeat(64), review_history: [], observations: [{ id: 'obs', value: '24', unit: 'USD/SF/year', method: 'human', confidence_tier: 'human_review', source: { document_ref: 'doc', page_start: 2, page_end: 3, cited_text: text, cited_text_expires_at: expiry } }] }] }),
      prepareTermsComparison: deny, recordHumanFact: deny, resolveFactReview: deny,
    };
    const panel = mountFactReview(root, { client, entityRef: 'synthetic', terms: { base_rent_per_sf: { label: 'Base rent', units: { 'USD/SF/year': 1 } } } });
    let assertions = 0;
    const check = (condition, message) => { if (!condition) throw Error(message); assertions++; };
    try {
      for (const value of ['invalid', undefined, null, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
        expiry = value;
        await panel.refresh();
        const visible = value === '2099-01-01T00:00:00Z';
        check(root.querySelectorAll('blockquote').length === Number(visible), `Incorrect excerpt visibility for ${value}`);
        check(root.querySelector('.fact-observation').textContent.includes('Excerpt no longer available') === !visible, 'Missing unavailable wording');
        check(root.querySelector('[data-canonical-history]').textContent.includes('Excerpt no longer available') === !visible, 'History availability differs');
        check(root.querySelector('.fact-source').textContent === 'Synthetic Lease.pdf · Pages 2–3', 'Provenance changed');
      }
      for (const value of ['', '   ', null]) {
        text = value;
        await panel.refresh();
        check(!root.querySelector('blockquote'), 'Empty excerpt visible');
      }
      check(writes === 0, 'Business write port called');
      return { assertions, synthetic_write_calls: writes };
    } finally { panel.dispose(); root.remove(); }
  }, assetUrl);
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
      if (body.length > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024) throw Error('Proof byte budget exhausted');
      return { response, body };
    };
    const gateway = await get(`${origin}/release`);
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
        if (url.pathname === '/__fact-excerpt-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic excerpt proof</title>' });
        if (!/^\/js\/[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(url.pathname) || url.search) throw Error('Business network request refused');
        const { response, body } = await get(url.href);
        if (response.status() !== 200 || !/javascript/.test(response.headers()['content-type'] || '')) throw refusal('Protected or missing JavaScript asset');
        assets.push({ url: url.href, sha256: createHash('sha256').update(body).digest('hex') });
        await route.fulfill({ contentType: 'text/javascript', body });
      } catch (error) { routeError = error; await route.abort(); }
    });
    await page.goto(`${origin}/__fact-excerpt-proof`, { timeout: remaining() });
    let observation;
    try { observation = await observeExcerpts(page, `${origin}/js/ui-facts.generated.js`); }
    catch (error) { throw routeError || error; }
    if (routeError) throw routeError;
    const final = await readAppRelease(origin, async url => {
      const { response, body } = await get(url.href);
      return { type: response.headers()['content-type'] || '', body };
    });
    if (JSON.stringify(final) !== JSON.stringify(identity)) throw Error('Release changed during proof');
    return { schema: 'fact-excerpt-expiry-proof.v1', status: 'passed', origin, release: identity, gateway_release_status: gateway.response.status(), gateway_release_sha256: createHash('sha256').update(gateway.body).digest('hex'), assets, requests, ...observation, limitation: 'Deployed synthetic resilience only; natural private-data coverage unproven.' };
  } finally { clearTimeout(shutdown); await browser.close(); }
}

async function main() {
  let timer;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error('Use --origin URL --timeout-ms MILLISECONDS');
    const url = new URL(args[1]), timeoutMs = Number(args[3]);
    if (url.href !== `${url.origin}/` || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw Error('Expected HTTPS origin or loopback fixture');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw Error('Invalid timeout');
    console.log(JSON.stringify(await prove({ origin: url.origin, timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'unproven' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
