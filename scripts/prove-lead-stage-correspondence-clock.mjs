import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

import { readAppRelease, proofFetch, launchProofBrowser } from './app-release-reader.mjs';
import { workspace, detail } from '../test/leads-workspace-fixture.mjs';

export async function observeLeadClock({ origin, board, detail }) {
  const { stageReview } = await import(origin + '/js/leads-model.js');
  const { validateLeadWorkspace, validateLeadDetail } = await import(origin + '/js/leads-client.js');
  const assertions = [];
  const check = (ok, name) => { if (!ok) throw Error(name); assertions.push(name); };
  check(validateLeadWorkspace(board) === board && validateLeadDetail(detail, detail.id) === detail, 'lead-workspace.v1 fixture admitted through production parsers');
  const now = Date.parse('2026-03-10T12:00:00Z');
  const review = rows => stageReview({ ...detail, correspondence: rows }, 'engaged', now);
  const entry = (occurred_at, kind = 'email_in', connected = false, id = 'synthetic') => ({ id, kind, connected, occurred_at });
  for (const occurred_at of ['2026-02-31T12:00:00Z', '1900-02-29T12:00:00Z', '2026-03-01T12:00:00', '2026-03-01', '2026-03-01T24:00:00Z', '2026-03-01T12:60:00Z', '2026-03-01T12:00:60Z', '2026-03-01T12:00:00+24:00', '2026-03-01T12:00:00+01:60', '2026-03-01T12:00:00Z\n', null, 0]) {
    const row = entry(occurred_at);
    const result = review([row]);
    check(result.evidence.length === 0 && result.question === 'What contact has taken place?' && result.reason === null, `invalid instant requires explanation ${String(occurred_at)}`);
    for (const field of ['correspondence', 'stage_history', 'cursor']) {
      const candidate = structuredClone(detail);
      if (field === 'cursor') candidate.correspondence_page = { total: 3, has_more: true, next_cursor: { id: row.id, occurred_at } };
      else candidate[field][0].occurred_at = occurred_at;
      let refused = false;
      try { validateLeadDetail(candidate, detail.id); } catch (error) { refused = error.code === 'invalid_projection'; }
      check(refused, `detail refuses ${field} ${String(occurred_at)}`);
    }
  }
  for (const occurred_at of ['2024-02-29T12:00:00.123456Z','2000-02-29T06:00:00-06:00','0099-01-01T00:00:00Z','2026-03-10T06:00:00-06:00','2026-03-10T12:00:00Z']) {
    const candidate = structuredClone(detail);
    candidate.correspondence = [entry(occurred_at)];
    candidate.stage_history[0].occurred_at = occurred_at;
    candidate.correspondence_page = { total: 2, has_more: true, next_cursor: { id: 'synthetic', occurred_at } };
    validateLeadDetail(candidate, detail.id);
    check(review(candidate.correspondence).question === null, `valid instant usable ${occurred_at}`);
  }
  check(review([entry('2026-03-10T12:00:01Z')]).question === 'What contact has taken place?', 'future evidence excluded with manual explanation');
  for (const occurred_at of ['2026-03-10T12:00:00.000001Z', '2026-03-10T06:00:00.000000000000000000000000000001-06:00']) {
    const result = review([entry(occurred_at)]);
    check(result.evidence.length === 0 && result.question === 'What contact has taken place?' && result.reason === null, `fractional future evidence excluded ${occurred_at}`);
  }
  const fractionalRows = ['000001', '000002', '000003', '000004'].map((fraction, i) => entry(`2026-03-09T12:00:00.${fraction}Z`, 'email_in', false, String(i + 1)));
  check(review(fractionalRows).evidence.map(row => row.id).join() === '4,3,2', 'exact fractional ordering before three-entry limit');
  check(review([]).question === 'What contact has taken place?', 'missing evidence requires manual explanation');
  check(review([entry('2026-03-09T12:00:00Z', 'call')]).question !== null, 'disconnected call requires explanation');
  check(review([entry('2026-03-09T12:00:00Z', 'call', true)]).reason === 'Call completed', 'connected call usable');
  check(review([entry('2026-03-09T12:00:00Z', 'meeting')]).reason === 'Meeting held', 'meeting usable');
  const rows = ['2024-02-29T12:00:00Z', '2026-03-10T06:00:00-06:00', '2026-03-10T12:00:00Z', '2026-03-09T12:00:00Z'].map((value, i) => entry(value, 'email_in', false, String(i)));
  check(review(rows).evidence.map(row => row.id).join() === '1,2,3', 'newest first, offset equivalence and three-entry limit');
  check(stageReview({correspondence:[entry('2026-03-09T12:00:00Z', 'email_out')]}, 'outreach_active', now).reason === 'Outreach sent', 'outgoing email usable only for outreach');
  check(stageReview({correspondence:rows}, 'outreach_active', now).question === 'What outreach has started?', 'wrong contact kind requires explanation');
  return assertions;
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
        if (++receipt.requests > 35) throw unavailable('Thirty-five-request cap exceeded');
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
      const releaseBytes = await get('/app-release');
      receipt.release = await readAppRelease(origin, async () => ({ body: releaseBytes, type: 'application/json' }));
      if (receipt.release?.service !== 'doctorcre-app' || receipt.release.environment !== 'production' || !/^[a-f0-9]{40}$/.test(receipt.release.source_commit || '') || /^0+$/.test(receipt.release.source_commit)) throw unavailable('Release identity unavailable');
      const manifestBytes = await get('/artifact-manifest.json');
      const manifest = json(manifestBytes);
      if (manifest?.schema !== 'doctorcre-static-artifact.v1' || manifest.repository !== 'jbookout/doctorcre-app' || !Array.isArray(manifest.files)) throw unavailable('Manifest unavailable');
      if (manifest.source_commit !== receipt.release.source_commit) throw Error('Manifest release mismatch');
      receipt.manifest_sha256 = hash(manifestBytes);
      const rows = new Map();
      for (const row of manifest.files) {
        if (!row || typeof row.path !== 'string' || rows.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw unavailable('Malformed manifest row');
        rows.set(row.path, row);
      }
      const assets = new Map(), pending = ['/js/leads-model.js', '/js/leads-client.js'];
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
          if (dependency.d !== -1) continue;
          if (!dependency.n) throw unavailable('Unresolved asset import');
          const url = new URL(dependency.n, origin + path);
          if (url.origin !== origin || url.search || url.hash || !/^\/js\/[a-zA-Z0-9_.-]+\.m?js$/.test(url.pathname)) throw Error('Asset import outside same-origin graph');
          if (!assets.has(url.href) && !pending.includes(url.pathname)) pending.push(url.pathname);
          if (assets.size + pending.length > 32) throw unavailable('32-module graph cap exceeded');
        }
      }
      try { browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }); }
      catch { throw unavailable('Isolated browser unavailable'); }
      if (expired) { await browser.close(); throw unavailable('Total deadline exceeded'); }
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let unexpected = false;
      await context.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (request.method() === 'GET' && url === origin + '/__lead-clock-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        const body = assets.get(url);
        if (request.method() === 'GET' && body) return route.fulfill({ contentType: 'text/javascript', body });
        unexpected = true;
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(origin + '/__lead-clock-proof');
      receipt.assertions = await page.evaluate(observeLeadClock, { origin, board: workspace(), detail: detail(workspace().leads[0]) });
      if (unexpected) throw Error('Unexpected business network request');
      if (!(await get('/app-release')).equals(releaseBytes)) throw Error('Release changed during proof');
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
  } catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
