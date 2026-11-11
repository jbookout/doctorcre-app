import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { temporaryDirectory } from './temp-directory.mjs';

export async function observe({ recordings, document = globalThis.document }) {
  const { mountFactReview } = await import('/js/ui-facts.generated.js');
  const { createLiveClient } = await import('/js/live-client.js');
  const { FACT_TERMS } = await import('/js/client.js');
  const assertions = [];
  const check = (ok, name) => { if (!ok) throw Error(name); assertions.push(name); };
  let current = recordings.initial, reads = 0, writes = [], finishWrite, fail = false, defer = false, finishRead, conflict = false;
  const client = createLiveClient({ online: () => true, fetchImpl: async (url, init) => {
    if (url === '/auth/session') return Response.json(recordings.session);
    const request = JSON.parse(init.body), verb = request.params.name;
    if (verb === 'resolve-fact-review') {
      writes.push(request.params.arguments);
      if (conflict) return Response.json({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'version_conflict' }) }] } });
      await new Promise(resolve => { finishWrite = resolve; });
      if (writes.length === 1) return Response.json({ error: { code: -32000, message: 'offline', data: { error: 'internal_error' } } });
      return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(recordings.receipt) }] } });
    }
    reads++;
    if (fail) throw Error('Synthetic unavailable');
    const payload = verb === 'list-fact-review' ? (defer ? await new Promise(resolve => { finishRead = resolve; }) : current) : recordings.documents;
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  } });
  const root = document.body.appendChild(document.createElement('main'));
  const panel = mountFactReview(root, { client, entityRef: recordings.entity, terms: FACT_TERMS });
  const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Observation did not settle'); };
  const select = (kind, value) => { const node = root.querySelector(`[data-${kind}-filter]`); check(!!node, `${kind}-control-present`); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
  const visible = () => [...root.querySelectorAll('[data-fact-key]')].filter(row => !row.hidden).map(row => row.dataset.factKey).sort();
  const same = (actual, expected, name) => check(JSON.stringify(actual) === JSON.stringify(expected), name);
  try {
    await panel.refresh();
    const priority = root.querySelector('[data-priority-filter]');
    check(priority?.getAttribute('aria-label') === 'Review priority', 'priority-control-present');
    priority.focus(); check(document.activeElement === priority, 'priority-keyboard-focus');
    const before = reads;
    for (const value of ['high', 'normal', 'unrecorded']) {
      select('priority', value);
      same(visible(), current.items.filter(item => value === 'unrecorded' ? !item.priority?.trim() : item.priority === value).map(item => item.fact_key).sort(), 'exact-priority-subset');
    }
    check(reads === before && writes.length === 0, 'priority-is-local');
    current = structuredClone(recordings.initial); current.items[0].priority = 'high';
    current.items[0].observations.push({ ...current.items[0].observations[0], id: '00000000-0000-4000-8000-000000000099', value: '25', normalized_value: '25' });
    await panel.refresh();
    select('priority', 'high'); select('status', 'pending'); select('term', current.items[0].fact_key);
    const expected = current.items.filter(item => item.priority === 'high' && item.pending && item.fact_key === current.items[0].fact_key);
    same(visible(), expected.map(item => item.fact_key), 'three-filter-intersection');
    check(root.querySelector(`[data-fact-key="${current.items[0].fact_key}"]`).querySelectorAll('.fact-observation').length === 2, 'competing-values-and-citations-retained');
    check(root.querySelector('[data-term-count]').textContent === `${expected.length} matching of ${current.items.length} loaded terms`, 'exact-count');
    check(root.querySelector('[data-term-empty]').hidden === (expected.length !== 0), 'honest-empty');
    root.querySelector('[data-clear-priority]').click();
    check(priority.value === '' && root.querySelector('[data-term-filter]').value === current.items[0].fact_key && root.querySelector('[data-status-filter]').value === 'pending', 'clear-retains-other-filters');
    select('term', ''); select('status', '');
    for (const value of ['high', '', null, undefined, '  ', 42, {}, 'future-priority', 'normal']) {
      current = structuredClone(recordings.initial); current.items[0].priority = value;
      await panel.refresh(); select('priority', value == null || typeof value === 'string' && !value.trim() ? 'unrecorded' : typeof value !== 'string' ? 'unavailable' : value === 'future-priority' ? `other:${value}` : value);
      check(visible().includes(current.items[0].fact_key), 'refresh-priority-and-unknown-preserved');
      const article = root.querySelector(`[data-fact-key="${current.items[0].fact_key}"]`);
      check(article.querySelectorAll('.fact-observation').length === current.items[0].observations.length, 'all-observations-retained');
    }
    current = recordings.removed; await panel.refresh();
    check(visible().length === 0 && !root.querySelector('[data-term-empty]').hidden, 'empty-loaded-snapshot');
    current = { schema_version: 'invalid' }; await panel.refresh();
    check(root.textContent.includes('Terms unavailable.'), 'malformed-response-refused');
    current = recordings.initial; await panel.refresh(); select('priority', '');
    fail = true; await panel.refresh(); check(root.textContent.includes('Terms unavailable.'), 'refresh-failure-visible');
    fail = false; await panel.refresh(); check(!root.textContent.includes('Terms unavailable.'), 'explicit-retry-recovers');
    select('priority', 'high');
    const first = current.items[0], form = root.querySelector('form[data-fact-review]');
    select('priority', '');
    form.elements.decision.value = 'reject'; form.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.reason.value = 'Keep my draft'; form.elements.reason.dispatchEvent(new Event('input', { bubbles: true }));
    const draftReads = reads;
    select('priority', 'high'); select('term', current.items[1].fact_key); select('status', 'reviewed');
    check(!form.closest('article').hidden && priority.value === '' && form.elements.reason.value === 'Keep my draft' && root.querySelector('form[data-fact-review]') === form, 'priority-lock-preserves-draft');
    await panel.refresh(); check(reads === draftReads, 'dirty-refresh-refused');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await until(() => !!finishWrite);
    select('priority', 'high'); check(priority.disabled && !form.closest('article').hidden, 'writing-priority-refused');
    finishWrite(); await until(() => form.textContent.includes('Save not confirmed'));
    select('priority', 'high'); check(priority.disabled && !form.closest('article').hidden, 'pending-priority-refused');
    finishWrite = undefined; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !!finishWrite); finishWrite(); await until(() => root.textContent.includes('Review saved.'));
    same(writes[0], writes[1], 'pending-replay-identical-key-and-versions');
    select('priority', 'high'); select('status', 'reviewed'); select('term', current.items[1].fact_key);
    document.defaultView.location.hash = `term-${first.fact_key}`; document.defaultView.dispatchEvent(new Event('hashchange'));
    check(root.querySelector('[data-priority-filter]').value === '' && visible().includes(first.fact_key) && document.activeElement.id === `term-${first.fact_key}`, 'deep-link-clears-all-filters');
    document.defaultView.history.replaceState(null, '', '/');
    select('priority', 'high'); root.querySelector('[data-prepare-comparison]').click(); await until(() => root.querySelector('[data-comparison-field]'));
    root.querySelector('[data-comparison-field]').click();
    check(root.querySelector('[data-priority-filter]').value === '', 'comparison-clears-priority');
    defer = true; const stale = panel.refresh(); await until(() => !!finishRead);
    defer = false; current = recordings.reviewed; await panel.refresh();
    finishRead(recordings.initial); await stale;
    select('status', 'reviewed'); check(visible().includes(first.fact_key), 'stale-completion-ignored');
    select('status', ''); select('priority', '');
    current = structuredClone(recordings.initial); current.items[0].priority = 'high'; await panel.refresh(); select('priority', 'high');
    const conflictForm = root.querySelector('form[data-fact-review]');
    conflictForm.elements.decision.value = 'reject'; conflictForm.elements.decision.dispatchEvent(new Event('change', { bubbles: true }));
    conflictForm.elements.reason.value = 'Retained after conflict'; conflictForm.elements.reason.dispatchEvent(new Event('input', { bubbles: true }));
    conflict = true; current = recordings.reviewed;
    conflictForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => root.textContent.includes('Terms changed since'));
    const restored = root.querySelector('form[data-fact-review]');
    check(!restored.closest('article').hidden && restored.elements.reason.value === 'Retained after conflict' && root.querySelector('[data-priority-filter]').disabled, 'version-conflict-retains-visible-reason');
    document.defaultView.dispatchEvent(new Event('doctorcre-session-invalidated'));
    check(root.textContent === 'Sign in again before reviewing terms.', 'auth-retires-dirty-panel');
  } finally { panel.dispose(); root.remove(); }
  conflict = false;
  const authRoot = document.body.appendChild(document.createElement('main'));
  const authPanel = mountFactReview(authRoot, { client, entityRef: recordings.entity, terms: FACT_TERMS });
  try {
    await authPanel.refresh();
    defer = true; finishRead = undefined; const late = authPanel.refresh(); await until(() => !!finishRead);
    document.defaultView.dispatchEvent(new Event('doctorcre-session-invalidated'));
    finishRead(recordings.initial); await late;
    check(authRoot.textContent === 'Sign in again before reviewing terms.', 'auth-retirement-ignores-late-read');
    await authPanel.refresh(); check(authRoot.textContent === 'Sign in again before reviewing terms.', 'retired-refresh-refused');
  } finally { authPanel.dispose(); authRoot.remove(); }
  defer = true; finishRead = undefined;
  const end = document.body.appendChild(document.createElement('main'));
  const ending = mountFactReview(end, { client, entityRef: recordings.entity, terms: FACT_TERMS });
  try {
    await until(() => !!finishRead); ending.dispose(); finishRead(recordings.initial);
    await new Promise(resolve => setTimeout(resolve, 20)); check(end.textContent === '', 'disposed-late-response-ignored');
  } finally { ending.dispose(); end.remove(); }
  return { assertions };
}

