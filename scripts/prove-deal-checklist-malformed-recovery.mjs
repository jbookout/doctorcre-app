import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { prove as runProof } from './prove-activity-attribution-panel.mjs';

export async function observeMalformedRecovery(page, origin) {
  let requests = 0;
  const loaded = new Set();
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.origin !== origin || ++requests > 40) return route.abort();
    if (url.pathname === '/__checklist-proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' });
    if (!/\.(?:m?js)$/.test(url.pathname)) return route.abort();
    return route.continue();
  });
  page.on('response', response => {
    if (response.ok() && /\.(?:m?js)$/.test(new URL(response.url()).pathname)) loaded.add(response.url());
  });
  await page.goto(`${origin}/__checklist-proof__`);
  const result = await page.evaluate(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const { mountDealChecklist } = await import('/js/ui-checklist.generated.js');
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
    check(document.querySelectorAll('[data-state="complete"]').length === 0, 'Received claimed complete');
    panel.update({dealId:'synthetic',checklist:{ ...valid, phases: [{ label: 'Legal', items: [{ ...item, status: 'complete' }] }] }});
    check(document.querySelector('[data-state="complete"] strong')?.textContent === 'Recorded complete', 'Complete semantics lost');
    assertions.push('valid-recovery-received-distinct-from-complete');
    panel.dispose();
    return { assertions };
  });
  if (!loaded.has(`${origin}/js/ui-checklist.generated.js`)) throw new Error('Deployed module was not loaded');
  return { origin, ...result, loaded_module_urls: [...loaded].sort(), requests, synthetic: true };
}

export function prove(options) {
  return runProof({ ...options, observe: options.observe || observeMalformedRecovery });
}

async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'expected-commit': { type: 'string' }, 'cdp-url': { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/prove-deal-checklist-malformed-recovery.mjs --origin https://app.doctorcre.com --expected-commit SHA [--cdp-url URL] [--timeout-ms 30000]');
    return;
  }
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeout-ms must be an integer from 1 to 30000');
  const result = await prove({ origin: values.origin, expectedCommit: values['expected-commit'], cdpUrl: values['cdp-url'], timeoutMs });
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.log(JSON.stringify({ status: 'insufficient_evidence', error: error.message }));
  process.exitCode = 78;
});
