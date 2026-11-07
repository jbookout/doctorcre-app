import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from './proof-browser.mjs';
import { init, parse } from 'es-module-lexer';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeSourceClock(assetUrl) {
  const { sourceTime, relativeAge, waitingDays } = await import(assetUrl);
  const assertions = [];
  const check = (actual, expected, name) => {
    assertions.push({ name, actual, expected, passed: actual === expected });
  };
  const now = new Date('2024-03-01T12:00:00Z');
  for (const value of ['2026-02-31T12:00:00Z', '2025-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '2026-04-31T12:00:00Z',
    '12:00:00Z', 1, 0, '2024-02-29T12:00:00', '2024-02-29', '2024-02-29T24:00:00Z', '2024-02-29T12:00:00+24:00']) {
    check(sourceTime(value, now), 'Time unavailable', `invalid absolute ${value}`);
    check(relativeAge(value, now), 'time unavailable', `invalid relative ${value}`);
    check(waitingDays(value, now), 'Waiting time unavailable', `invalid waiting ${value}`);
  }
  for (const value of [null, undefined, '']) {
    check(sourceTime(value, now, 'Not recorded'), 'Not recorded', `missing absolute ${value}`);
    check(relativeAge(value, now), 'time unavailable', `missing relative ${value}`);
    check(waitingDays(value, now), 'Waiting time unavailable', `missing waiting ${value}`);
  }
  for (const value of ['2024-02-29T12:00:00Z', '2024-02-29T06:00:00-06:00', '2024-02-29T17:30:00+05:30', '2024-02-29T12:00:00.000000Z']) {
    check(sourceTime(value, now), 'Feb 29, 6:00 AM CST', `valid absolute ${value}`);
    check(relativeAge(value, now), '1d ago', `valid relative ${value}`);
    check(waitingDays(value, now), '1 day waiting', `valid waiting ${value}`);
  }
  check(relativeAge('2024-02-29T12:00:00.123456Z', now), '23h ago', 'fractional elapsed minutes');
  check(waitingDays('2024-02-29T12:00:00.123456Z', now), '0 days waiting', 'fractional complete days');
  check(sourceTime('2000-02-29T12:00:00Z', now), 'Feb 29, 2000, 6:00 AM CST', 'prior year leap day');
  check(sourceTime('2024-07-01T12:00:00Z', now), 'Jul 1, 7:00 AM CDT', 'Chicago daylight time');
  check(relativeAge('2024-03-02T12:00:00Z', now), 'just now', 'future relative clamp');
  check(waitingDays('2024-03-02T12:00:00Z', now), '0 days waiting', 'future waiting clamp');
  return assertions;
}

export async function prove({ origin, timeoutMs }) {
  const receipt = { service: null, environment: null, source_commit: null, assets: [], assertions: [], requests: 0 };
  const controller = new AbortController();
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  let browser, timer, expired = false, bytesRead = 0;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; controller.abort(); void browser?.close(); reject(unavailable('Total deadline exceeded')); }, timeoutMs);
  });
  try {
    await Promise.race([deadline, (async () => {
      const read = async url => {
        if (++receipt.requests > 22) throw unavailable('Request cap exceeded');
        let response;
        try { response = await proofFetch(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' }); }
        catch { throw unavailable('Evidence fetch unavailable'); }
        if (!response.ok) throw unavailable('Evidence unavailable');
        const chunks = [];
        for await (const chunk of response.body) {
          bytesRead += chunk.length;
          if (bytesRead > 8 * 1024 * 1024) throw unavailable('Evidence byte cap exceeded');
          chunks.push(chunk);
        }
        return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
      };
      const release = await readAppRelease(origin, read);
      Object.assign(receipt, { service: release.service, environment: release.environment, source_commit: release.source_commit });
      const assets = new Map(), pending = [origin + '/js/email-source-line.js'];
      await init;
      while (pending.length) {
        const url = pending.shift();
        if (assets.has(url)) continue;
        if (assets.size >= 20) throw unavailable('Module cap exceeded');
        const { body, type } = await read(url);
        if (!/javascript/.test(type)) throw unavailable('Module content type unavailable');
        assets.set(url, body);
        receipt.assets.push({ url, sha256: createHash('sha256').update(body).digest('hex') });
        for (const dependency of parse(body.toString())[0]) {
          if (dependency.d === -2) continue;
          if (!dependency.n) throw unavailable('Unresolved module import');
          const child = new URL(dependency.n, url);
          if (child.origin !== origin || child.search || child.hash || child.username || child.password) throw unavailable('Import outside same-origin graph');
          if (!assets.has(child.href) && !pending.includes(child.href)) pending.push(child.href);
          if (assets.size + pending.length > 20) throw unavailable('Module cap exceeded');
        }
      }
      try { browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }); }
      catch { throw unavailable('Isolated module environment unavailable'); }
      if (expired) { await browser.close(); throw unavailable('Total deadline exceeded'); }
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let unexpected = false;
      await context.route('**/*', route => {
        const url = route.request().url();
        if (route.request().method() === 'GET' && url === origin + '/__email-clock-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        if (route.request().method() === 'GET' && assets.has(url)) return route.fulfill({ contentType: 'text/javascript', body: assets.get(url) });
        unexpected = true;
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(origin + '/__email-clock-proof');
      receipt.assertions = await page.evaluate(observeSourceClock, origin + '/js/email-source-line.js');
      if (unexpected) throw Error('Unexpected network request');
      const after = await readAppRelease(origin, read);
      if (JSON.stringify(after) !== JSON.stringify(release)) throw Error('Release changed during proof');
      if (!receipt.assertions.length || receipt.assertions.some(row => !row.passed)) throw Error('Source clock assertion failed');
    })()]);
    return { ...receipt, status: 'passed', exitCode: 0 };
  } catch (error) {
    return { ...receipt, status: error.exitCode === 78 ? 'unavailable' : 'failed', error: error.message, exitCode: error.exitCode || 1 };
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { 'cdp-url': { type: 'string' }, origin: { type: 'string' }, 'timeout-ms': { type: 'string' } } });
    const url = new URL(values.origin), timeoutMs = Number(values['timeout-ms']);
    if (url.href !== url.origin + '/' || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Use --origin ORIGIN --timeout-ms 1..30000');
    const result = await prove({ origin: url.origin, timeoutMs });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = error.exitCode || 1; }
}