export async function observeOnPage(page, origin, recordings) {
  return page.evaluate(observe, { origin, recordings });
}

export function signedInEngine(endpoint, engine = chromium) {
  const url = new URL(endpoint);
  assert.ok(['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password, 'loopback CDP endpoint required');
  return { launch: async options => {
    const connection = await engine.connectOverCDP(endpoint, { timeout: options.timeout }).catch(error => { throw Object.assign(error, { exitCode: 78 }); });
    const pages = [], acquisitions = [];
    let closing = false, cleanup;
    return {
      newPage: () => {
        const acquisition = (async () => {
          const context = connection.contexts()[0];
          if (!context) throw Object.assign(Error('Existing signed-in context unavailable'), { exitCode: 78 });
          const page = await context.newPage().catch(error => { throw Object.assign(error, { exitCode: 78 }); });
          if (closing) await page.close(); else pages.push(page);
          return page;
        })();
        acquisitions.push(acquisition);
        return acquisition;
      },
      close: () => {
        closing = true;
        return cleanup ||= (async () => {
          try { await Promise.allSettled(acquisitions); await Promise.all(pages.map(page => page.close())); }
          finally { await connection.close(); }
        })();
      },
    };
  } };
}

export async function requireContainingRelease(commit, observed, { signal, cwd } = {}) {
  if (commit === observed) return;
  try { await new Promise((resolve, reject) => execFile('git', ['merge-base', '--is-ancestor', commit, observed], { signal, cwd }, error => error ? reject(error) : resolve())); }
  catch { throw Object.assign(Error('Containing release evidence unavailable'), { exitCode: 78 }); }
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
    return items.map(item => ({ fact_key: item.fact_key, priority: item.priority }));
  }, { origin, subject });
  if (!result) throw Object.assign(Error('Recorded field evidence unavailable'), { exitCode: 78 });
  await page.waitForFunction(() => document.querySelector('[data-terms-status]')?.textContent !== 'Loading terms…');
  await page.locator('[data-term-filter]').selectOption('');
  await page.locator('[data-status-filter]').selectOption('');
  const selector = page.locator('[data-priority-filter]');
  const visible = () => page.locator('[data-fact-key]:visible').evaluateAll(rows => rows.map(row => row.dataset.factKey).sort());
  let requests = 0;
  const count = () => requests++;
  page.on('request', count);
  try {
    const priorityValue = priority => priority == null || typeof priority === 'string' && !priority.trim() ? 'unrecorded' : typeof priority !== 'string' ? 'unavailable' : ['high', 'normal'].includes(priority) ? priority : `other:${priority}`;
    for (const value of [...new Set(result.map(item => priorityValue(item.priority)))]) {
      await selector.selectOption(value);
      assert.deepEqual(await visible(), result.filter(item => priorityValue(item.priority) === value).map(item => item.fact_key).sort(), 'natural priority subset');
      assert.equal(await page.locator('[data-term-count]').textContent(), `${result.filter(item => priorityValue(item.priority) === value).length} matching of ${result.length} loaded terms`);
    }
    await page.locator('[data-clear-priority]').click();
    assert.deepEqual(await visible(), result.map(item => item.fact_key).sort(), 'natural clear subset');
    await page.evaluate(key => { location.hash = `term-${key}`; }, result[0].fact_key);
    await page.locator(`#term-${result[0].fact_key}`).waitFor({ state: 'visible' });
    assert.equal(requests, 0, 'natural filters issue no reads or writes');
  } finally { page.off('request', count); }
  return { status: 'passed', recorded_fields: result.length, natural_priority: 'passed' };
}

