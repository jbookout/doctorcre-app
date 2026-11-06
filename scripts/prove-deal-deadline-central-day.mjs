import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const zones = ['UTC', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo'];
export const cases = [
  ['reproduced-evening', '2026-11-06T02:00:00Z', '2026-11-05', 'Due today'],
  ['before-central-midnight', '2026-11-06T05:59:59Z', '2026-11-05', 'Due today'],
  ['after-central-midnight', '2026-11-06T06:00:00Z', '2026-11-05', '1 day overdue'],
  ['before-spring-midnight', '2026-03-08T05:59:59Z', '2026-03-08', '1 day'],
  ['after-spring-midnight', '2026-03-08T06:00:00Z', '2026-03-08', 'Due today'],
  ['before-spring-jump', '2026-03-08T07:59:59Z', '2026-03-09', '1 day'],
  ['after-spring-jump', '2026-03-08T08:00:00Z', '2026-03-09', '1 day'],
  ['after-spring-short-day', '2026-03-09T05:00:00Z', '2026-03-08', '1 day overdue'],
  ['before-fall-midnight', '2026-11-01T04:59:59Z', '2026-11-01', '1 day'],
  ['after-fall-midnight', '2026-11-01T05:00:00Z', '2026-11-01', 'Due today'],
  ['before-fall-repeat', '2026-11-01T06:59:59Z', '2026-11-02', '1 day'],
  ['after-fall-repeat', '2026-11-01T07:00:00Z', '2026-11-02', '1 day'],
  ['after-fall-long-day', '2026-11-02T06:00:00Z', '2026-11-01', '1 day overdue'],
];

export function options(args) {
  assert.equal(args.length, 4, 'usage: --origin URL --timeout-ms 30000');
  assert.equal(args[0], '--origin'); assert.equal(args[2], '--timeout-ms');
  const url = new URL(args[1]);
  assert.ok(url.origin === args[1] && !url.username && !url.password, 'origin only');
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'HTTPS or loopback only');
  const timeoutMs = Number(args[3]);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'deadline at most 30000 ms');
  return { origin: url.origin, timeoutMs };
}

export async function exercise(page, assetUrl) {
  return page.evaluate(async ({ assetUrl, cases }) => {
    const view = await import(assetUrl);
    const assertions = [];
    const check = (name, passed) => { if (!passed) throw Error(name); assertions.push({ name, passed }); };
    for (const [name, instant, day, expected] of cases) {
      const now = Date.parse(instant);
      check(`${name}:countdown`, view.countdown({ day, deadline: true }, now).text === expected);
      const detail = { deal: { phase: 'Legal', phase_started_on: { legal: '2026-10-03' } }, critical_dates: [
        { id: 'synthetic', kind: 'loi_expiry', due_on: day, source: 'Synthetic recorded clause' },
      ] };
      const original = JSON.stringify(detail);
      document.body.innerHTML = view.renderCriticalDates(detail, now);
      check(`${name}:render`, document.querySelector('[data-countdown]').textContent === expected);
      document.querySelector('[data-countdown]').textContent = 'stale';
      view.updateCountdowns(document, now);
      check(`${name}:update`, document.querySelector('[data-countdown]').textContent === expected);
      const state = document.querySelector('.critical-date').dataset.state;
      view.updateCountdowns(document, now);
      check(`${name}:idempotent`, document.querySelector('[data-countdown]').textContent === expected && document.querySelector('.critical-date').dataset.state === state);
      check(`${name}:recorded-data`, JSON.stringify(detail) === original && view.dealTimeline(detail, now).phases.find(p => p.slug === 'legal').day === '2026-10-03');
      const held = { deal: detail.deal, entries: [{ id: 'hold', source: 'hold', holdUntil: day, when: '2026-01-01', summary: 'Synthetic hold' }] };
      check(`${name}:hold`, view.renderDealUpdates(held, now).includes('Synthetic hold') === (expected === '1 day'));
    }
    const now = Date.parse('2026-11-06T02:00:00Z');
    for (const [name, date, expected] of [
      ['unknown', {day:'2026-02-30', status:'cleared'}, '—'],
      ['cleared', {day:'2026-11-04', status:'cleared', deadline:true}, 'Cleared'],
      ['passed', {day:'2026-11-06', status:'passed', deadline:true}, 'Passed'],
      ['soon', {day:'2026-11-12', deadline:true}, '7 days'],
      ['upcoming', {day:'2026-11-13', deadline:true}, '8 days'],
    ]) check(`disposition:${name}`, view.countdown(date, now).text === expected);
    return assertions;
  }, { assetUrl, cases });
}

export async function prove({ origin, timeoutMs }) {
  options(['--origin', origin, '--timeout-ms', String(timeoutMs)]);
  let browser, timer, requests = 0, bytes = 0;
  const assets = new Map(), assertions = [];
  const controller = new AbortController();
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  async function read(url) {
    assert.equal(new URL(url).origin, origin, 'same-origin only');
    assert.ok(++requests <= 22, 'request cap');
    let response;
    try { response = await proofFetch(url, { signal: controller.signal, redirect: 'manual', cache: 'no-store' }); }
    catch { throw unavailable('Release or asset unavailable'); }
    if (!response.ok) throw unavailable(`HTTP ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 8 * 1024 * 1024, 'asset byte cap');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  }
  async function load(url) {
    if (assets.has(url)) return;
    assert.ok(assets.size < 20, 'asset fetch cap');
    const asset = await read(url);
    if (!/javascript/.test(asset.type)) throw unavailable('JavaScript asset unavailable');
    assets.set(url, { ...asset, sha256: createHash('sha256').update(asset.body).digest('hex') });
    const [imports] = parse(asset.body.toString());
    for (const item of imports) {
      if (item.d !== -1) continue;
      assert.ok(item.n && /^[./]/.test(item.n), 'only static same-origin dependency specifiers');
      const dependency = new URL(item.n, url);
      assert.equal(dependency.origin, origin, 'dependency origin');
      await load(dependency.href);
    }
  }
  const run = async () => {
    const release = await readAppRelease(origin, read);
    await init;
    const assetUrl = new URL('/js/deal-timeline.js', origin).href;
    await load(assetUrl);
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() });
    if (controller.signal.aborted) { await browser.close(); throw unavailable('Proof timeout'); }
    for (const timezoneId of zones) {
      const context = await browser.newContext({ timezoneId, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => {
          const request = route.request(), url = request.url();
          if (request.method() !== 'GET') return route.abort();
          if (url === `${origin}/__deadline-proof`) return route.fulfill({contentType:'text/html',body:'<body></body>'});
          const asset = assets.get(url);
          return asset ? route.fulfill({ contentType: 'text/javascript', body: asset.body }) : route.abort();
        });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date('2026-11-06T02:00:00Z'));
        await page.goto(`${origin}/__deadline-proof`, { timeout: remaining() });
        assertions.push(...(await exercise(page, assetUrl)).map(result => ({ timezoneId, ...result })));
      } finally { await context.close(); }
    }
    const after = await readAppRelease(origin, read);
    assert.deepEqual(after, release, 'Release changed during proof');
    return { ok: true, origin, release, assets: [...assets].map(([url, asset]) => ({url, sha256:asset.sha256})), assertions, requests };
  };
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('Proof timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    if (controller.signal.aborted || error.name === 'TimeoutError') throw unavailable('Proof timeout');
    throw error;
  } finally { clearTimeout(timer); controller.abort(); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await prove(options(process.argv.slice(2))))); }
  catch (error) { console.log(JSON.stringify({ok:false,error:error.message})); process.exitCode = error.exitCode || 1; }
}
