import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { init, parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function exercise(moduleUrl) {
  const { mountCallReview } = await import(moduleUrl);
  const check = (value, message) => { if (!value) throw new Error(message); };
  check(typeof mountCallReview === 'function', 'Missing mountCallReview export');
  const node = document.createElement('main'); document.body.replaceChildren(node);
  const writes = [], assertions = [];
  const rows = [{ session_id: 'synthetic-call', call_date: '2026-10-01', applied: [], open_cards: [{ candidate_id: 'synthetic-candidate', kind: 'assigned_action', resolver: 'resolve-post-call-candidate', payload: { action: 'Synthetic task' } }] }];
  const view = mountCallReview(node, { sessionId: 'synthetic-call', describe: () => 'Task', undoRefusal: () => '', client: () => ({
    readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
    resolvePostCallCandidate: async args => { writes.push(args); if (writes.length === 1) throw new Error('Synthetic lost reply'); rows[0].open_cards = []; return { ok: true }; },
  }) });
  const button = name => [...node.querySelectorAll('button')].find(row => row.textContent === name);
  const click = async name => {
    const target = button(name); check(target && !target.disabled, `Enabled ${name}`); target.click();
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let attempt = 0; attempt < 100 && button('Refresh call review')?.disabled; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  try {
    await view.refresh(); await click('Approve or fix this item'); await click('Approve item');
    check(writes.length === 1, 'No automatic write retry'); assertions.push('no-automatic-write-retry');
    check(button('Approve item')?.disabled && button('Skip item')?.disabled, 'Unknown outcome blocks new decisions'); assertions.push('unknown-outcome-blocks-new-decisions');
    await click('Check outcome');
    check(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'Exact original decision replay'); assertions.push('exact-original-decision-replay');
    check(node.textContent.includes('No longer pending'), 'Authoritative readback resolves item'); assertions.push('authoritative-resolution');
    return assertions;
  } finally { view.dispose(); }
}

export async function prove({ origin, timeoutMs = 30000 }) {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== origin || target.username || target.password) throw new Error('Supply an HTTP origin without path or credentials');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeout-ms must be 1 to 30000');
  const controller = new AbortController();
  let browser, requests = 0, timer;
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const fetchBytes = async path => {
    if (++requests > 10) throw new Error('Ten HTTP request cap exceeded');
    try {
      const response = await fetch(new URL(path, origin), { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw unavailable('Release or asset unavailable');
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 8_000_000) throw new Error('Asset exceeds byte cap');
      return data;
    } catch (error) { if (error.exitCode || error.message === 'Asset exceeds byte cap') throw error; throw unavailable('Release or asset unavailable'); }
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable('Proof timed out')); void browser?.close(); }, timeoutMs); });
  const run = async () => {
    const release = JSON.parse((await fetchBytes('/app-release')).toString());
    if (release.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(release.source_commit)) throw unavailable('Release identity unavailable');
    const manifest = JSON.parse((await fetchBytes('/artifact-manifest.json')).toString());
    if (manifest.schema !== 'doctorcre-static-artifact.v1' || manifest.source_commit !== release.source_commit || !Array.isArray(manifest.files)) throw new Error('Manifest identity mismatch');
    const assets = new Map(), hashes = {};
    await init;
    async function load(path) {
      if (assets.has(path)) return;
      if (!/^\/js\/[a-zA-Z0-9_.-]+\.js$/.test(path)) throw new Error('Asset outside admitted graph');
      const entries = manifest.files.filter(row => row.path === path.slice(1));
      if (entries.length !== 1) throw new Error('Asset missing or duplicated in manifest');
      const bytes = await fetchBytes(path), sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== entries[0].sha256 || bytes.length !== entries[0].bytes) throw new Error('Asset hash mismatch');
      assets.set(path, bytes); hashes[path] = sha;
      for (const entry of parse(bytes.toString())[0]) {
        if (entry.d === -2) continue;
        if (!entry.n) throw new Error('Unbounded module import');
        const url = new URL(entry.n, origin + path);
        if (url.origin !== origin || url.search || url.hash) throw new Error('Cross-origin asset');
        await load(url.pathname);
      }
    }
    await load('/js/ui-call.js');
    browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
    if (controller.signal.aborted) { await browser.close(); throw unavailable('Proof timed out'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/__call-review-proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: 'text/javascript', body: bytes }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin + '/__call-review-proof__');
    const assertions = await page.evaluate(exercise, origin + '/js/ui-call.js');
    return { release, assets: hashes, assertions, requests, max_requests: 10, synthetic: true };
  };
  try { return await Promise.race([run(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
    if (!values.origin) throw new Error('--origin required');
    process.stdout.write(JSON.stringify(await prove({ origin: values.origin, timeoutMs: Number(values['timeout-ms']) })) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = error.exitCode ?? 1; }
}
