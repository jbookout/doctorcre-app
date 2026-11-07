import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function prove({ origin, timeoutMs = 30000 }) {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== origin || target.username || target.password) throw new Error('Supply an http(s) origin without a path or credentials');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeout-ms must be an integer from 1 to 30000');
  let browser;
  let expired = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('Proof timed out')); void browser?.close(); }, timeoutMs);
  });
  const run = async () => {
    const release = await readAppRelease(origin, { timeoutMs: timeoutMs });
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
    if (expired) { await browser.close(); throw new Error('Proof timed out'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0;
    const loaded = new Set();
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== origin || ++requests > 40) return route.abort();
      if (url.pathname === '/__checklist-proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' });
      if (!/\.(?:m?js)$/.test(url.pathname)) return route.abort();
      return route.continue();
    });
    context.on('response', response => {
      if (response.ok() && /\.(?:m?js)$/.test(new URL(response.url()).pathname)) loaded.add(response.url());
    });
    const page = await context.newPage();
    await page.goto(`${origin}/__checklist-proof__`, { timeout: timeoutMs });
    const result = await page.evaluate(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const { mountDealChecklist } = await import('/js/ui-checklist.js');
      check(typeof mountDealChecklist === 'function', 'Missing mountDealChecklist export');
      const panel = mountDealChecklist(document.querySelector('main'), {dealId:'synthetic',checklist:null});
      const item = { id: 'lease', label: 'Synthetic lease', status: 'received', source: { document: 'synthetic-kit' } };
      const valid = { schema_version: 'deal-checklist.v1', template_state: 'current', phases: [{ label: 'Legal', items: [item] }], due_items: [] };
      const assertions = [];
      for (const [id, value] of [
        ['malformed-phases', { ...valid, phases: null }],
        ['missing-source', { ...valid, phases: [{ label: 'Legal', items: [{ ...item, source: undefined }] }] }],
      ]) {
        panel.update({dealId:'synthetic',checklist:value});
        check(document.querySelector('[role="status"]')?.textContent === 'Checklist unavailable.', `${id} unavailable`);
        check(document.querySelector('[data-refresh-detail]')?.textContent === 'Refresh deal', `${id} refresh`);
        check(!document.querySelector('[data-checklist-item]'), `${id} must not claim completion`);
        assertions.push(id);
      }
      panel.update({dealId:'synthetic',checklist:valid});
      check(document.querySelector('[data-state="received"] strong')?.textContent === 'Received', 'Received semantics lost');
      check(!document.querySelector('main').textContent.includes('Recorded complete'), 'Received claimed complete');
      panel.update({dealId:'synthetic',checklist:{ ...valid, phases: [{ label: 'Legal', items: [{ ...item, status: 'complete' }] }] }});
      check(document.querySelector('[data-state="complete"] strong')?.textContent === 'Recorded complete', 'Complete semantics lost');
      assertions.push('valid-recovery-received-distinct-from-complete');
      panel.dispose();
      return { assertions };
    });
    if (!loaded.has(`${origin}/js/ui-checklist.js`)) throw new Error('Deployed module was not loaded');
    return { origin, release, ...result, loaded_module_urls: [...loaded].sort(), requests, synthetic: true };
  };
  try { return await Promise.race([run(), deadline]); }
  finally { clearTimeout(timer); await browser?.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write('Usage: node scripts/prove-deal-checklist-malformed-recovery.mjs --origin https://app.doctorcre.com --timeout-ms 30000\nRead-only synthetic deployed-module proof. Emits a JSON receipt. No session credentials are loaded.\n');
    return;
  }
  if (!values.origin) throw new Error('--origin is required');
  process.stdout.write(`${JSON.stringify(await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode || 1;
});
