import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { temporaryDirectory } from './temp-directory.mjs';

export async function observe({ origin, recordings, document = globalThis.document }) {
  const { mountFactReview } = await import('/js/ui-facts.generated.js');
  const { createLiveClient } = await import('/js/live-client.js');
  const { FACT_TERMS } = await import('/js/client.js');
  const assertions = [];
  const check = (value, name) => { if (!value) throw Error(name); assertions.push(name); };
  let current = recordings.initial, reads = 0, documentsRead = 0, writes = [], finishWrite;
  let outcome = 'unknown', retryArrived;
  const client = createLiveClient({ online: () => true, fetchImpl: async (_url, init) => {
    if (_url === '/auth/session') return Response.json(recordings.session);
    const request = JSON.parse(init.body), verb = request.params.name;
    let payload;
    if (verb === 'list-fact-review') { reads++; payload = current; }
    else if (verb === 'list-deal-documents') { documentsRead++; payload = recordings.documents; }
    else if (verb === 'resolve-fact-review') {
      writes.push(request.params.arguments);
      await new Promise(resolve => { finishWrite = resolve; if (writes.length === 2) retryArrived(); });
      if (outcome === 'unknown') return Response.json({ error: { code: -32000, message: 'offline', data: { error: 'internal_error' } } });
      payload = recordings.receipt;
    } else throw Error(`Unexpected verb ${verb}`);
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  } });
  const root = document.body.appendChild(document.createElement('main'));
  const panel = mountFactReview(root, { client, entityRef: recordings.entity, terms: FACT_TERMS });
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const until = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await tick(); }
  };
  const select = key => {
    const selector = root.querySelector('[data-term-filter]');
    check(!!selector, 'labeled-local-selector');
    selector.value = key; selector.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const visible = () => [...root.querySelectorAll('[data-fact-key]')].filter(row => !row.hidden);
  const first = recordings.initial.items[0], second = recordings.initial.items[1];
  check(!!second && first.fact_key !== second.fact_key, 'recorded-two-key-evidence');
  try {
    await panel.refresh();
    check(root.querySelector('[data-term-filter]').getAttribute('aria-label') === 'Filter by term', 'labeled-local-selector');
    check(visible().length === recordings.initial.items.length, 'all-loaded');
    const beforeReads = reads, beforeDocs = documentsRead;
    select(first.fact_key);
    check(visible().length === 1 && visible()[0].dataset.factKey === first.fact_key, 'select-isolates-recorded-key');
    check(root.querySelector('[data-term-count]').textContent === `1 matching of ${recordings.initial.items.length} loaded terms`, 'matching-loaded-counts');
    check(visible()[0].textContent.includes(`${recordings.documents.documents[0].display_name} · Page ${first.observations[0].source.page_start}`) && visible()[0].textContent.includes('No canonical value recorded'), 'source-and-canonical-metadata-retained');
    select(''); check(visible().length === recordings.initial.items.length, 'clear-selection');
    current = recordings.added; select(first.fact_key); await panel.refresh();
    check([...root.querySelector('[data-term-filter]').options].some(option => option.value === 'free_rent_months'), 'refresh-adds-key');
    check(visible().length === 1, 'refresh-keeps-selection');
    current = recordings.removed; await panel.refresh();
    check(visible().length === 0 && !root.querySelector('[data-term-empty]').hidden, 'removed-key-local-empty-state');
    select(''); check(root.querySelector('[data-term-empty]').hidden, 'clear-empty-selection');
    current = recordings.initial; await panel.refresh();
    select(first.fact_key);
    const article = visible()[0], form = article.querySelector('form'), reason = form.elements.reason;
    form.elements.decision.value = 'correct'; form.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.value.value = '31'; form.elements.cited_text.value = 'Unsaved correction';
    reason.value = 'Unsaved partner reason'; reason.dispatchEvent(new Event('input', { bubbles: true }));
    const draftReads = reads;
    select(second.fact_key); select(first.fact_key);
    check(visible()[0] === article && form.elements.reason.value === 'Unsaved partner reason' && form.elements.value.value === '31' && form.elements.cited_text.value === 'Unsaved correction', 'draft-text-and-form-identity-retained');
    await panel.refresh(); check(reads === draftReads, 'dirty-draft-blocks-refresh');
    check(writes.length === 0, 'local-selection-never-writes');
    const freshReads = reads, freshDocs = documentsRead;
    select(''); select(first.fact_key);
    check(reads === freshReads && documentsRead === freshDocs, 'local-selection-never-reads');
    root.querySelector('[data-prepare-comparison]').click();
    await until(() => root.querySelector('[data-comparison-field]'));
    const link = root.querySelector(`[data-comparison-field="${second.fact_key}"]`);
    check(!!link, 'comparison-link-present'); link.click();
    check(!root.querySelector(`#term-${second.fact_key}`).hidden && document.activeElement.id === `term-${second.fact_key}`, 'comparison-target-revealed-and-focused');
    select(first.fact_key);
    document.defaultView.location.hash = `term-${second.fact_key}`;
    document.defaultView.dispatchEvent(new Event('hashchange'));
    check(!root.querySelector(`#term-${second.fact_key}`).hidden && document.activeElement.id === `term-${second.fact_key}`, 'hash-target-revealed-and-focused');
    document.defaultView.history.replaceState(null, '', '/');
    select(first.fact_key);
    form.elements.decision.value = 'reject'; form.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
    check(form.checkValidity(), `valid-review-form ${[...form.elements].filter(e => e.willValidate && !e.validity.valid).map(e => e.name).join(',')}`);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !!finishWrite);
    check(root.querySelector('[data-term-filter]').disabled && root.querySelector('[data-term-filter-hint]').textContent.includes('saving'), 'submitting-cannot-hide-term');
    select(second.fact_key); check(!article.hidden, 'submitting-selection-refused');
    finishWrite(); await until(() => form.textContent.includes('Save not confirmed'));
    check(form.textContent.includes('Save not confirmed') && !article.hidden, 'unknown-outcome-visible');
    check([...root.querySelector('[data-term-filter]').options].find(option => option.value === second.fact_key).disabled, 'pending-option-disabled');
    select(second.fact_key); check(!article.hidden, 'pending-selection-refused');
    select(''); check(!article.hidden, 'pending-all-allowed');
    const retryWrite = new Promise(resolve => { retryArrived = resolve; });
    outcome = 'confirmed'; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await retryWrite; finishWrite(); await until(() => root.textContent.includes('Review saved.'));
    check(JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'retry-preserves-idempotency-and-versions');
    check(writes[0].base_version === first.canonical_version && writes[0].review_version === first.review_version, 'recorded-versions-preserved');
    check(root.textContent.includes('Review saved.'), 'confirmed-retry-refreshes');
    select(first.fact_key);
    document.defaultView.dispatchEvent(new Event('doctorcre-session-invalidated'));
    check(root.textContent === 'Sign in again before reviewing terms.', 'auth-retires-panel');
    await panel.refresh(); check(root.textContent === 'Sign in again before reviewing terms.', 'retired-refresh-ignored');
    check(beforeReads >= 1 && beforeDocs >= 1, 'existing-loaded-read-path');
  } finally { panel.dispose(); root.remove(); }
  let finish;
  const lateRoot = document.body.appendChild(document.createElement('div'));
  const lateClient = { ...client, listFactReview: () => new Promise(resolve => { finish = resolve; }) };
  const latePanel = mountFactReview(lateRoot, { client: lateClient, entityRef: recordings.entity, terms: FACT_TERMS });
  try {
    await tick(); await tick(); check(!!finish, 'late-read-started'); latePanel.dispose();
    finish(recordings.initial); await tick(); check(lateRoot.textContent === '', 'disposed-late-response-ignored');
  } finally { latePanel.dispose(); lateRoot.remove(); }
  for (const state of ['empty', 'locked']) {
    current = recordings.initial;
    const endingRoot = document.body.appendChild(document.createElement('main'));
    const ending = mountFactReview(endingRoot, { client, entityRef: recordings.entity, terms: FACT_TERMS });
    try {
      await ending.refresh();
      const selector = endingRoot.querySelector('[data-term-filter]');
      if (state === 'empty') {
        selector.value = first.fact_key; selector.dispatchEvent(new Event('change', { bubbles: true }));
        current = recordings.removed; await ending.refresh();
      }
      else {
        const form = endingRoot.querySelector('form');
        form.elements.decision.value = 'reject'; form.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
        form.elements.reason.value = 'Synthetic pending retirement';
        finishWrite = undefined;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => !!finishWrite);
      }
      ending.dispose();
      if (state === 'locked') finishWrite();
      await tick();
      check(endingRoot.textContent === '', `${state}-disposal-ignores-late-work`);
    } finally { ending.dispose(); endingRoot.remove(); }
  }
  return { assertions, synthetic_write_attempts: writes.length, natural_status: 'insufficient_evidence' };
}

