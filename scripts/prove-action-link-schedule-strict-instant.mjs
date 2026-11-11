import { isAppRepository } from '../js/repository-identity.mjs';
import { launchProofBrowser, readAppRelease, proofFetch } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeActionLink(assetUrl) {
  const { mountActionLink } = await import(assetUrl);
  const assertions = [];
  const check = (ok, name) => { if (!ok) throw Error(name); assertions.push(name); };
  const until = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('View did not settle');
  };
  const id = '11111111-1111-4111-8111-111111111111', ref = 'al1_synthetic';
  const payload = schedule => ({ kind: 'payload', payload: { schema_version: 'action-link-resolve.v1', ref, card: {
    kind: 'lead_draft', id, lead_id: id, state: 'pending_approval', revision: 3, subject: 'Synthetic schedule', body: 'Synthetic message',
    scheduled_for: schedule, time_zone: 'America/Chicago',
    actions: [{ action: 'approve', verb: 'approve-lead-draft', args: { draft_id: id, revision: 3 } }],
  } } });
  const host = document.body.appendChild(document.createElement('div'));
  let mounted;
  const mount = request => { mounted = mountActionLink(host, { ref, request }); };
  try {
    for (const value of ['2026-02-31T10:00:00Z', '1900-02-29T10:00:00Z', '2025-02-29T10:00:00Z', '2026-04-31T10:00:00Z', '2026-00-01T10:00:00Z', '2026-13-01T10:00:00Z', '2026-01-00T10:00:00Z', '2026-01-01T10:00:00', '2026-01-01', '2026-01-01T24:00:00Z', '2026-01-01T10:60:00Z', '2026-01-01T10:00:60Z', '2026-01-01T10:00:00+24:00', '2026-01-01T10:00:00+01:60', '2026-01-01T10:00:00Z\n', '', Infinity, NaN, 0]) {
      const calls = [];
      mount(async name => { calls.push(name); return payload(value); });
      await until(() => !host.textContent.includes('Opening draft'));
      check(host.textContent.includes('could not be opened') && !host.querySelector('time'), `invalid schedule unavailable ${String(value)}`);
      check(host.querySelector('button')?.textContent === 'Reload draft' && calls.join() === 'resolve-action-link', `invalid schedule has only manual reload ${String(value)}`);
      mounted.dispose();
    }
    for (const value of [null, '2024-02-29T10:00:00Z', '2000-02-29T10:00:00.123456Z', '2026-11-04T15:00:00+00:00', '2026-11-04T09:00:00-06:00', '2026-01-01T00:15:00+05:30', '0099-01-01T00:00:00Z']) {
      const calls = [];
      mount(async name => { calls.push(name); return payload(value); });
      await until(() => !host.textContent.includes('Opening draft'));
      check(host.querySelector('button')?.textContent === 'Approve draft', `valid schedule ready ${value}`);
      const time = host.querySelector('time');
      check(value === null ? !time : time?.getAttribute('datetime') === value && time.textContent === new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }).format(new Date(value)), `independent display zone ${value}`);
      check(calls.join() === 'resolve-action-link', `no automatic approval ${value}`);
      mounted.dispose();
      check(host.textContent === '', 'ready disposal clears draft');
    }
    let reads = 0;
    let finishWrite;
    const writes = [];
    mount(async (name, args, options) => {
      check(options.timeoutMs === 10000 && !options.signal.aborted, 'bounded request');
      if (name === 'resolve-action-link') return payload(++reads === 1 ? '2026-02-31T10:00:00Z' : '2024-02-29T10:00:00Z');
      writes.push(args);
      return writes.length === 1 ? new Promise(resolve => { finishWrite = resolve; }) : { kind: 'payload', payload: { ok: true, draft_id: id, revision: 3, approved: true, sent: false } };
    });
    await until(() => host.querySelector('button')?.textContent === 'Reload draft');
    host.querySelector('button').click();
    await until(() => host.querySelector('button')?.textContent === 'Approve draft');
    check(reads === 2 && writes.length === 0, 'reload recovers without approval');
    host.querySelector('button').click();
    host.querySelector('button').click();
    await until(() => host.querySelector('button')?.disabled);
    check(writes.length === 1 && host.querySelector('button').textContent === 'Approving…', 'pending approval is single flight');
    finishWrite({ kind: 'unconfirmed' });
    await until(() => host.querySelector('button')?.textContent === 'Retry approval');
    check(!host.textContent.includes('Draft approved'), 'unknown receipt stays pending');
    host.querySelector('button').click();
    await until(() => host.textContent.includes('Draft approved'));
    check(writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]) && /^[0-9a-f-]{36}$/.test(writes[0].idempotency_key), 'retry uses exact key and revision');
    check(host.textContent.includes('Nothing was sent'), 'approval confirms no send');
    mounted.dispose();
    for (const stage of ['read', 'approval']) {
      mount(async name => name === 'resolve-action-link' && stage === 'approval' ? payload(null) : { kind: 'authorization', status: 403 });
      if (stage === 'approval') {
        await until(() => host.querySelector('button'));
        host.querySelector('button').click();
      }
      await until(() => host.textContent.includes('Sign in to open'));
      check(!host.querySelector('button, time') && !host.textContent.includes('Synthetic message'), `authorization retires ${stage}`);
      mounted.dispose();
    }
    let finish, signal;
    mount((_name, _args, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
    await until(() => finish);
    mounted.dispose();
    finish(payload('2024-02-29T10:00:00Z'));
    await new Promise(resolve => setTimeout(resolve, 30));
    check(signal.aborted && host.textContent === '', 'disposal ignores late read');
    return assertions;
  } finally { mounted?.dispose(); host.remove(); }
}

