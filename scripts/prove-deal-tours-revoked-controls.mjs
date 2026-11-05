import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function parseArgs(args) {
  const options = { timeoutMs: 30000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true };
    if (args[i] === '--origin') options.origin = args[++i];
    else if (args[i] === '--timeout-ms') options.timeoutMs = Number(args[++i]);
    else throw Error(`Unknown option ${args[i]}`);
  }
  const url = new URL(options.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== options.origin) throw Error('Expected an HTTP origin without a path');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000) throw Error('Timeout must be 1 through 30000ms');
  return options;
}

export async function prove({ origin, timeoutMs = 30000, screenshotDir }) {
  const started = Date.now();
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
  let timer;
  const work = async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const modules = new Set();
    let requests = 0;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (++requests > 50 || request.method() !== 'GET' || url.origin !== origin) return route.abort();
      if (url.pathname === '/__revoked-controls-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Tour session proof</title><div id="view"></div>' });
      if (url.pathname.startsWith('/tours/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic editor</title>' });
      if (url.pathname === '/app-release' || url.pathname.startsWith('/js/')) return route.continue();
      return route.abort();
    });
    page.on('response', response => { if (new URL(response.url()).pathname.endsWith('.js')) modules.add(response.url()); });
    await page.goto(`${origin}/__revoked-controls-proof`);
    const release = await page.evaluate(async () => {
      const response = await fetch('/app-release');
      if (!response.ok) throw Error('Release identity unavailable');
      return response.json();
    });
    assert.equal(release.service, 'doctorcre-app', 'Release application identity');
    assert.match(release.source_commit, /^[a-f0-9]{40}$/, 'Release source identity');
    const assertions = [];
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      assertions.push(await page.evaluate(async () => {
        const { mountDealTours } = await import('/js/ui-deal-tours.js');
        if (typeof mountDealTours !== 'function') throw Error('Missing mountDealTours export');
        const root = document.querySelector('#view');
        const dealId = '11111111-1111-4111-8111-111111111111';
        let reads = 0, navigations = 0;
        const client = { scope: 'verified-synthetic-actor', library: async () => { ++reads; return []; }, tour: async () => { ++reads; throw Error('Unexpected detail'); } };
        const panel = mountDealTours(root, { dealId, client, navigate() { ++navigations; } });
        await new Promise(resolve => requestAnimationFrame(resolve));
        root.querySelector('[data-start-tour]').click();
        if (!root.querySelector('iframe')) throw Error('Fresh verified mount did not create editor');
        dispatchEvent(new Event('doctorcre-session-invalidated'));
        const before = { reads, navigations };
        root.querySelector('[data-start-tour]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        root.querySelector('[data-refresh-tours]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await panel.refresh();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (root.querySelector('iframe')) throw Error('Retired instance recreated iframe');
        if (reads !== before.reads || navigations !== before.navigations) throw Error('Retired instance issued a read or navigation');
        if (!root.textContent.includes('session has changed')) throw Error('Retired status missing');
        panel.dispose();
        const fresh = mountDealTours(root, { dealId, client, navigate() {} });
        await new Promise(resolve => requestAnimationFrame(resolve));
        root.querySelector('[data-start-tour]').click();
        if (!root.querySelector('iframe')) throw Error('Separately verified fresh mount failed');
        dispatchEvent(new Event('doctorcre-session-invalidated'));
        window.__tourProofDispose = () => fresh.dispose();
        return { clearedFrame: true, refusedStartAndRefresh: true, zeroNewReadsAndNavigation: true, freshMountWorks: true };
      }));
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${width}-${theme}-retired.png`, fullPage: true });
      await page.evaluate(() => window.__tourProofDispose());
    }
    return { origin, release, loadedModuleUrls: [...modules], assertions, requests, evidenceClass: 'deployed-code-synthetic-clients' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Proof timeout')), Math.max(1, timeoutMs - (Date.now() - started))); })]);
  } finally { clearTimeout(timer); await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/prove-deal-tours-revoked-controls.mjs --origin <http-origin> --timeout-ms 30000');
    else console.log(JSON.stringify(await prove(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
