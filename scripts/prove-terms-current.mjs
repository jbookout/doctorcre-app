import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { requireContainingRelease, signedInEngine } from './prove-terms-expense-basis.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
const superseded = (row, rows, asOf) => Boolean(row.effective_to && (!asOf || row.effective_to <= asOf) && rows.some(next => next.entity_ref === row.entity_ref && next.fact_key === row.fact_key && next.term_kind === row.term_kind && next.effective_from === row.effective_to));

function tuple(row, rows, asOf) {
  const number = Number(row.value), usd = /^USD/i.test(row.unit || '');
  const value = usd && row.value !== '' && Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number) : row.value;
  return [row.term_date, row.term_kind, `${row.fact_key}: ${value}${usd && Number.isFinite(number) ? (row.unit || '').replace(/^USD/i, '') : row.unit ? ` ${row.unit}` : ''}`,
    row.expense_basis?.trim() ? row.expense_basis : 'Not recorded', (row.confidence || '').replaceAll('_', ' '),
    `${row.effective_from} to ${row.effective_to || 'present'}${superseded(row, rows, asOf) ? ' · superseded' : ''}`,
    row.sources?.length ? row.sources.map(source => `${source.document_ref}${source.page_start ? `, p. ${source.page_start}${source.page_end && source.page_end !== source.page_start ? `–${source.page_end}` : ''}` : ''}${source.quarantined ? ' — Quarantined: not supporting evidence' : ''}`).join('; ') : row.context_source?.document_ref || 'Source unavailable',
    `/deals?deal=${encodeURIComponent(row.entity_ref)}`];
}

export async function observeNaturalTerms(page, origin) {
  const root = page.locator('#workspace-market-terms');
  if (!await root.isVisible()) {
    const tab = page.getByRole('tab', { name: 'Compare terms', exact: true });
    if (!await tab.count()) throw unavailable('No natural Compare terms panel');
    await tab.click();
  }
  let reads = 0;
  const count = request => { if (new URL(request.url()).origin === origin && new URL(request.url()).pathname === '/api/v1/market-terms/read' && request.method() === 'POST') reads++; };
  page.on('request', count);
  try {
    const loaded = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === '/api/v1/market-terms/read' && response.request().method() === 'POST');
    await root.getByRole('button', { name: 'Compare', exact: true }).click();
    const response = await loaded;
    if ([401, 403].includes(response.status())) throw unavailable('Signed-in session unavailable');
    const data = await response.json();
    const accepted = await page.evaluate(async data => (await import('/js/ui-market.generated.js')).isMarketTermsResponse(data), data);
    if (!accepted) throw unavailable('Invalid comparable response');
    const toggle = root.getByRole('checkbox', { name: 'Hide superseded terms', exact: true });
    await toggle.waitFor();
    for (const name of ['Term', 'Recorded stage', 'Expense basis']) await root.getByLabel(name, { exact: true }).selectOption('');
    await toggle.uncheck();
    const asOf = await root.locator('[name=as_of]').inputValue();
    const selected = data.rows.filter(row => !superseded(row, data.rows, asOf));
    if (selected.length === data.rows.length || !selected.length) throw unavailable('Natural rows do not demonstrate both superseded and retained terms');
    const identities = () => root.locator('tbody tr').evaluateAll(rows => rows.map(row => [...[0, 2, 3, 4, 5, 6, 7].map(i => row.cells[i].textContent), row.querySelector('a').getAttribute('href')]));
    const check = async rows => {
      assert.deepEqual(await identities(), rows.map(row => tuple(row, data.rows, asOf)), 'exact displayed values, units, sources, quarantine warnings and links');
      const deals = new Set(rows.map(row => row.entity_ref)).size;
      assert.equal(await root.locator('[data-market-results] > p > strong').filter({ hasText: 'matching loaded' }).textContent(), `${rows.length} matching loaded ${rows.length === 1 ? 'term' : 'terms'} across ${deals} ${deals === 1 ? 'deal' : 'deals'}.`);
    };
    const c = data.coverage;
    const coverage = `${c.eligible_receipts == null ? '' : `${c.eligible_receipts} of `}${c.canonical_receipts} receipts${c.eligible_receipts == null ? '' : ' eligible'}; ${c.unsupported_receipts} unsupported${c.superseded_without_context == null ? '' : `, ${c.superseded_without_context} superseded without context`}, ${c.unclassified_receipts} unclassified. From ${c.recorded_documents} recorded documents. Archive coverage is unknown.`;
    const checkCoverage = async () => { assert.equal(await root.locator('details summary').textContent(), 'Firm-wide coverage (not filtered)'); assert.equal(await root.locator('details p').textContent(), coverage); };
    await check(data.rows); await checkCoverage();
    const baselineReads = reads;
    await toggle.check(); await check(selected); await checkCoverage();
    await toggle.uncheck(); await check(data.rows); await checkCoverage();
    assert.equal(reads, baselineReads, 'toggle does not issue another read');
    return { natural_rows: data.rows.length, hidden_rows: data.rows.length - selected.length, visible_rows: selected.length, distinct_deals: new Set(selected.map(r => r.entity_ref)).size, reads, exact_values_sources_coverage: true };
  } finally { page.off('request', count); }
}

