import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node scripts/prove-quick-switcher-partial-read.mjs --origin <http(s)-origin> --timeout-ms 30000\nUses a fresh unauthenticated browser. Protected assets block the proof. Emits a JSON receipt; fixture releases do not prove deployment.');
} else {
  let browser;
  let timer;
  try {
    const origin = new URL(values.origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('Expected a bare http(s) origin');
    const timeout = Number(values['timeout-ms']);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('timeout-ms must be 1..30000');
    const receipt = { origin: origin.origin, release: null, module_urls: [], assertions: [], requests: 0 };
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { void browser?.close(); reject(Error('Proof timeout')); }, timeout); });
    const run = async () => {
      receipt.release = await readAppRelease(origin, { timeoutMs: timeout });
      browser = await launchProofBrowser(chromium, { timeout, args: [...CHROMIUM_SAFETY_ARGS] });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      context.setDefaultTimeout(timeout);
      await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (++receipt.requests > 64 || request.method() !== 'GET' || url.origin !== origin.origin) return route.abort();
        if (url.pathname === '/__quick-switcher-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated switcher proof</title><button id="opener">Open</button>' });
        if ((url.pathname.startsWith('/js/') && url.pathname.endsWith('.js'))) return route.continue();
        if (url.pathname === '/deals' && url.search === '?deal=d1') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Selected Valid Deal</title>' });
        return route.abort();
      });
      const page = await context.newPage();
      page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/js/')) receipt.module_urls.push(response.url()); });
      await page.goto(`${origin.origin}/__quick-switcher-proof`);
      const open = async () => page.evaluate(async () => {
        const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
        if (typeof openQuickSwitcher !== 'function') throw Error('Missing openQuickSwitcher export');
        openQuickSwitcher({ opener: document.querySelector('#opener'), pages: [{ label: 'Calendar', href: '/calendar' }], read: async () => ({ board: { deals: [{ id: 'd1', name: 'Valid Deal' }] }, network: { nodes: null } }) });
      });
      await open();
      await page.getByRole('status').filter({ hasText: 'Contacts unavailable. Deals, tasks and pages are still available.' }).waitFor();
      await page.getByRole('combobox').fill('Valid Deal');
      await page.getByRole('option').filter({ hasText: 'Valid Deal' }).waitFor();
      receipt.assertions.push('Valid Deal remains searchable with malformed contacts', 'Partial availability is explained');
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      if (await page.locator('[data-quick-switcher]').count()) throw Error('Session invalidation retained record destinations');
      if (await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')) !== null) throw Error('Session invalidation retained recents');
      receipt.assertions.push('Session invalidation removes destinations and recents');
      await open();
      await page.getByRole('combobox').fill('Valid Deal');
      await page.getByRole('option').filter({ hasText: 'Valid Deal' }).waitFor();
      await page.getByRole('combobox').press('Enter');
      await page.waitForURL(`${origin.origin}/deals?deal=d1`);
      receipt.assertions.push('Keyboard selects the admitted Valid Deal');
      const output = JSON.stringify(receipt);
      if (receipt.requests > 64 || Buffer.byteLength(output) > 65536) throw Error('Proof evidence budget exceeded');
      console.log(output);
    };
    await Promise.race([run(), expired]);
  } catch (error) {
    console.error(`Quick switcher proof failed: ${error.message}`);
    process.exitCode = error.exitCode || 1;
  } finally { clearTimeout(timer); await browser?.close(); }
}
