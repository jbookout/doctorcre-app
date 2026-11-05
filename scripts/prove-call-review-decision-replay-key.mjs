import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { init, parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

// Recorded through executeRegisteredTool with synthetic database rows at CARR
// 8718a35562f8e4de62cf7322881383895f69dd64, tools.js prepareCaptureCandidate.
// Both registered resolvers share these skip and already-confirmed receipts.
export function resolverFixture(candidateId, accept) {
  return accept
    ? { ok: true, candidate_id: candidateId, already: 'confirmed', ref: candidateId, note: 'already dispositioned; nothing changed' }
    : { ok: true, candidate_id: candidateId, status: 'skipped', ref: null };
}

export function checkResolverFixture(value, candidateId, accept) {
  const expected = resolverFixture(candidateId, accept);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('Incompatible resolver fixture');
  return value;
}

export async function exercise({ moduleUrl, liveUrl, fixtures }) {
  const { mountCallReview } = await import(moduleUrl);
  const { createLiveClient } = await import(liveUrl);
  const check = (value, message) => { if (!value) throw new Error(message); };
  check(typeof mountCallReview === 'function', 'Missing mountCallReview export');
  const assertions = [];
  for (const resolver of ['resolve-post-call-candidate', 'resolve-candidate']) {
    const node = document.createElement('main'); document.body.replaceChildren(node);
    const writes = [];
    const rows = [{ session_id: 'synthetic-call', call_date: '2026-10-01', applied: [], open_cards: [{ candidate_id: fixtures.candidateId, kind: resolver === 'resolve-candidate' ? 'next_step' : 'assigned_action', resolver, payload: { action: 'Synthetic task' } }] }];
    const accept = resolver === 'resolve-post-call-candidate';
    const mcp = value => Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    const client = createLiveClient({ fetchImpl: async (path, init) => {
      if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
      const { name, arguments: args } = JSON.parse(init.body).params;
      if (name === 'read-call-outcomes') return mcp({ schema_version: 'call-outcomes.v1', calls: structuredClone(rows), send: false });
      check(name === resolver, 'Expected registered resolver');
      writes.push(structuredClone(args));
      if (writes.length === 1) return new Response('Unconfirmed', { status: 409 });
      check(writes.length === 2, 'Synthetic write cap exceeded');
      rows[0].open_cards = [];
      return mcp(accept ? fixtures.confirmed : fixtures.skipped);
    } });
    const view = mountCallReview(node, { sessionId: 'synthetic-call', describe: () => 'Task', undoRefusal: () => '', client: () => client });
    const button = name => [...node.querySelectorAll('button')].find(row => row.textContent === name);
    const click = async name => {
      const target = button(name); check(target && !target.disabled, `Enabled ${name}`); target.click();
      await new Promise(resolve => setTimeout(resolve, 5));
      for (let attempt = 0; attempt < 100 && button('Refresh call review')?.disabled; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    };
    try {
      await view.refresh(); await click('Approve or fix this item'); await click(accept ? 'Approve item' : 'Skip item');
      check(writes.length === 1, 'No automatic write retry'); assertions.push(resolver + ':no-automatic-write-retry');
      check(button('Approve item')?.disabled && button('Skip item')?.disabled, 'HTTP uncertainty blocks new decisions'); assertions.push(resolver + ':http-uncertainty-blocks-new-decisions');
      await click('Check outcome');
      check(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'Exact original decision replay'); assertions.push(resolver + ':exact-original-decision-replay');
      check(node.textContent.includes('No longer pending'), 'Authoritative readback resolves item'); assertions.push(resolver + ':authoritative-resolution');
    } finally { view.dispose(); }
  }
  return assertions;
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
    async function load(path, local = false) {
      if (assets.has(path)) return;
      if (!/^\/js\/[a-zA-Z0-9_.-]+\.(?:js|mjs)$/.test(path)) throw new Error('Asset outside admitted graph: ' + path);
      const entries = manifest.files.filter(row => row.path === path.slice(1));
      if (entries.length !== 1) throw new Error('Asset missing or duplicated in manifest');
      const bytes = local ? await readFile(new URL('..' + path, import.meta.url)) : await fetchBytes(path), sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== entries[0].sha256 || bytes.length !== entries[0].bytes) throw new Error('Asset hash mismatch');
      assets.set(path, bytes); hashes[path] = sha;
      for (const entry of parse(bytes.toString())[0]) {
        if (entry.d === -2 || (local && entry.d >= 0)) continue;
        if (!entry.n) throw new Error('Unbounded module import');
        const url = new URL(entry.n, origin + path);
        if (url.origin !== origin || url.search || url.hash) throw new Error('Cross-origin asset');
        await load(url.pathname, local);
      }
    }
    await load('/js/ui-call.js');
    // Verify local adapter dependencies against the deployed manifest to keep the
    // ten-GET budget. A different checkout refuses proof rather than substituting code.
    await load('/js/live-client.js', true);
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
    const candidateId = '10000000-0000-4000-8000-000000000001';
    const fixtures = { candidateId, confirmed: checkResolverFixture(resolverFixture(candidateId, true), candidateId, true), skipped: checkResolverFixture(resolverFixture(candidateId, false), candidateId, false) };
    const assertions = await page.evaluate(exercise, { moduleUrl: origin + '/js/ui-call.js', liveUrl: origin + '/js/live-client.js', fixtures });
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
