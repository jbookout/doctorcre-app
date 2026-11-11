import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function parseArgs(args) {
  const options = { timeoutMs: 30000 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') return { help: true };
    if (!['--origin', '--timeout-ms'].includes(flag) || !args[i + 1]) throw new Error(`Invalid argument ${flag}`);
    const value = args[++i];
    if (flag === '--origin') options.origin = value;
    else options.timeoutMs = Number(value);
  }
  const url = new URL(options.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== options.origin) throw new Error('Supply an HTTP origin without credentials, path or query');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000) throw new Error('Timeout must be 1 to 30000ms');
  return options;
}

export async function prove({ origin, timeoutMs = 30000 }) {
  let browser, timer, context, stopped = false;
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: timeoutMs });
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
    if (stopped) { await browser.close(); throw new Error('Proof timeout'); }
    context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(timeoutMs);
    const urls = [], errors = [];
    let requests = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (++requests > 40 || request.method() !== 'GET' || url.origin !== origin) return route.abort();
      if (url.pathname === '/__market-terms-proof') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main><h1>Synthetic deal workspace</h1><input id="workspace-note" value="Retained note"><section id="comparison"></section></main></body></html>'});
      if (/^\/js\/[\w.-]+\.js$/.test(url.pathname)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/js/')) urls.push(response.url()); });
    await page.goto(`${origin}/__market-terms-proof`);
    await page.evaluate(async () => {
      const module = await import('/js/ui-market.generated.js');
      if (typeof module.mountMarketTerms !== 'function') throw new Error('Missing mountMarketTerms export');
      let reads = 0;
      window.proofCalls = [];
      window.proofPanel = module.mountMarketTerms(document.querySelector('#comparison'), {entityRef:'synthetic-deal',submarket:'North',client:{readMarketTerms:async args => {
        window.proofCalls.push(args);
        return {ok:true,schema_version:'market-terms.v1',rows:++reads === 1 ? [null] : [{entity_ref:'synthetic-deal',fact_key:'rent',value:'35',unit:'USD/sf/year',term_kind:'executed',term_date:'2025-01-01',effective_from:'2025-01-01',effective_to:null,confidence:'human_review',sources:[]}],coverage:{recorded_documents:1,canonical_receipts:1,unsupported_receipts:0,unclassified_receipts:0,comparable_deals:1}};
      }}});
    });
    const root = page.locator('#comparison');
    await root.getByText('Could not load comparable terms. Try again.').waitFor();
    assert.equal(await root.locator('table').count(), 0);
    assert.equal(await page.evaluate(() => window.proofCalls.length), 1);
    await root.locator('[name=submarket]').fill('South');
    await root.locator('[name=as_of]').fill('2025-01-01');
    await root.getByRole('button', {name:'Compare',exact:true}).click();
    await root.getByText('rent: $35.00/sf/year', {exact:true}).waitFor();
    assert.match(await root.textContent(), /Terms as of 2025-01-01/);
    assert.equal(await page.locator('#workspace-note').inputValue(), 'Retained note');
    assert.deepEqual(await page.evaluate(() => window.proofCalls), [{submarket:'North'},{submarket:'South',as_of:'2025-01-01'}]);
    await page.evaluate(() => window.proofPanel.dispose());
    assert.deepEqual(errors, []);
    assert.ok(urls.includes(`${origin}/js/ui-market.generated.js`));
    return {origin,release,loaded_module_urls:[...new Set(urls)],assertions:['malformed rows refused','filters retained and usable','one explicit retry recovers valid terms','workspace retained','no unhandled page error'],synthetic:true};
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Proof timeout')), timeoutMs); })]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    await context?.close();
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/prove-market-terms-response-recovery.mjs --origin https://app.doctorcre.com --timeout-ms 30000');
    else console.log(JSON.stringify(await prove(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
