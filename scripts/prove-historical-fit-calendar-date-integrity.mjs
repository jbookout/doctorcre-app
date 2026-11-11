import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function options(args) {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, 'expected-revision': { type: 'string' } } });
  if (values.help) return { help: true };
  const url = new URL(values.origin);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'HTTPS or loopback origin required');
  assert.equal(url.href, `${url.origin}/`, 'supply an origin without credentials, path, query or fragment');
  const timeout = Number(values['timeout-ms']);
  assert.ok(Number.isInteger(timeout) && timeout >= 100 && timeout <= 300000, 'timeout must be 100..300000 ms');
  const revision = values['expected-revision'] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.match(revision, /^[0-9a-f]{40}$/, 'full expected revision required');
  return { origin: url.origin, timeout, revision };
}

export async function calendarAssertions(page, moduleURL) {
  await page.evaluate(async moduleURL => {
    const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.generated.js');
    if (typeof mountIdealClientProfile !== 'function') throw Error('missing mountIdealClientProfile export');
    const host = document.createElement('main'); document.body.append(host);
    const profile = date => ({ schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [
      { vertical: 'Synthetic dental', deal_type: 'lease', city: 'Synthetic city', state: 'TX', won_deals: 1, clients: 1,
        hypothesis: 'Historical fit, not a prediction or qualification rule.', evidence: [{ deal_id: '00000000-0000-4000-8000-000000000001', closed_on: date }] },
    ] });
    window.calendarProof = { date: '2026-02-31', reads: [], hold: false, pending: [] };
    window.calendarProof.createMount = () => mountIdealClientProfile(host, { getIdealClientProfile(filters) {
      const state = window.calendarProof;
      state.reads.push(filters);
      const result = profile(state.date);
      if (state.hold) return new Promise(resolve => state.pending.push(() => resolve(result)));
      return Promise.resolve(result);
    } });
    window.calendarProof.mount = window.calendarProof.createMount();
  }, moduleURL);
  const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
  await region.locator('summary').first().click();
  const refresh = () => region.getByRole('button', { name: 'Refresh history' }).click();
  const unavailable = async () => {
    await region.locator('[role="alert"], table').first().waitFor();
    assert.equal(await region.getByRole('table').count(), 0, 'invalid evidence must not claim a completed win');
    assert.match(await region.getByRole('alert').innerText(), /Historical client fit unavailable/);
  };
  await unavailable();
  for (const date of ['2025-02-29', '1900-02-29', '2026-13-01', '10000-01-01', '-001-01-01', '2026-04-31', '2026-00-01']) {
    await page.evaluate(date => { window.calendarProof.date = date; }, date);
    await refresh(); await unavailable();
  }
  for (const date of ['2024-02-29', '2000-02-29', '0000-01-01', '0099-12-31', '9999-12-31']) {
    await page.evaluate(date => { window.calendarProof.date = date; }, date);
    await refresh(); await region.getByRole('table').waitFor();
    await region.getByText('Wins (1)', { exact: true }).click();
    assert.equal(await region.locator('time').innerText(), date);
    assert.equal(await region.locator('time').getAttribute('datetime'), date);
    assert.equal(await region.getByRole('link').getAttribute('href'), '/deals?deal=00000000-0000-4000-8000-000000000001');
  }
  await region.getByLabel('City', { exact: true }).fill('Filtered city');
  await region.getByRole('button', { name: 'Apply filters' }).click();
  await region.getByRole('table').waitFor();
  assert.deepEqual(await page.evaluate(() => window.calendarProof.reads.at(-1)), { city: 'Filtered city' });
  await page.evaluate(() => { window.calendarProof.hold = true; window.calendarProof.date = '2026-02-31'; });
  await refresh(); await region.getByRole('status').waitFor();
  await page.evaluate(() => { window.calendarProof.hold = false; window.calendarProof.date = '2024-02-29'; });
  await refresh(); await region.getByRole('table').waitFor();
  await page.evaluate(() => window.calendarProof.pending.splice(0).forEach(resolve => resolve()));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await region.getByRole('alert').count(), 0, 'stale invalid receipt cannot replace valid history');
  await page.evaluate(() => { window.calendarProof.hold = true; });
  await refresh();
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  await page.evaluate(() => window.calendarProof.pending.splice(0).forEach(resolve => resolve()));
  assert.equal(await region.getByRole('table').count(), 0, 'invalidation clears pending evidence');
  await region.getByRole('status').waitFor();
  assert.match(await region.getByRole('status').innerText(), /Sign in again/);
  assert.equal(await region.locator('details, form, input, button, a, time').count(), 0, 'retired history exposes no controls or evidence');
  const retiredReads = await page.evaluate(() => window.calendarProof.reads.length);
  await page.evaluate(() => {
    window.calendarProof.mount.clear();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
  });
  assert.equal(await page.evaluate(() => window.calendarProof.reads.length), retiredReads, 'retired history never reloads');
  assert.equal(await region.getByRole('table').count(), 0, 'retired history stays empty');
  await page.evaluate(() => {
    window.calendarProof.mount.dispose();
    window.calendarProof.hold = false;
    window.calendarProof.mount = window.calendarProof.createMount();
  });
  await region.locator('summary').first().click(); await region.getByRole('table').waitFor();
  await page.evaluate(() => { window.calendarProof.hold = true; });
  await refresh();
  await page.evaluate(() => { window.calendarProof.mount.dispose(); window.calendarProof.pending.splice(0).forEach(resolve => resolve()); });
  assert.equal(await region.count(), 0, 'dispose prevents late receipts');
  return ['impossible dates refused without wins', 'valid leap day and supported years unchanged', 'deal links unchanged', 'filters preserved', 'stale receipt ignored', 'invalidation terminally retires history', 'dispose ignores pending receipt'];
}

