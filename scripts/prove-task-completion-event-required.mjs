import { isAppRepository } from '../js/repository-identity.mjs';
import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeTaskReceipts(page, assetUrl) {
  return page.evaluate(async url => {
    const { parseActionReceipt, completeAction, complete, retain } = await import(url);
    const assertions = [];
    const check = (value, name) => { if (!value) throw Error(name); assertions.push(name); };
    const args = { action_id: '00000000-0000-4000-8000-000000000002', base_version: 1, idempotency_key: '00000000-0000-4000-8000-000000000003' };
    const event = '00000000-0000-4000-8000-000000000009';
    const receipt = { ok: true, action_id: args.action_id, status: 'done', version: 2, completion_event_id: event };
    for (const [name, fields] of [['absent', { completion_event_id: undefined }], ['null', { completion_event_id: null }], ['malformed', { completion_event_id: 'bad' }], ['unrelated', { action_id: event }], ['contradictory', { status: 'open' }], ['stale', { version: 1 }]]) {
      let refused = false;
      try { await completeAction({ completeOneAction: async () => { const value = { ...receipt, ...fields }; if (name === 'absent') delete value.completion_event_id; return value; } }, args); } catch { refused = true; }
      check(refused, `done refuses ${name}`);
    }
    check((await completeAction({ completeOneAction: async () => receipt }, args)).completion_event_id === event, 'valid completion admitted');
    check(parseActionReceipt({ ...receipt, version: 3, status: 'open' }, { ...args, base_version: 2, completion_event_id: event }, 'open').completion_event_id === event, 'original Undo event admitted');
    for (const completion_event_id of [null, undefined, args.action_id]) {
      let refused = false;
      try { parseActionReceipt({ ...receipt, version: 3, status: 'open', completion_event_id }, { ...args, base_version: 2, completion_event_id: event }, 'open'); } catch { refused = true; }
      check(refused, `Undo refuses ${completion_event_id}`);
    }
    const host = document.body.appendChild(document.createElement('main'));
    host.innerHTML = `<article><a href="#">Synthetic task</a><button data-task-done="${args.action_id}" data-version="1" data-deal="synthetic">Done</button></article>`;
    const button = host.querySelector('button');
    const row = { id: args.action_id, status: 'open' };
    const snapshot = { details: new Map([['synthetic', { next_actions: [row] }]]) };
    let reads = 0, updates = 0;
    const writes = [];
    const client = { completeOneAction: async value => { writes.push(structuredClone(value)); return writes.length === 1 ? { ok: true, action_id: args.action_id, status: 'done', version: 2 } : receipt; }, getDeal: async () => { reads++; return { next_actions: [{ ...row, status: 'done' }] }; } };
    try {
      await complete(host, button, client, () => updates++, () => true, snapshot);
      check(updates === 0 && reads === 0 && !button.disabled, 'missing event keeps completion available without readback');
      const refreshed = { details: new Map([['synthetic', { next_actions: [] }]]) };
      retain(host, refreshed);
      check(refreshed.details.get('synthetic').next_actions[0] === row, 'recovery retains task');
      await complete(host, button, client, () => updates++, () => true, snapshot);
      check(JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'recovery replays exact request');
      check(updates === 1 && reads === 1, 'valid replay confirms after readback');
    } finally { host.remove(); }
    return assertions;
  }, assetUrl);
}

export async function prove({ origin, timeoutMs }) {
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let browser, requests = 0, bytes = 0;
  const remaining = () => Math.max(1, deadline - Date.now());
  const get = async path => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.search || url.hash || ++requests > 10) throw Error('HTTP request budget or same-origin rule violated');
    try {
      const response = await proofFetch(url, { signal: controller.signal, redirect: 'manual' });
      if (!response.ok) throw unavailable(`Evidence unavailable: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      bytes += data.length;
      if (data.length > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024) throw Error('Evidence byte budget exceeded');
      return data;
    } catch (error) { if (error.exitCode || error.message.includes('budget')) throw error; throw unavailable('Evidence request failed or timed out'); }
  };
  try {
    const release = await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.pathname) }));
    const manifestBytes = await get('/artifact-manifest.json');
    let manifest;
    try { manifest = JSON.parse(manifestBytes); } catch { throw Error('Malformed asset manifest'); }
    if (manifest.schema !== 'doctorcre-static-artifact.v1' || !isAppRepository(manifest.repository) || manifest.source_commit !== release.source_commit || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw Error('Manifest release identity mismatch');
    const files = new Map();
    for (const row of manifest.files) {
      if (!row || typeof row.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(row.path) || row.path.startsWith('/') || row.path.split('/').some(part => !part || part === '.' || part === '..') || files.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw Error('Malformed asset manifest row');
      files.set(row.path, row);
    }
    if (!files.has('js/ui-task-done.generated.js')) throw Error('Manifest has no task module');
    const { chromium } = await import('playwright');
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    controller.signal.addEventListener('abort', () => { void browser.close(); }, { once: true });
    if (controller.signal.aborted) throw unavailable('Evidence timeout');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const assets = [], cached = new Map();
    let routeError;
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET' || url.search) throw Error('Business network refused');
        if (url.pathname === '/__task-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic task proof</title>' });
        const path = url.pathname.slice(1), row = files.get(path);
        if (!/^js\/(?:ui-task-done|ui-shared-[A-Z0-9]+\.generated)\.js$/.test(path) || !row) throw Error('Unmanifested module refused');
        if (!cached.has(path)) {
          const data = await get('/' + path);
          if (data.length !== row.bytes || hash(data) !== row.sha256) throw Error('Manifest asset hash mismatch');
          cached.set(path, data);
          assets.push({ url: url.href, sha256: hash(data) });
        }
        await route.fulfill({ contentType: 'text/javascript', body: cached.get(path) });
      } catch (error) { routeError = error; await route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    await page.goto(`${origin}/__task-proof`, { timeout: remaining() });
    let assertions;
    try { assertions = await observeTaskReceipts(page, `${origin}/js/ui-task-done.generated.js`); } catch (error) { throw routeError || error; }
    if (routeError) throw routeError;
    if (JSON.stringify(await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.pathname) }))) !== JSON.stringify(release)) throw Error('Release changed during proof');
    return { status: 'passed', release, manifest_sha256: hash(manifestBytes), assets, assertions, requests, business_writes: 0 };
  } catch (error) {
    if (controller.signal.aborted) throw unavailable('Evidence timeout');
    throw error;
  } finally { clearTimeout(timer); await browser?.close(); }
}

async function main() {
  try {
    const args = process.argv.slice(2), url = new URL(args[1]), timeoutMs = Number(args[3]);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms' || url.href !== `${url.origin}/` || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin HTTPS_OR_LOOPBACK_ORIGIN --timeout-ms 1..30000');
    console.log(JSON.stringify(await prove({ origin: url.origin, timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'unavailable' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
