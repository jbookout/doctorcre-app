import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';

export async function exerciseTerritoryEvidence() {
  const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.generated.js');
  const results = [];
  const check = (name, ok) => {
    if (!ok) throw new Error(name);
    results.push({ name, passed: true });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const evidence = patch => ({ flag_id: 'synthetic', source: 'Synthetic source', condition: 'tight',
    observed_at: '2028-02-29T12:00:00Z', expires_on: '2028-03-01', current: true, expired: false, ...patch });
  const board = patch => ({ schema_version: 'territory-state-board.v1', coverage: 'recorded_geographies_only',
    submarkets: [{ city: 'Synthetic Austin', state: 'TX', condition: 'tight', evidence: [evidence(patch)] }] });
  const host = document.createElement('div'); document.body.append(host);
  let payload = board(), failure, pending, authorized = 0, calls = [];
  const view = mountTerritoryEvidence(host, { getTerritoryStateBoard: async filters => {
    calls.push(filters);
    if (pending) return pending;
    if (failure) throw failure;
    return payload;
  } }, () => authorized++);
  const open = async () => {
    const details = host.querySelector('details'); details.open = true;
    details.dispatchEvent(new Event('toggle')); await settle();
  };
  const refresh = async () => { await view.refresh(); await settle(); };
  try {
    check('idle performs no read', calls.length === 0);
    await open();
    check('real leap date renders Current', !!host.querySelector('table') && host.textContent.includes('Current'));
    for (const patch of [
      { observed_at: '2026-02-31' }, { observed_at: '2026-02-31T12:00:00Z' },
      { observed_at: '1900-02-29T00:00:00Z' }, { expires_on: 'nonsense' }, { expires_on: '2026-04-31' },
      { observed_at: '2028-02-29T12:00:00' }, { observed_at: '2028-02-29T24:00:00Z' },
      { observed_at: '2028-02-29T12:00:00+24:00' }, { current: true, expired: true },
    ]) {
      payload = board(patch); await refresh();
      check(`reject ${JSON.stringify(patch)}`, !!host.querySelector('[role="alert"]') && !host.querySelector('table'));
      check('rejected response retains filters and retry', host.querySelectorAll('input').length === 3 && host.textContent.includes('Refresh evidence'));
    }
    for (const patch of [
      { expires_on: null }, { observed_at: '2000-02-29T07:00:00.123456-05:00' },
      { observed_at: '2000-02-29T17:30:00+05:30' },
      { observed_at: '0096-02-29T00:00:00Z', expires_on: '0096-03-01', current: false, expired: true },
      { observed_at: '1900-02-28T00:00:00Z', expires_on: '1900-03-01' },
      { current: false, expired: false },
    ]) {
      payload = board(patch); await refresh();
      check(`recover and preserve ${JSON.stringify(patch)}`, !!host.querySelector('table') && host.textContent.includes(payload.submarkets[0].evidence[0].observed_at));
    }
    for (const condition of ['unknown', 'conflicting']) {
      payload = board(); payload.submarkets[0].condition = condition;
      await refresh(); check(`server ${condition} preserved`, host.querySelector('td')?.textContent.toLowerCase() === condition);
    }
    payload = board(); payload.submarkets = Array.from({ length: 1001 }, () => payload.submarkets[0]);
    await refresh(); check('existing area cap rejects whole response', !!host.querySelector('[role="alert"]') && !host.querySelector('table'));
    payload = board(); await refresh();
    let release;
    pending = new Promise(resolve => { release = resolve; });
    const stale = view.refresh();
    check('loading hides prior evidence', !!host.querySelector('[role="status"]') && !host.querySelector('table'));
    let releaseCurrent;
    pending = new Promise(resolve => { releaseCurrent = resolve; });
    host.querySelector('input[name="city"]').value = 'New City';
    host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    check('filter generation starts new read', calls.at(-1).city === 'New City');
    const staleBoard = board(); staleBoard.submarkets[0].city = 'Stale City';
    release(staleBoard); await stale;
    check('stale success keeps newer request loading', !host.textContent.includes('Stale City') && !!host.querySelector('[role="status"]') && !host.querySelector('table'));
    releaseCurrent(board()); await settle(); pending = undefined;
    check('newer success renders after stale success', !!host.querySelector('table'));
    let reject;
    pending = new Promise((_, no) => { reject = no; });
    const staleFailure = view.refresh();
    pending = new Promise(resolve => { releaseCurrent = resolve; });
    const current = view.refresh();
    reject({ code: 'unauthorized' }); await staleFailure;
    check('stale authorization failure keeps newer request loading', authorized === 0 && !!host.querySelector('[role="status"]') && !host.querySelector('table'));
    releaseCurrent(board()); await current; pending = undefined;
    check('newer success renders after stale failure', !!host.querySelector('table'));
    failure = { code: 'forbidden' }; await refresh(); failure = undefined;
    check('authorization clears evidence', authorized === 1 && !host.querySelector('table') && !host.querySelector('details').open);
    await open(); check('cleared view can reload', !!host.querySelector('table'));
    view.clear(); check('explicit clear removes evidence', !host.querySelector('table'));
    await open();
    pending = new Promise(resolve => { release = resolve; });
    const disposed = view.refresh(); view.dispose(); release(board()); await disposed;
    check('disposed success ignored', host.childElementCount === 0);
  } finally { view.dispose(); host.remove(); }
  const lateHost = document.createElement('div'); document.body.append(lateHost);
  let rejectLate;
  const lateView = mountTerritoryEvidence(lateHost, { getTerritoryStateBoard: () => new Promise((_, reject) => { rejectLate = reject; }) }, () => authorized++);
  lateHost.querySelector('details').open = true;
  lateHost.querySelector('details').dispatchEvent(new Event('toggle'));
  await settle(); lateView.dispose(); rejectLate({ code: 'unauthorized' }); await settle();
  check('disposed failure ignored', lateHost.childElementCount === 0 && authorized === 1); lateHost.remove();
  for (const [state, patch, selector] of [
    ['ready', {}, 'table'], ['error', { observed_at: '2026-02-31' }, '[role="alert"]'],
  ]) {
    const teardownHost = document.createElement('div'); document.body.append(teardownHost);
    const teardownView = mountTerritoryEvidence(teardownHost, { getTerritoryStateBoard: async () => board(patch) }, () => authorized++);
    try {
      const details = teardownHost.querySelector('details'); details.open = true;
      details.dispatchEvent(new Event('toggle')); await settle();
      check(`${state} mounted before disposal`, !!teardownHost.querySelector(selector));
      teardownView.dispose();
      check(`${state} disposal empties host`, teardownHost.childElementCount === 0);
    } finally { teardownView.dispose(); teardownHost.remove(); }
  }
  return results;
}

export async function prove({ origin, timeoutMs }) {
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
    browser = await launchProofBrowser(chromium, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
    if (controller.signal.aborted) { await browser.close(); throw new Error('Total proof timeout'); }
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
    const assertions = await page.evaluate(exerciseTerritoryEvidence);
    return { release, assets: hashes, assertions, scope: 'Deployed synthetic resilience only. No signed-in business-data journey.' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Total proof timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    error.receipt = { release, assets: hashes, assertions: [{ name: error.message, passed: false }] }; throw error;
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms' || !/^\d+$/.test(args[3]) || Number(args[3]) < 1 || Number(args[3]) > 30000) throw new Error('Usage: --origin <origin> --timeout-ms <1..30000>');
    console.log(JSON.stringify(await prove({ origin: args[1], timeoutMs: Number(args[3]) })));
  } catch (error) { console.log(JSON.stringify(error.receipt || { error: error.message })); process.exitCode = error.exitCode || 1; }
}
