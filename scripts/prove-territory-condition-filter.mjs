import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';

export const territoryResponse = {"schema_version":"territory-state-board.v1","coverage":"recorded_geographies_only","submarkets":[{"city":"Balanced City","state":"TX","condition":"balanced","evidence":[{"flag_id":"fixture-balanced-true","condition":"balanced","source":"Synthetic balanced source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2099-04-01","current":true,"expired":false}]},{"city":"Conflict City","state":"TX","condition":"conflicting","evidence":[{"flag_id":"fixture-soft-true","condition":"soft","source":"Synthetic soft source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2099-04-01","current":true,"expired":false},{"flag_id":"fixture-tight-true","condition":"tight","source":"Synthetic tight source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2099-04-01","current":true,"expired":false}]},{"city":"Expired City","state":"TX","condition":"unknown","evidence":[{"flag_id":"fixture-tight-false","condition":"tight","source":"Synthetic tight source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2026-02-01","current":false,"expired":true}]},{"city":"Soft City","state":"TX","condition":"soft","evidence":[{"flag_id":"fixture-soft-true","condition":"soft","source":"Synthetic soft source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2099-04-01","current":true,"expired":false}]},{"city":"Tight City","state":"TX","condition":"tight","evidence":[{"flag_id":"fixture-tight-true","condition":"tight","source":"Synthetic tight source","observed_at":"2026-01-01T12:00:00Z","expires_on":"2099-04-01","current":true,"expired":false}]},{"city":"Unknown City","state":"TX","condition":"unknown","evidence":[]}]};