export async function prove({ origin, commit, timeoutMs = 30000, fixture = false, engine = chromium, launchOptions = {} }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Object.assign(Error('Expected merge commit is required'), { exitCode: 78 });
  const url = new URL(origin);
  assert.ok(url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'HTTPS origin or loopback fixture required');
  assert.ok(!fixture || ['localhost', '127.0.0.1'].includes(url.hostname), 'fixture pass is loopback only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, 'bounded timeout required');
  const recordings = JSON.parse(await readFile(new URL('../test/fixtures/fact-priority-focus/recordings.json', import.meta.url), 'utf8'));
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
    browser = await launchProofBrowser({ launch: options => { acquisition = engine.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }); return acquisition.catch(error => { throw Object.assign(error, { exitCode: 78 }); }); } }, { ...launchOptions, args: [...CHROMIUM_SAFETY_ARGS, ...(launchOptions.args || [])], env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch }, timeout: timeoutMs }, { signal: lifetime.signal });
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
    if (JSON.stringify(finalRelease) !== JSON.stringify(release)) throw Object.assign(Error('Release changed during observation'), { exitCode: 78 });
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
    const commit = args[args.indexOf('--expected-commit') + 1];
    const engine = args.includes('--cdp-url') ? signedInEngine(args[args.indexOf('--cdp-url') + 1]) : chromium;
    const result = await prove({ origin, commit, timeoutMs, fixture, engine });
    console.log(JSON.stringify(result)); process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