export async function prove({ origin, timeout, revision }) {
  let browser, context, timer, expired = false;
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: timeout });
    if (release.source_commit !== revision) execFileSync('git', ['merge-base', '--is-ancestor', revision, release.source_commit], { timeout: 5000, stdio: 'pipe' });
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout });
    if (expired) { await browser.close(); throw Error('proof timeout'); }
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(timeout);
    let requests = 1;
    const modules = new Set(), violations = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (++requests > 40 || request.method() !== 'GET' || url.origin !== origin) {
        violations.push('request denied'); return route.abort();
      }
      if (url.pathname === '/__historical_fit_proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic calendar proof</title>' });
      if (!url.pathname.startsWith('/js/') || !url.pathname.endsWith('.js')) { violations.push('non-module denied'); return route.abort(); }
      modules.add(url.href);
      const asset = await route.fetch({ maxRedirects: 0, timeout });
      if (!asset.ok() || !/javascript/.test(asset.headers()['content-type'] || '')) {
        violations.push('module unavailable or sign-in required'); return route.abort();
      }
      return route.fulfill({ response: asset });
    });
    await page.goto(`${origin}/__historical_fit_proof__`);
    const assertions = await calendarAssertions(page, `${origin}/js/ui-ideal-client-profile.generated.js`);
    assert.deepEqual(violations, []);
    return { origin, release, expected_revision: revision, module_urls: [...modules], assertions, requests };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(Error('proof timeout')); }, timeout); })]);
  } finally {
    clearTimeout(timer);
    await context?.close(); await browser?.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) console.log(`Usage: node scripts/prove-historical-fit-calendar-date-integrity.mjs --origin <origin> [options]

Verify deployed historical client fit with synthetic calendar evidence.

  --help                       Show this help without network or browser work.
  --origin <origin>            Required HTTPS or loopback origin, without a path.
  --timeout-ms <ms>            Deadline in milliseconds, 100..300000. Default 30000.
  --expected-revision <sha>    Full 40-character revision. Default git HEAD.

Exits 0 on help or a successful proof. Exits 1 on invalid arguments or proof failure.`);
    else console.log(JSON.stringify(await prove(parsed)));
  }
  catch (error) { console.error(`Historical fit proof failed: ${error.message}`); process.exitCode = error.exitCode || 1; }
}