export async function exerciseConditionFilter(response) {
  const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.generated.js');
  const results = [];
  const check = (name, ok) => {
    if (!ok) throw new Error(name);
    results.push({ name, passed: true });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const host = document.createElement('div'); document.body.append(host);
  let payload = structuredClone(response), failure, pending, calls = [], authorized = 0;
  const view = mountTerritoryEvidence(host, { getTerritoryStateBoard: async filters => {
    calls.push(filters);
    if (failure) throw failure;
    return pending || payload;
  } }, () => authorized++);
  const open = async () => {
    host.querySelector('details').open = true;
    host.querySelector('details').dispatchEvent(new Event('toggle'));
    await settle();
  };
  const select = async value => {
    const selector = host.querySelector('select');
    check('labeled Condition selector exists', selector && selector.closest('label').textContent.includes('Condition'));
    selector.value = value; selector.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  };
  const rows = () => [...host.querySelectorAll('tbody th')].map(row => row.textContent);
  const expected = condition => response.submarkets.filter(row => condition === 'all' || row.condition === condition).map(row => `${row.city}, ${row.state}`);
  try {
    check('idle has no reads', calls.length === 0);
    await open();
    check('parser accepts registered handler response', JSON.stringify(rows()) === JSON.stringify(expected('all')));
    for (const value of ['unknown', 'conflicting', 'soft', 'balanced', 'tight', 'all']) {
      const before = calls.length;
      await select(value);
      check(`filter ${value} preserves server order`, JSON.stringify(rows()) === JSON.stringify(expected(value)));
      check(`filter ${value} performs no read`, calls.length === before);
      check(`filter ${value} reports matching and loaded counts`, host.textContent.includes(`${expected(value).length} matching loaded areas / ${response.submarkets.length} total loaded areas`));
      check(`filter ${value} retains coverage and meanings`, host.textContent.includes('Unknown means no current evidence; conflicting means current sources disagree.'));
    }
    await select('unknown');
    host.querySelector('tbody details').open = true;
    check('historical disclosure preserved', host.textContent.includes('Historical · expired') && host.textContent.includes('Synthetic tight source'));
    await select('conflicting');
    host.querySelector('tbody details').open = true;
    check('conflicting disclosures preserved', host.textContent.includes('Synthetic soft source') && host.textContent.includes('Current'));
    await select('tight'); await view.refresh();
    check('refresh retains selection', host.querySelector('select').value === 'tight' && JSON.stringify(rows()) === JSON.stringify(expected('tight')));
    host.querySelector('input[name="city"]').value = 'Unknown City';
    payload = structuredClone(response); payload.submarkets = payload.submarkets.filter(row => row.city === 'Unknown City');
    host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    check('server filters retain local selection', host.querySelector('select').value === 'tight' && calls.at(-1).city === 'Unknown City');
    check('no local matches has scoped message', host.textContent.includes('No loaded areas match this condition.') && rows().length === 0);
    payload = structuredClone(response); payload.submarkets = []; await view.refresh();
    check('empty response retains coverage and count', host.textContent.includes('0 matching loaded areas / 0 total loaded areas') && host.textContent.includes('No loaded areas match this condition.'));
    payload = structuredClone(response); payload.submarkets[0].evidence[0].observed_at = '2028-02-31T12:00:00Z'; await view.refresh();
    check('production parser rejects malformed date', !!host.querySelector('[role="alert"]') && rows().length === 0);
    payload = structuredClone(response); await view.refresh();
    check('valid retry retains selection', host.querySelector('select').value === 'tight' && rows().length === 1);
    host.querySelector('details').open = false; host.querySelector('details').dispatchEvent(new Event('toggle')); await settle();
    await open(); check('disclosure reopen retains selection', host.querySelector('select').value === 'tight');
    failure = { code: 'unauthorized' }; await view.refresh(); failure = undefined;
    check('auth retirement clears data and selection', authorized === 1 && rows().length === 0 && !host.querySelector('details').open && host.querySelector('select').value === 'all');
    await open(); await select('soft'); view.clear(); await open();
    check('explicit clear resets selection', host.querySelector('select').value === 'all' && rows().length === response.submarkets.length);
    let release;
    pending = new Promise(resolve => { release = resolve; });
    const stale = view.refresh(); view.clear(); release(response); await stale; pending = undefined;
    check('clear retires pending response', rows().length === 0 && host.querySelector('select').value === 'all');
    await open(); await select('balanced');
    pending = new Promise(resolve => { release = resolve; });
    const retired = view.refresh(); view.dispose(); release(response); await retired;
    check('dispose retires pending response and local state', host.childElementCount === 0);
  } finally { view.dispose(); host.remove(); }
  return results;
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium, exercise = exerciseConditionFilter }) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Expected an origin');
  const assets = new Map(), hashes = [];
  let release, browser, timer;
  const controller = new AbortController();
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const work = async () => {
    const fetchBytes = async path => {
      let response;
      try { response = await proofFetch(new URL(path, base), { signal: controller.signal, redirect: 'error' }); }
      catch (error) { if (controller.signal.aborted) throw error; throw unavailable(`Unavailable ${path}`); }
      if (!response.ok) throw unavailable(`Unavailable ${path}`);
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw unavailable('Asset exceeds byte cap'); }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      hashes.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
      return bytes;
    };
    release = await readAppRelease(base, async url => ({ type: 'application/json', body: await fetchBytes(url.pathname) }));
    await init;
    const queue = ['/js/ui-territory-evidence.generated.js'];
    for (let i = 0; i < queue.length; i++) {
      if (queue.length > 19) throw unavailable('Module asset cap exceeded');
      const path = queue[i], bytes = await fetchBytes(path); assets.set(path, bytes);
      for (const entry of parse(bytes.toString('utf8'))[0]) {
        if (entry.d === -2) continue;
        if (!entry.n) throw unavailable('Uninspectable module dependency');
        const url = new URL(entry.n, new URL(path, base));
        if (url.origin !== base.origin || url.search || url.hash || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname)) throw unavailable('Module dependency outside allowlist');
        if (!queue.includes(url.pathname)) queue.push(url.pathname);
      }
    }
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: controller.signal });
    if (controller.signal.aborted) { await browser.close(); throw unavailable('Total proof timeout'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) return route.abort();
      if (url.pathname === '/__territory_proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic territory proof</title><body></body>' });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: 'text/javascript', body: bytes }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(new URL('/__territory_proof__', base).href, { timeout: timeoutMs });
    const assertions = await page.evaluate(exercise, territoryResponse);
    return { release, assets: hashes, assertions, scope: 'deployed_module_fixture', natural: { status: 'insufficient_evidence', reason: 'No existing signed-in app session was observed. Fixture assertions cannot prove natural acceptance.' } };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('Total proof timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    error.receipt = { release, assets: hashes, assertions: [{ name: error.message, passed: false }] }; throw error;
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (![2, 4].includes(args.length) || args[0] !== '--origin' || (args.length === 4 && (args[2] !== '--timeout-ms' || !/^\d+$/.test(args[3]) || Number(args[3]) < 1 || Number(args[3]) > 30000))) throw new Error('Usage: --origin <origin> --timeout-ms <1..30000>');
    const receipt = await prove({ origin: args[1], timeoutMs: args[3] ? Number(args[3]) : 30000 });
    console.log(JSON.stringify(receipt));
    process.exitCode = 78;
  } catch (error) { console.log(JSON.stringify(error.receipt || { error: error.message })); process.exitCode = error.exitCode || 1; }
}