export async function observeOnPage(page, origin, recordings) {
  return page.evaluate(observe, { origin, recordings });
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium, launchOptions = {} }) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'HTTPS origin or loopback fixture required');
  assert.ok(!fixture || ['localhost', '127.0.0.1'].includes(url.hostname), 'fixture pass is loopback only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, 'bounded timeout required');
  const recordings = JSON.parse(await readFile(new URL('../test/fixtures/fact-review-term-key-filter/recordings.json', import.meta.url), 'utf8'));
  const lifetime = new AbortController(), scratch = temporaryDirectory('fact-term-proof-');
  const timer = setTimeout(() => lifetime.abort(Object.assign(Error('Proof deadline exceeded'), { exitCode: 78 })), timeoutMs);
  let browser, acquisition, requests = 0, bytes = 0, routeFailure;
  const get = async href => {
    assert.ok(++requests <= 64, 'request cap');
    const response = await proofFetch(href, { signal: lifetime.signal });
    if (!response.ok) throw Object.assign(Error(`Asset unavailable ${response.status}`), { exitCode: 78 });
    const body = Buffer.from(await response.arrayBuffer()); bytes += body.length;
    assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap');
    return { body, type: response.headers.get('content-type') || '' };
  };
  try {
    const release = await readAppRelease(origin, url => get(url.href));
    browser = await launchProofBrowser({ launch: options => { acquisition = engine.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }); return acquisition; } }, { ...launchOptions, args: [...CHROMIUM_SAFETY_ARGS, ...(launchOptions.args || [])], env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch }, timeout: timeoutMs }, { signal: lifetime.signal });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.route('**/*', async route => {
      try {
        const request = route.request(), target = new URL(request.url());
        assert.ok(request.method() === 'GET' && target.origin === origin, 'business network refused');
        if (target.pathname === '/__term-filter-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recorded term filter proof</title>' });
        assert.match(target.pathname, /^\/js\/[a-zA-Z0-9._-]+\.(?:mjs|js)$/);
        assert.equal(target.search, '');
        const { body, type } = await get(target.href); assert.match(type, /javascript/);
        await route.fulfill({ body, contentType: type });
      } catch (error) { routeFailure = error; await route.abort(); }
    });
    await page.goto(`${origin}/__term-filter-proof`);
    const observation = await observeOnPage(page, origin, recordings).catch(error => { throw routeFailure || error; });
    const finalRelease = await readAppRelease(origin, url => get(url.href));
    assert.deepEqual(finalRelease, release, 'release stable');
    return { status: fixture ? 'passed' : 'insufficient_evidence', release, requests, ...observation };
  } finally { clearTimeout(timer); if (browser) await browser.close();
    else if (acquisition) await acquisition.then(acquired => acquired.close(), () => {});
    await rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const fixture = args.includes('--fixture');
    const origin = args[args.indexOf('--origin') + 1];
    const timeoutMs = args.includes('--timeout-ms') ? Number(args[args.indexOf('--timeout-ms') + 1]) : 30000;
    const result = await prove({ origin, timeoutMs, fixture });
    console.log(JSON.stringify(result)); process.exitCode = fixture ? 0 : 78;
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
