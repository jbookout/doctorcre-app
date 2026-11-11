import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function prove({ origin, timeoutMs }) {
  const base = new URL(origin);
  assert.ok(['https:', 'http:'].includes(base.protocol) && base.origin === origin && !base.username && !base.password, 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded timeout');
  const deadline = Date.now() + timeoutMs;
  const assets = new Map();
  let requests = 0, bytes = 0, browser, failure;
  const remaining = () => Math.max(1, deadline - Date.now());
  const protectedAsset = message => Object.assign(new Error(message), { exitCode: 78 });
  async function read(url, json = false) {
    assert.ok(++requests <= 64, 'request cap');
    const response = await proofFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(10000, remaining())) });
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw protectedAsset('Protected asset or sign-in required');
    assert.ok(response.ok, `asset HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/html')) throw protectedAsset('Sign-in or protected asset returned HTML');
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 16 * 1024 * 1024, 'asset byte cap');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (json) return { body, type };
    assert.match(type, /javascript/, 'JavaScript content type');
    assets.set(url, { body, sha256: createHash('sha256').update(body).digest('hex') });
    return body;
  }
  const release = await readAppRelease(base, url => read(url.href, true)).catch(error => {
    if (error.message.startsWith('asset HTTP')) throw protectedAsset('Missing release identity');
    throw error;
  });
  const assetUrl = new URL('/js/ui-calendar-panels.generated.js', base).href;
  await read(assetUrl);
  const timer = setTimeout(() => { failure = new Error('Entire proof timed out'); void browser?.close(); }, remaining());
  try {
    browser = await launchProofBrowser(chromium, { args: [...CHROMIUM_SAFETY_ARGS], headless: true, timeout: remaining() });
    const context = await browser.newContext({ timezoneId: 'America/Chicago', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    await page.clock.setFixedTime(new Date('2026-11-05T12:30:00Z'));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
      if (url.pathname === '/__calendar-proof') return route.fulfill({ contentType: 'text/html', body: '<main><div id="left"></div><div id="right"></div></main>' });
      if (!url.pathname.startsWith('/js/') || !(/\.m?js$/).test(url.pathname)) return route.abort();
      try {
        const body = assets.get(url.href)?.body ?? await read(url.href);
        await route.fulfill({ contentType: 'text/javascript', body });
      } catch (error) { failure = error; await route.abort(); }
    });
    await page.goto(new URL('/__calendar-proof', base).href, { timeout: remaining() });
    const observation = await page.evaluate(async assetUrl => {
      const { mountCalendarPanels } = await import(assetUrl);
      const panel = await mountCalendarPanels(document.querySelector('#left'), document.querySelector('#right'));
      const row = (title, start, end = '2026-11-06T08:00:00Z', extra = {}) => ({ title, start, end, ...extra });
      const items = [row('Later', '2026-11-05T08:00:00-06:00'), row('Earlier', '2026-11-05T13:00:00Z'), row('Tie', '2026-11-05T07:00:00-06:00'),
        row('Future offset', '2026-11-05T06:00:00-06:00', '2026-11-05T07:00:00-06:00'),
        row('Elapsed offset', '2026-11-05T12:00:00+02:00', '2026-11-05T13:00:00+02:00'),
        row('Chicago previous day', '2026-11-06T01:00:00Z'), row('All day', '2026-11-06', '2026-11-07', { all_day: true })];
      panel.render({ state: 'ready', items });
      const links = () => [...document.querySelectorAll('#left .calendar-panel-meeting a')];
      const titles = links().map(a => a.textContent);
      const days = links().map(a => [a.textContent, a.getAttribute('href')]);
      const allDayLabel = document.querySelector('#left').textContent.includes('Nov 6 · All day');
      panel.render({ state: 'ready', items: items.map(item => item.all_day ? item : ({ ...item, start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() })) });
      const normalized = links().map(a => a.textContent);
      panel.clear();
      return { titles, normalized, days, allDayLabel, cleared: document.querySelectorAll('.calendar-panel-meeting').length === 0 };
    }, assetUrl);
    if (failure) throw failure;
    assert.deepEqual(observation.titles, ['Future offset', 'Earlier', 'Tie', 'Later', 'All day', 'Chicago previous day']);
    assert.deepEqual(observation.normalized, observation.titles);
    assert.equal(observation.days.find(([name]) => name === 'Chicago previous day')[1], '/calendar?day=2026-11-05&d=2026-11-05');
    assert.equal(observation.days.find(([name]) => name === 'All day')[1], '/calendar?day=2026-11-06&d=2026-11-06');
    assert.equal(observation.allDayLabel, true);
    assert.equal(observation.cleared, true);
    return { ok: true, origin, release, asset_url: assetUrl, asset_sha256: assets.get(assetUrl).sha256,
      loaded_assets: [...assets].map(([url, asset]) => ({ url, sha256: asset.sha256 })), assertion_count: 6, requests };
  } catch (error) { throw failure || error; }
  finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 4, 'usage: --origin URL --timeout-ms 30000');
    assert.equal(args[0], '--origin');
    assert.equal(args[2], '--timeout-ms');
    const receipt = await prove({ origin: args[1], timeoutMs: Number(args[3]) });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, assertion_count: 0 }));
    process.exitCode = error.exitCode || 1;
  }
}
