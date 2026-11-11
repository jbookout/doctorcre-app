import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from './proof-browser.mjs';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { marketTermsFixtures } from '../test/fixtures/market-terms.mjs';

export async function exerciseFilter(page, origin) {
  const fixtures = marketTermsFixtures();
  await page.evaluate(async ({origin, fixtures}) => {
    const { mountMarketTerms } = await import('/js/ui-market.generated.js');
    window.filterFixtures = fixtures;
    window.filterResponse = fixtures.full;
    window.filterCalls = [];
    window.filterMalformed = false;
    window.filterPanel = mountMarketTerms(document.querySelector('#comparison'), {entityRef:'synthetic-a',dealName:ref => ref,client:{readMarketTerms:async args => {
      window.filterCalls.push(args);
      return window.filterMalformed ? {...window.filterResponse,rows:[null]} : window.filterResponse;
    }}});
  }, {origin, fixtures});
  const root = page.locator('#comparison'), selector = root.getByLabel('Term', {exact:true});
  await selector.waitFor();
  assert.deepEqual(await selector.locator('option').allTextContents(), ['All terms','TI','rent']);
  assert.match(await root.textContent(), /3 matching loaded terms across 2 deals/);
  await selector.selectOption('rent');
  await root.getByText('2 matching loaded terms across 2 deals.', {exact:true}).waitFor();
  assert.equal(await root.locator('tbody tr').count(), 2);
  assert.ok((await root.locator('[data-label=Term]').allTextContents()).every(text => text.startsWith('rent:')));
  assert.match(await root.locator('tbody').textContent(), /NNN.*human review.*synthetic-source, p. 2–3/s);
  assert.equal(await root.locator('tbody a').first().getAttribute('href'), '/deals?deal=synthetic-a');
  await root.getByText('Firm-wide coverage (not filtered)', {exact:true}).click();
  assert.match(await root.locator('details').textContent(), /3 of 100 receipts eligible/);
  await root.locator('summary').click();
  await selector.selectOption('');
  await root.getByText('3 matching loaded terms across 2 deals.', {exact:true}).waitFor();
  await selector.selectOption('TI');
  await root.getByText('1 matching loaded term across 1 deal.', {exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.filterCalls.length), 1);
  await page.evaluate(() => window.filterPanel.refresh());
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'TI');
  await page.evaluate(() => { window.filterResponse = window.filterFixtures.rent; window.filterPanel.refresh(); });
  await root.getByText('2 matching loaded terms across 2 deals.', {exact:true}).waitFor();
  assert.equal(await selector.inputValue(), '');
  assert.deepEqual(await selector.locator('option').allTextContents(), ['All terms','rent']);
  await selector.selectOption('rent');
  await page.evaluate(() => { window.filterMalformed = true; window.filterPanel.refresh(); });
  await root.getByText('Could not load comparable terms. Try again.').waitFor();
  assert.equal(await root.locator('table').count(), 0);
  await page.evaluate(() => { window.filterMalformed = false; window.filterResponse = window.filterFixtures.south; });
  await root.locator('[name=submarket]').fill('South');
  await root.locator('[name=use_type]').fill('Medical');
  await root.locator('[name=as_of]').fill('2025-01-01');
  await root.getByRole('button', {name:'Compare',exact:true}).click();
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'rent');
  assert.deepEqual(await page.evaluate(() => window.filterCalls.at(-1)), {submarket:'South',use_type:'Medical',as_of:'2025-01-01'});
  assert.match(await root.textContent(), /Terms as of 2025-01-01/);
  await page.evaluate(() => { window.filterResponse = window.filterFixtures.empty; window.filterPanel.refresh(); });
  await root.getByText('No comparable terms match these filters.').waitFor();
  assert.deepEqual(await selector.locator('option').allTextContents(), ['All terms']);
  assert.equal(await selector.inputValue(), '');
  assert.match(await root.textContent(), /0 matching loaded terms across 0 deals/);
  const reads = await page.evaluate(() => window.filterCalls.length);
  await page.evaluate(() => window.filterPanel.dispose());
  assert.equal(await root.textContent(), '');
  return {reads,local_changes_without_reads:true};
}

export async function prove({ origin, timeoutMs = 30000, fixture = false, engine = chromium }) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && ['http:','https:'].includes(url.protocol) && !url.username && !url.password, 'origin only');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'bounded timeout');
  const unavailable = message => Object.assign(new Error(message), {exitCode:78});
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable('Proof timeout')), timeoutMs);
  let browser;
  try {
    const before = await readAppRelease(origin, {timeoutMs:remaining()});
    controller.signal.throwIfAborted();
    if (!fixture || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw unavailable('insufficient_evidence: natural signed-in observation belongs to authorized proof worker');
    browser = await launchProofBrowser(engine, {timeout:timeoutMs}, {signal:controller.signal});
    const page = await browser.newPage();
    let requests = 0, bytes = 0;
    await page.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (++requests > 40 || route.request().method() !== 'GET' || target.origin !== origin) return route.abort();
      if (target.pathname === '/__fact-filter-proof') return route.fulfill({contentType:'text/html',body:'<main id="comparison"></main>'});
      if (!/^\/js\/[\w.-]+\.js$/.test(target.pathname)) return route.abort();
      try {
        const response = await proofFetch(target, {signal:controller.signal});
        assert.ok(response.ok && /javascript/.test(response.headers.get('content-type')), 'JavaScript asset');
        const chunks = [];
        for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 * 1024, 'asset byte cap'); chunks.push(chunk); }
        await route.fulfill({contentType:'text/javascript',body:Buffer.concat(chunks)});
      } catch { await route.abort().catch(() => {}); }
    });
    await page.goto(`${origin}/__fact-filter-proof`);
    const assertions = await exerciseFilter(page, origin);
    const after = await readAppRelease(origin, {timeoutMs:remaining()});
    controller.signal.throwIfAborted();
    assert.deepEqual(after, before, 'unchanged release identity');
    return {status:'fixture_only',production_acceptance:false,natural_observation:{status:'insufficient_evidence',reason:'No session-bound natural business read executed'},deployed_asset_fixture:{release:before,assertions},requests};
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), fixture = args.includes('--fixture');
    if (fixture) args.splice(args.indexOf('--fixture'),1);
    assert.equal(args.length,4,'usage: --origin URL --timeout-ms 30000 [--fixture]');
    assert.equal(args[0],'--origin'); assert.equal(args[2],'--timeout-ms');
    console.log(JSON.stringify(await prove({origin:args[1],timeoutMs:Number(args[3]),fixture})));
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
