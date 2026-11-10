import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { requireContainingRelease } from './prove-fact-review-pending-status-view.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium as driver } from 'playwright';
import { chromium } from './proof-browser.mjs';
import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function prove({ origin, expectedCommit, timeoutMs = 30000, cdpUrl, fixture = false, engine = chromium, readRelease = readAppRelease }) {
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || !['http:', 'https:'].includes(base.protocol)) throw Error('Expected an origin');
  if (fixture && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw Error('Fixtures require loopback');
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0 || controller.signal.aborted) throw unavailable('Total proof deadline expired');
    return ms;
  };
  let browser, page, release, borrowed, pendingConnection;
  let assertionsStarted = false;
  const pendingPages = new Set();
  const work = async () => {
    release = await readRelease(base, { timeoutMs: remaining() });
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
    if (release.source_commit !== expectedCommit) {
      await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    }
    if (!fixture && !cdpUrl) throw unavailable('Existing signed-in browser session required');
    if (fixture) {
      browser = await launchProofBrowser(engine, { timeout: remaining() }, { signal: controller.signal });
      page = await browser.newPage();
    } else {
      pendingConnection = (engine.connectOverCDP ? engine : driver).connectOverCDP(cdpUrl, { timeout: remaining() }).then(async acquired => {
        if (controller.signal.aborted) { await acquired.close(); throw unavailable('Total proof deadline expired'); }
        borrowed = acquired;
        return acquired;
      });
      const connected = await pendingConnection;
      const context = connected.contexts()[0];
      if (!context) throw unavailable('Existing browser context required');
      const pending = context.newPage().then(async acquired => {
        if (controller.signal.aborted) { await acquired.close(); throw unavailable('Total proof deadline expired'); }
        return acquired;
      });
      pendingPages.add(pending);
      try { page = await pending; } finally { pendingPages.delete(pending); }
    }
    page.setDefaultTimeout(remaining());
    const contractRoot = new URL('../contracts/carr-interface.v1/mcp_read_contracts/', import.meta.url);
    const contracts = await Promise.all((await readdir(contractRoot)).filter(name => name.endsWith('.json')).map(async name => ({ name: name.slice(0, -5), ...JSON.parse(await readFile(new URL(name, contractRoot), 'utf8')) })));
    const readNames = new Set(contracts.filter(item => item.write === false).map(item => item.name));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const allowed = url.origin === base.origin && (request.method() === 'GET' || url.pathname === '/mcp' && request.method() === 'POST' && readNames.has(request.postDataJSON()?.params?.name));
      return allowed ? route.continue() : route.abort();
    });
    let reads = 0, snapshot;
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/mcp' || path.startsWith('/api/v1/business/')) reads++;
    });
    try { await page.goto(new URL('/vendors', base).href, { timeout: remaining() }); } catch { throw unavailable('Vendor page unavailable'); }
    const section = page.getByRole('region', { name: 'Quiet vendor follow-ups' });
    const show = page.getByRole('button', { name: 'Show quiet vendors' });
    try { await show.waitFor({ timeout: remaining() }); } catch { throw unavailable('Quiet vendor surface or signed-in session unavailable'); }
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp' && response.request().postData()?.includes('quiet-follow-ups'), { timeout: remaining() });
    response.catch(() => {});
    await show.click();
    try {
      const payload = await (await response).json();
      snapshot = JSON.parse(payload.result.content.find(item => item.type === 'text').text);
      await page.evaluate(async snapshot => {
        const { validateQuietFollowUps } = await import('/js/leads-client.js');
        validateQuietFollowUps(snapshot);
      }, snapshot);
    } catch { throw unavailable('Quiet vendor snapshot refused or malformed'); }
    const vendors = snapshot.proposals.filter(row => row.subject_type === 'vendor');
    if (!vendors.length) throw unavailable('No natural quiet vendor subjects');
    if (!vendors.some(row => row.basis === 'created_at') || !vendors.some(row => row.basis === 'last_contact')) throw unavailable('Both recorded history bases required');
    const select = section.getByRole('combobox', { name: 'Quiet vendor owner' });
    const history = section.getByRole('combobox', { name: 'Contact history', exact: true });
    await select.waitFor();
    assertionsStarted = true;
    assert.equal(await history.count(), 1, 'Contact history selector present');
    await page.waitForLoadState('networkidle', { timeout: remaining() });
    const before = reads, assertions = [];
    const keys = ['all', ...new Set(vendors.map(row => row.owner == null ? 'missing' : `owner:${row.owner}`))];
    if (!keys.slice(1).some(key => ['created_at', 'last_contact'].some(basis => !vendors.some(row => row.basis === basis && (row.owner == null ? 'missing' : `owner:${row.owner}`) === key)))) throw unavailable('A natural empty owner and history intersection is required');
    if (keys.length > 1001) throw unavailable('Owner observation budget exceeded');
    for (const basis of ['all', 'created_at', 'last_contact']) {
      await history.selectOption(basis);
      for (const key of keys) {
        await select.selectOption(key);
        const expected = vendors.filter(row => (basis === 'all' || row.basis === basis) && (key === 'all' || (row.owner == null ? 'missing' : `owner:${row.owner}`) === key));
        for (let offset = 0; offset < Math.max(1, expected.length); offset += 5) {
          remaining();
          const ids = expected.slice(offset, offset + 5).map(row => row.subject_id);
          assert.deepEqual(await section.locator('li[data-vendor-id]').evaluateAll(rows => rows.map(row => row.dataset.vendorId)), ids);
          const count = expected.length === 0 ? '0 matching loaded vendors.' : `Showing ${offset + 1}–${Math.min(offset + 5, expected.length)} of ${expected.length} ${basis === 'all' && key === 'all' ? 'quiet vendors' : 'matching loaded vendors'}.`;
          assert.equal(await section.getByText(count, { exact: true }).count(), 1, 'Exact loaded count');
          if (!expected.length) {
            assert.equal(await section.getByText('No loaded vendors match these filters.', { exact: true }).count(), 1);
            assert.equal(await section.getByText('No quiet vendors in this server snapshot.', { exact: true }).count(), 0);
          }
          assertions.push({ basis, owner: key, offset, ids, count });
          if (offset + 5 < expected.length) await section.getByRole('button', { name: 'Next vendors' }).click();
        }
      }
    }
    await history.selectOption('all'); await select.selectOption('all');
    assert.equal(reads, before, 'Filter and clear perform no business reads');
    assert.deepEqual(await section.locator('li[data-vendor-id]').evaluateAll(rows => rows.map(row => row.dataset.vendorId)), vendors.slice(0, 5).map(row => row.subject_id));
    const after = await readRelease(base, { timeoutMs: remaining() });
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    return { status: 'passed', scope: fixture ? 'synthetic' : 'natural', release, after, vendor_count: vendors.length, assertions, business_reads: reads, reads_before_filters: before };
  };
  let timer;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void page?.close().catch(() => {}); reject(unavailable('Total proof deadline expired')); }, timeoutMs);
    })]);
  } catch (error) {
    if (!assertionsStarted) error.exitCode = 78;
    if (/Timeout|Target closed|Session closed|connectOverCDP/.test(error.message)) error.exitCode = 78;
    if (!error.exitCode && release) {
      const after = await readRelease(base, { timeoutMs: remaining() });
      if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    }
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await Promise.allSettled(pendingPages);
    await Promise.allSettled([pendingConnection].filter(Boolean));
    await borrowed?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'expected-commit': { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, 'cdp-url': { type: 'string' }, fixture: { type: 'boolean' } } });
    const timeoutMs = Number(values['timeout-ms']);
    if (!values.origin || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Expected --origin and a deadline from 1 to 30000 milliseconds');
    console.log(JSON.stringify(await prove({ origin: values.origin, expectedCommit: values['expected-commit'], cdpUrl: values['cdp-url'], timeoutMs, fixture: values.fixture })));
  } catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = error.exitCode || 1; }
}
