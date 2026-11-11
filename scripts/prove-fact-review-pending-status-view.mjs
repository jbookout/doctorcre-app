import { requireContainingRelease } from './containing-release.ts';
export { requireContainingRelease } from './containing-release.ts';
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
  let outcome = 'unknown', paged = false;
  const client = createLiveClient({ online: () => true, fetchImpl: async (_url, init) => {
    if (_url === '/auth/session') return Response.json(recordings.session);
    const request = JSON.parse(init.body), verb = request.params.name;
    let payload;
    if (verb === 'list-fact-review') { reads++; payload = paged ? (request.params.arguments.cursor ? recordings.page2 : recordings.page1) : current; }
    else if (verb === 'list-deal-documents') { documentsRead++; payload = recordings.documents; }
    else if (verb === 'resolve-fact-review') {
      writes.push(request.params.arguments);
      await new Promise(resolve => { finishWrite = resolve; });
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
    paged = true; await panel.refresh();
    check(visible().length === recordings.initial.items.length, 'recorded-pagination-preserved');
    paged = false;
    const statusSelect = value => {
      const selector = root.querySelector('[data-status-filter]');
      check(!!selector, 'labeled-status-selector');
      selector.value = value; selector.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const beforeReads = reads, beforeDocs = documentsRead;
    statusSelect('pending');
    check(visible().length === current.items.filter(item => item.pending).length, 'pending-boolean-subset');
    check([...root.querySelectorAll('.fact-empty[id]')].every(row => row.hidden), 'placeholders-excluded');
    statusSelect('reviewed');
    check(visible().length === 0 && !root.querySelector('[data-term-empty]').hidden, 'truthful-empty-subset');
    statusSelect(''); select(first.fact_key); statusSelect('pending');
    check(visible().length === 1 && visible()[0].dataset.factKey === first.fact_key, 'combined-status-and-key');
    check(root.querySelector('[data-term-count]').textContent === `1 matching of ${current.items.length} loaded terms`, 'status-count-full-loaded-denominator');
    check(visible()[0].textContent.includes('Canonical history') && visible()[0].textContent.includes(recordings.documents.documents[0].display_name), 'status-retains-history-and-evidence');
    statusSelect('reviewed'); statusSelect('');
    check(visible().length === 1, 'clear-restores-key-subset');
    check(reads === beforeReads && documentsRead === beforeDocs && writes.length === 0, 'status-is-local');
    current = recordings.reviewed; await panel.refresh();
    statusSelect('reviewed');
    check(visible().map(row => row.dataset.factKey).join() === first.fact_key, 'reviewed-boolean-subset');
    statusSelect('pending');
    check(visible().length === 0, 'refresh-uses-recorded-pending');
    select(''); statusSelect(''); current = recordings.initial; await panel.refresh(); select(first.fact_key);
    const article = visible()[0], form = article.querySelector('form'), reason = form.elements.reason;
    form.elements.decision.value = 'correct'; form.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.value.value = '31'; form.elements.cited_text.value = 'Unsaved correction';
    reason.value = 'Unsaved partner reason'; reason.dispatchEvent(new Event('input', { bubbles: true }));
    const draftReads = reads;
    check(root.querySelector('[data-status-filter]').disabled, 'dirty-status-disabled');
    statusSelect('reviewed'); check(!article.hidden, 'dirty-status-change-refused');
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
    statusSelect('reviewed'); check(!article.hidden && root.querySelector('[data-status-filter]').disabled, 'writing-status-change-refused');
    select(second.fact_key); check(!article.hidden, 'submitting-selection-refused');
    finishWrite(); await until(() => form.textContent.includes('Save not confirmed'));
    statusSelect('reviewed'); check(!article.hidden && root.querySelector('[data-status-filter]').disabled, 'uncertain-status-change-refused');
    check(form.textContent.includes('Save not confirmed') && !article.hidden, 'unknown-outcome-visible');
    check([...root.querySelector('[data-term-filter]').options].find(option => option.value === second.fact_key).disabled, 'pending-option-disabled');
    select(second.fact_key); check(!article.hidden, 'pending-selection-refused');
    select(''); check(!article.hidden, 'pending-all-allowed');
    current = recordings.reviewed; outcome = 'confirmed'; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(); finishWrite(); await until(() => root.textContent.includes('Review saved.'));
    check(JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'retry-preserves-idempotency-and-versions');
    check(writes[0].base_version === first.canonical_version && writes[0].review_version === first.review_version, 'recorded-versions-preserved');
    check(root.textContent.includes('Review saved.'), 'confirmed-retry-refreshes');
    select(first.fact_key); statusSelect('pending'); check(visible().length === 0, 'confirmed-refresh-empty-subset');
    statusSelect(''); select(first.fact_key);
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
  current = recordings.initial;
  const refreshRoot = document.body.appendChild(document.createElement('main'));
  let refuse = false, deferred, defer = false;
  const refreshClient = { ...client, listFactReview: async args => {
    if (refuse) throw Error('Synthetic unavailable');
    if (defer) return new Promise(resolve => { deferred = resolve; });
    return client.listFactReview(args);
  } };
  const refreshPanel = mountFactReview(refreshRoot, { client: refreshClient, entityRef: recordings.entity, terms: FACT_TERMS });
  try {
    await refreshPanel.refresh();
    const selector = refreshRoot.querySelector('[data-status-filter]');
    selector.focus();
    check(document.activeElement === selector && selector.getAttribute('aria-label') === 'Review status', 'status-keyboard-focus');
    selector.value = 'pending'; selector.dispatchEvent(new Event('change', { bubbles: true }));
    const term = refreshRoot.querySelector('[data-term-filter]');
    term.value = first.fact_key; term.dispatchEvent(new Event('change', { bubbles: true }));
    current = recordings.reviewed; await refreshPanel.refresh();
    check(selector.value === 'pending' && !refreshRoot.querySelector('[data-term-empty]').hidden, 'chosen-status-survives-refresh');
    const before = reads;
    refreshRoot.querySelector('[data-clear-status]').click();
    check(reads === before && [...refreshRoot.querySelectorAll('[data-fact-key]')].filter(row => !row.hidden).length === 1, 'clear-button-preserves-key');
    refuse = true; await refreshPanel.refresh();
    check(refreshRoot.textContent.includes('Terms unavailable.'), 'read-refusal-visible');
    refuse = false; await refreshPanel.refresh();
    check(!refreshRoot.textContent.includes('Terms unavailable.'), 'refusal-refresh-recovers');
    defer = true; const stale = refreshPanel.refresh();
    await until(() => !!deferred);
    defer = false; await refreshPanel.refresh();
    deferred(recordings.initial); await stale;
    selector.value = 'reviewed'; selector.dispatchEvent(new Event('change', { bubbles: true }));
    check([...refreshRoot.querySelectorAll('[data-fact-key]')].filter(row => !row.hidden).length === 1, 'stale-completion-ignored');
  } finally { refreshPanel.dispose(); refreshRoot.remove(); }
  return { assertions, synthetic_write_attempts: writes.length, natural_status: 'insufficient_evidence' };
}

export async function observeOnPage(page, origin, recordings) {
  return page.evaluate(observe, { origin, recordings });
}

export function signedInEngine(endpoint, engine = chromium) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password, 'loopback CDP endpoint required');
  return { launch: async options => {
    const connection = await engine.connectOverCDP(endpoint, { timeout: options.timeout });
    const pages = [], acquisitions = [];
    let closing = false;
    return {
      newPage: async () => {
        const context = connection.contexts()[0];
        if (!context) throw Object.assign(Error('Existing signed-in context unavailable'), { exitCode: 78 });
        const acquisition = context.newPage(); acquisitions.push(acquisition);
        const page = await acquisition;
        if (closing) await page.close(); else pages.push(page);
        return page;
      },
      close: async () => {
        closing = true;
        try { await Promise.all(pages.map(page => page.close())); }
        finally { await connection.close(); await Promise.allSettled(acquisitions); }
      },
    };
  } };
}


export async function observeNaturalOnPage(page, origin) {
  const subject = await page.evaluate(async origin => {
    try {
      const { createLiveClient } = await import('/js/live-client.js');
      const board = await createLiveClient().getBoard({ workspace: 'all' });
      return board.deals?.[0]?.id || null;
    } catch { return null; }
  }, origin);
  if (!subject) throw Object.assign(Error('Signed-in visible deal evidence unavailable'), { exitCode: 78 });
  await page.goto(`${origin}/deals?deal=${encodeURIComponent(subject)}`);
  await page.locator('[data-open-terms]').click();
  await page.locator('[data-status-filter]').waitFor();
  const result = await page.evaluate(async ({ origin, subject }) => {
    const { createLiveClient } = await import('/js/live-client.js');
    const client = createLiveClient(), items = [];
    let cursor;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await client.listFactReview({ entity_ref: subject, include_resolved: true, limit: 100, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      if (!page.has_more) break;
      if (!page.next_cursor || page.next_cursor === cursor || pageNumber === 99) return null;
      cursor = page.next_cursor;
    }
    if (!items.length) return null;
    return items.map(item => ({ fact_key: item.fact_key, pending: item.pending }));
  }, { origin, subject });
  if (!result) throw Object.assign(Error('Recorded field evidence unavailable'), { exitCode: 78 });
  await page.waitForFunction(() => document.querySelector('[data-terms-status]')?.textContent !== 'Loading terms…');
  const selector = page.locator('[data-status-filter]');
  const visible = () => page.locator('[data-fact-key]:visible').evaluateAll(rows => rows.map(row => row.dataset.factKey).sort());
  const key = await page.locator('[data-term-filter]').inputValue();
  for (const [status, pending] of [['pending', true], ['reviewed', false]]) {
    await selector.selectOption(status);
    assert.deepEqual(await visible(), result.filter(item => item.pending === pending && (!key || item.fact_key === key)).map(item => item.fact_key).sort(), 'natural status subset');
  }
  let requests = 0;
  const count = () => requests++;
  page.on('request', count);
  try {
    await page.locator('[data-clear-status]').click();
    assert.deepEqual(await visible(), result.filter(item => !key || item.fact_key === key).map(item => item.fact_key).sort(), 'natural clear subset');
    assert.equal(requests, 0, 'natural clear issues no reads');
  } finally { page.off('request', count); }
  return { status: 'passed', recorded_fields: result.length, natural_status: 'passed' };
}

export async function prove({ origin, commit, timeoutMs = 30000, fixture = false, engine = chromium, launchOptions = {} }) {
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  const url = new URL(origin);
  assert.ok(url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'HTTPS origin or loopback fixture required');
  assert.ok(!fixture || ['localhost', '127.0.0.1'].includes(url.hostname), 'fixture pass is loopback only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, 'bounded timeout required');
  const recordings = JSON.parse(await readFile(new URL('../test/fixtures/fact-review-pending-status-view/recordings.json', import.meta.url), 'utf8'));
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
    await requireContainingRelease(commit, release.source_commit, { signal: lifetime.signal });
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
    let natural;
    if (!fixture) { await page.unroute('**/*'); natural = await observeNaturalOnPage(page, origin); }
    const finalRelease = await readAppRelease(origin, url => get(url.href));
    assert.deepEqual(finalRelease, release, 'release stable');
    return { ...observation, ...natural, status: 'passed', release, requests, evidence: fixture ? 'deployed-module-fixture-replay' : 'natural-signed-in' };
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
    const commit = args[args.indexOf('--commit') + 1];
    const engine = args.includes('--cdp-url') ? signedInEngine(args[args.indexOf('--cdp-url') + 1]) : chromium;
    const result = await prove({ origin, commit, timeoutMs, fixture, engine });
    console.log(JSON.stringify(result)); process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
