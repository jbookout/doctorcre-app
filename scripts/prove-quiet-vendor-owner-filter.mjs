import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium as driver } from 'playwright';
import { chromium } from './proof-browser.mjs';
import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
export async function prove({ origin, expectedCommit, timeoutMs = 30000, cdpUrl, fixture = false, engine = chromium }) {
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
  let browser, page, release, borrowed;
  const pendingPages = new Set();
  const work = async () => {
    release = await readAppRelease(base, { timeoutMs: remaining() });
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit required');
    if (release.source_commit !== expectedCommit) {
      try {
        await new Promise((resolve, reject) => {
          execFile('git', ['merge-base', '--is-ancestor', expectedCommit, release.source_commit], { timeout: remaining(), signal: controller.signal }, error => error ? reject(error) : resolve());
        });
      } catch { throw unavailable('Release does not demonstrably contain the expected commit'); }
    }
    if (!fixture && !cdpUrl) throw unavailable('Existing signed-in browser session required');
    if (fixture) {
      browser = await launchProofBrowser(engine, { timeout: remaining() }, { signal: controller.signal });
      page = await browser.newPage();
    } else {
      const connected = await driver.connectOverCDP(cdpUrl, { timeout: remaining() }).then(async acquired => {
        if (controller.signal.aborted) { await acquired.close(); throw unavailable('Total proof deadline expired'); }
        borrowed = acquired;
        return acquired;
      });
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
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const allowed = url.origin === base.origin && (request.method() === 'GET' || url.pathname === '/mcp' && request.method() === 'POST' && request.postDataJSON()?.params?.name === 'quiet-follow-ups');
      return allowed ? route.continue() : route.abort();
    });
    let reads = 0, snapshot;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/mcp' && request.postData()?.includes('quiet-follow-ups')) reads++;
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
    const owner = vendors[0].owner;
    const key = owner == null ? 'missing' : `owner:${owner}`;
    const expected = vendors.filter(row => owner == null ? row.owner == null : row.owner === owner);
    const select = section.getByRole('combobox', { name: 'Quiet vendor owner' });
    await select.waitFor();
    const before = reads;
    await select.selectOption(key);
    assert.deepEqual(await section.locator('li[data-vendor-id]').evaluateAll(rows => rows.map(row => row.dataset.vendorId)), expected.slice(0, 5).map(row => row.subject_id));
    const count = `Showing 1–${Math.min(5, expected.length)} of ${expected.length} matching loaded vendors.`;
    assert.ok((await section.innerText()).includes(count), 'Matching loaded count');
    await select.selectOption('all');
    assert.equal(reads, before, 'Filter and clear perform no business reads');
    assert.deepEqual(await section.locator('li[data-vendor-id]').evaluateAll(rows => rows.map(row => row.dataset.vendorId)), vendors.slice(0, 5).map(row => row.subject_id));
    const after = await readAppRelease(base, { timeoutMs: remaining() });
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    return { status: 'passed', scope: fixture ? 'synthetic' : 'natural', release, after, vendor_count: vendors.length, matching_count: expected.length, business_reads: reads };
  };
  let timer;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void page?.close().catch(() => {}); reject(unavailable('Total proof deadline expired')); }, timeoutMs);
    })]);
  } catch (error) {
    if (!error.exitCode && !release) error.exitCode = 78;
    if (/Timeout|Target closed|Session closed|connectOverCDP/.test(error.message)) error.exitCode = 78;
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await Promise.allSettled(pendingPages);
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
