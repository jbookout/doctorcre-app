import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readAppRelease, launchProofBrowser } from './app-release-reader.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function requireContainingRelease(expected, observed, { signal, cwd } = {}) {
  if (expected === observed) return;
  try {
    await new Promise((resolve, reject) => {
      let failure;
      const child = execFile('git', ['merge-base', '--is-ancestor', expected, observed], { signal, cwd, killSignal: 'SIGKILL' }, error => { failure = error; });
      child.once('close', () => failure ? reject(failure) : resolve());
    });
  } catch { throw unavailable('Containing release evidence unavailable'); }
}

export function signedInEngine(endpoint, engine = chromium) {
  const url = new URL(endpoint);
  assert.ok(['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password, 'loopback CDP endpoint required');
  return { async launch(options) {
    let connection;
    try { connection = await engine.connectOverCDP(endpoint, { timeout: options.timeout, isLocal: true }); }
    catch { throw unavailable('Signed-in browser connection unavailable'); }
    let closed = false, closing;
    const pages = new Set(), acquisitions = new Set();
    return {
      newPage() {
        if (closed) throw unavailable('Proof expired');
        const context = connection.contexts()[0];
        if (!context) throw unavailable('Signed-in browser context unavailable');
        const pending = context.newPage().then(async page => {
          if (closed) { await page.close(); throw unavailable('Proof expired'); }
          pages.add(page);
          return page;
        });
        acquisitions.add(pending);
        pending.then(() => acquisitions.delete(pending), () => acquisitions.delete(pending));
        return pending;
      },
      close() {
        if (!closing) {
          closed = true;
          closing = (async () => {
            await Promise.allSettled([...acquisitions]);
            await Promise.allSettled([...pages].map(page => page.close()));
            await connection.close();
          })();
        }
        return closing;
      },
    };
  } };
}

export async function observeNaturalBasis(page, origin) {
  const root = page.locator('#workspace-market-terms');
  if (!await root.isVisible()) {
    const tab = page.getByRole('tab', { name: 'Compare terms', exact: true });
    if (!await tab.count()) throw unavailable('Open a natural deal Compare terms panel in the authorized session');
    await tab.click();
  }
  const loaded = page.waitForResponse(response => {
    try { return new URL(response.url()).origin === origin && new URL(response.url()).pathname === '/api/v1/market-terms/read' && response.request().method() === 'POST'; }
    catch { return false; }
  });
  await root.getByRole('button', { name: 'Compare', exact: true }).click();
  const response = await loaded;
  if ([401, 403].includes(response.status())) throw unavailable('Signed-in session unavailable');
  let data;
  try { data = await response.json(); }
  catch { throw unavailable('Comparable response unavailable'); }
  const basis = root.getByLabel('Expense basis', { exact: true });
  await basis.waitFor();
  if (!data.rows?.length) throw unavailable('No natural comparable rows');
  const term = await root.getByLabel('Term', { exact: true }).inputValue();
  const stage = await root.getByLabel('Recorded stage', { exact: true }).inputValue();
  const subset = data.rows.filter(row => (!term || row.fact_key === term) && (!stage || row.term_kind === stage));
  const chosen = subset.find(row => row.expense_basis?.trim())?.expense_basis;
  if (!chosen) throw unavailable('No recorded expense basis in the natural subset');
  const identities = () => root.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)));
  await basis.selectOption('');
  const baseline = await identities();
  assert.equal(baseline.length, subset.length, 'loaded subset count');
  const checkCount = async rows => {
    const deals = new Set(rows.map(row => row.entity_ref)).size;
    const expected = `${rows.length} matching loaded ${rows.length === 1 ? 'term' : 'terms'} across ${deals} ${deals === 1 ? 'deal' : 'deals'}.`;
    assert.equal(await root.locator('[data-market-results] > p > strong').filter({ hasText: 'matching loaded' }).textContent(), expected, 'exact matching loaded count');
  };
  await checkCount(subset);
  let requests = 0;
  const count = request => { if (new URL(request.url()).origin === origin && new URL(request.url()).pathname === '/api/v1/market-terms/read' && request.method() === 'POST') requests++; };
  page.on('request', count);
  try {
    await basis.selectOption(JSON.stringify(chosen));
    const selected = subset.filter(row => row.expense_basis === chosen);
    assert.deepEqual(await identities(), baseline.filter(row => row[4] === chosen), 'exact expense basis row identities');
    assert.equal((await identities()).length, selected.length);
    await checkCount(selected);
    await basis.selectOption('');
    assert.deepEqual(await identities(), baseline, 'clear restores all matching loaded rows');
    await checkCount(subset);
    assert.equal(requests, 0, 'local selection issues no business read');
    return { natural_rows: data.rows.length, selected_rows: selected.length, basis: chosen, local_reads: requests };
  } finally { page.off('request', count); }
}

export async function prove({ origin, expectedCommit, cdpUrl, timeoutMs = 30000, engine, ancestryCwd }) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'HTTPS or loopback origin required');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'bounded total deadline');
  const lifetime = new AbortController();
  const end = Date.now() + timeoutMs;
  const remaining = () => { lifetime.signal.throwIfAborted(); return Math.max(1, end - Date.now()); };
  const timer = setTimeout(() => lifetime.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  let browser;
  try {
    const release = await readAppRelease(origin, { timeoutMs: remaining() });
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: lifetime.signal, cwd: ancestryCwd });
    if (!engine && !cdpUrl) throw unavailable('Authorized signed-in CDP session required');
    browser = await launchProofBrowser(engine || signedInEngine(cdpUrl), { timeout: remaining() }, { signal: lifetime.signal });
    const page = await browser.newPage();
    page.setDefaultTimeout(remaining());
    page.setDefaultNavigationTimeout(remaining());
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/deals`);
    const deal = page.locator('.kanban-card[data-id]:visible').first();
    try { await deal.waitFor(); }
    catch { throw unavailable('No signed-in visible natural deal'); }
    await deal.click();
    const assertions = await observeNaturalBasis(page, origin);
    const after = await readAppRelease(origin, { timeoutMs: remaining() });
    lifetime.signal.throwIfAborted();
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during proof');
    return { status: 'passed', release, assertions };
  } catch (error) {
    if (error instanceof assert.AssertionError || error.exitCode === 78) throw error;
    throw unavailable(error.message);
  } finally { clearTimeout(timer); await browser?.close(); }
}

async function main() {
  try {
    const args = process.argv.slice(2), options = {};
    const names = { '--origin': 'origin', '--expected-commit': 'expectedCommit', '--cdp-url': 'cdpUrl', '--timeout-ms': 'timeoutMs' };
    for (let index = 0; index < args.length; index++) {
      const name = names[args[index]];
      if (!name) throw Error('Use --origin URL --expected-commit SHA --cdp-url URL [--timeout-ms 30000]');
      options[name] = name === 'timeoutMs' ? Number(args[++index]) : args[++index];
    }
    console.log(JSON.stringify(await prove(options)));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