export async function prove({ origin, timeoutMs }) {
  const receipt = { release: null, assets: [], assertions: [], requests: 0 };
  const controller = new AbortController();
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let browser, timer, expired = false, bytesRead = 0;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; controller.abort(); void browser?.close(); reject(unavailable('Total deadline exceeded')); }, timeoutMs);
  });
  try {
    await Promise.race([deadline, (async () => {
      const get = async path => {
        if (++receipt.requests > 10) throw unavailable('Ten-request cap exceeded');
        let response;
        try { response = await proofFetch(origin + path, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
        catch { throw unavailable('Evidence fetch unavailable'); }
        if (!response.ok) throw unavailable(`Evidence unavailable ${path}`);
        const chunks = [];
        for await (const chunk of response.body) {
          bytesRead += chunk.length;
          if (bytesRead > 8 * 1024 * 1024) { controller.abort(); throw unavailable('Evidence byte cap exceeded'); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      };
      const json = bytes => { try { return JSON.parse(bytes); } catch { throw unavailable('Malformed evidence JSON'); } };
      receipt.release = await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.pathname) }));
      const manifestBytes = await get('/artifact-manifest.json');
      const manifest = json(manifestBytes);
      if (manifest?.schema !== 'doctorcre-static-artifact.v1' || !isAppRepository(manifest.repository) || !Array.isArray(manifest.files)) throw unavailable('Manifest unavailable');
      if (manifest.source_commit !== receipt.release.source_commit) throw Error('Manifest release mismatch');
      receipt.manifest_sha256 = hash(manifestBytes);
      const rows = new Map();
      for (const row of manifest.files) {
        if (!row || typeof row.path !== 'string' || rows.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw unavailable('Malformed manifest row');
        rows.set(row.path, row);
      }
      const assets = new Map(), pending = ['/js/ui-action.generated.js'];
      await init;
      while (pending.length) {
        const path = pending.shift();
        if (assets.has(origin + path)) continue;
        const row = rows.get(path.slice(1));
        if (!row) throw unavailable('Required asset absent from manifest');
        const bytes = await get(path);
        if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error('Manifest asset mismatch');
        assets.set(origin + path, bytes);
        receipt.assets.push({ url: origin + path, sha256: hash(bytes) });
        for (const dependency of parse(bytes.toString())[0]) {
          if (dependency.d === -2) continue;
          if (!dependency.n) throw unavailable('Unresolved asset import');
          const url = new URL(dependency.n, origin + path);
          if (url.origin !== origin || url.search || url.hash || !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname)) throw Error('Asset import outside same-origin graph');
          if (!assets.has(url.href) && !pending.includes(url.pathname)) pending.push(url.pathname);
          if (assets.size + pending.length > 7) throw unavailable('Ten-request graph cap exceeded');
        }
      }
      browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs });
      if (expired) { await browser.close(); throw unavailable('Total deadline exceeded'); }
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let unexpected = false;
      await context.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (request.method() === 'GET' && url === origin + '/__schedule-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        const body = assets.get(url);
        if (request.method() === 'GET' && body) return route.fulfill({ contentType: 'text/javascript', body });
        unexpected = true;
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(origin + '/__schedule-proof');
      receipt.assertions = await page.evaluate(observeActionLink, origin + '/js/ui-action.generated.js');
      if (unexpected) throw Error('Unexpected business network request');
      if (JSON.stringify(await readAppRelease(origin, async url => ({ type: 'application/json', body: await get(url.pathname) }))) !== JSON.stringify(receipt.release)) throw Error('Release changed during proof');
    })()]);
    return { ...receipt, status: 'passed', exitCode: 0 };
  } catch (error) {
    return { ...receipt, status: error.exitCode === 78 ? 'unavailable' : 'failed', error: error.message, exitCode: error.exitCode || 1 };
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    const url = new URL(values.origin), timeoutMs = Number(values['timeout-ms']);
    if (url.href !== url.origin + '/' || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin ORIGIN --timeout-ms 1..30000');
    const result = await prove({ origin: url.origin, timeoutMs });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = error.exitCode || 1; }
}