export async function prove({ origin, expectedCommit, cdpUrl, timeoutMs = 30000, engine, ancestryCwd }) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)), 'HTTPS or loopback origin required');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'bounded total timeout');
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
  const lifetime = new AbortController(), end = Date.now() + timeoutMs;
  const remaining = () => { lifetime.signal.throwIfAborted(); return Math.max(1, end - Date.now()); };
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { const error = unavailable('Proof deadline exceeded'); lifetime.abort(error); rejectDeadline(error); }, timeoutMs);
  let pending, browser;
  try {
    return await Promise.race([deadline, (async () => {
      const release = await readAppRelease(origin, { timeoutMs: remaining() });
      await requireContainingRelease(expectedCommit, release.source_commit, { signal: lifetime.signal, cwd: ancestryCwd });
      if (!engine && !cdpUrl) throw unavailable('Authorized signed-in CDP session required');
      const target = engine || signedInEngine(cdpUrl, chromium);
      const owned = { launch(options) { pending = target.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }); return pending; } };
      browser = await launchProofBrowser(owned, { timeout: remaining() }, { signal: lifetime.signal });
      const page = await browser.newPage();
      page.setDefaultTimeout(remaining()); page.setDefaultNavigationTimeout(remaining());
      await page.goto(`${origin}/deals`);
      const deal = page.locator('.kanban-card[data-id]:visible').first();
      try { await deal.waitFor(); } catch { throw unavailable('No signed-in visible natural deal'); }
      await deal.click();
      const assertions = await observeNaturalTerms(page, origin);
      const after = await readAppRelease(origin, { timeoutMs: remaining() });
      assert.ok(after);
      if (JSON.stringify(after) !== JSON.stringify(release)) throw unavailable('Release changed during proof');
      return { status: 'passed', release, assertions };
    })()]);
  } catch (error) {
    if (error instanceof assert.AssertionError || error.exitCode === 78) throw error;
    throw unavailable(error.message);
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    const acquired = await pending?.catch(() => undefined);
    if (!browser) await acquired?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    const names = { '--origin': 'origin', '--expected-commit': 'expectedCommit', '--cdp-url': 'cdpUrl', '--timeout-ms': 'timeoutMs' };
    for (let i = 0; i < args.length; i++) {
      const name = names[args[i]];
      if (!name) throw Error('Use --origin URL --expected-commit SHA --cdp-url URL [--timeout-ms 30000]');
      options[name] = name === 'timeoutMs' ? Number(args[++i]) : args[++i];
    }
    console.log(JSON.stringify(await prove(options)));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'insufficient_evidence' : 'assertion_failure', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
