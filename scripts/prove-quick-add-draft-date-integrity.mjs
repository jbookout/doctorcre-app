import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

let browser;
let timer;
try {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/prove-quick-add-draft-date-integrity.mjs --origin https://app.doctorcre.com --timeout-ms 30000');
  } else {
    const url = new URL(values.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Bad origin');
    const timeout = Number(values['timeout-ms']);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('Timeout must be 1..30000 ms');
    timer = setTimeout(() => { console.error('Proof timeout'); process.exitCode = 78; void browser?.close(); }, timeout);
    const release = await readAppRelease(url, { timeoutMs: timeout });
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(timeout);
    const loaded = new Set();
    let requests = 0;
    await context.route('**/*', route => {
      const request = route.request();
      const target = new URL(request.url());
      if (target.origin !== url.origin || request.method() !== 'GET' || ++requests > 64) return route.abort();
      if (target.pathname === '/__quick_add_proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic draft proof</title>' });
      loaded.add(target.href);
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${url.origin}/__quick_add_proof__`);
    const result = await page.evaluate(async () => {
      const check = (value, message) => { if (!value) throw Error(message); };
      const { createLocalDrafts } = await import('/js/local-drafts.mjs');
      check(typeof createLocalDrafts === 'function', 'Missing createLocalDrafts export');
      const data = new Map();
      const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
      const drafts = createLocalDrafts({ storage, viewer: 'synthetic-proof' });
      check(drafts.save('Call lender', '2026-02-31') === null, 'Impossible new date accepted');
      check(drafts.save('Call lender', '2028-02-29')?.dueDate === '2028-02-29', 'Leap day changed');
      const key = 'doctorcre:quick-add-drafts:v1:synthetic-proof';
      const before = JSON.parse(data.get(key));
      storage.setItem(key, JSON.stringify([...before, { id: 'bad', sentence: '  Call lender  ', dueDate: '2026-02-31', savedAt: 17 }]));
      const restored = createLocalDrafts({ storage, viewer: 'synthetic-proof' }).list();
      check(restored[0].dueDate === '2028-02-29', 'Restored leap day changed');
      check(restored[1]?.sentence === '  Call lender  ' && restored[1]?.dueDate === '2026-02-31' && restored[1]?.dateReviewRequired === true, 'Stored text or date-review disposition lost');
      return { assertions: ['reject-impossible-save', 'preserve-leap-day', 'retain-text-and-raw-date-for-review'] };
    });
    console.log(JSON.stringify({ origin: url.origin, release, ...result, loaded_module_urls: [...loaded].filter(url => /\.(m?js)(\?|$)/.test(url)), requests }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
} finally {
  await browser?.close();
  clearTimeout(timer);
}
