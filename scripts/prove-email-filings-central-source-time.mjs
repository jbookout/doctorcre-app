import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { proofFetch, readAppRelease, launchProofBrowser } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observeFilings() {
  const { createLiveClient } = await import('/js/live-client.js');
  const { mountEmailFilings } = await import('/js/email-filings.js');
  const times = ['2026-11-06T00:30:00Z', '2026-03-08T07:59:00Z', '2026-03-08T08:00:00Z',
    '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', '2025-10-01T13:00:00Z',
    '2024-02-29T17:30:00+05:30', '2026-02-31T12:00:00Z', null, '', 'invalid'];
  const deal = '20000000-0000-4000-8000-000000000001';
  const filings = times.map((occurred_at, i) => ({ event_id: `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    deal, current_deal_id: deal, activity_id: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    activity_version: null, recorded_at: '2026-11-06T12:00:00Z', summary: '', subject: `Synthetic filing ${i}`, sender_name: 'Synthetic Sender', occurred_at }));
  let reads = 0;
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    const rpc = JSON.parse(init.body);
    if (path !== '/mcp' || rpc.params.name !== 'list-email-thread-filings' || Object.keys(rpc.params.arguments).length) throw Error('Unexpected fixture call');
    reads++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ filings }) }] } }), { headers: { 'content-type': 'application/json' } });
  } });
  const host = document.createElement('section'); document.body.append(host);
  const panel = mountEmailFilings({ container: host, client });
  try {
    await panel.refresh();
    return { labels: [...host.querySelectorAll('article > p:first-of-type')].map(node => node.textContent),
      subject: host.querySelector('h3')?.textContent, links: host.querySelectorAll(`a[href="/deals?deal=${deal}"]`).length,
      undo: host.querySelectorAll('[data-filing-undo]').length, reads };
  } finally { panel.dispose(); host.remove(); }
}

export async function prove({ origin, timeoutMs = 30000, engine = chromium }) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.origin === origin && !base.username && !base.password, 'origin only');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, 'bounded timeout');
  const unavailable = message => Object.assign(Error(message), { exitCode: 78 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  const assets = new Map();
  let requests = 0, bytes = 0, browser, routeFailure;
  const read = async url => {
    assert.ok(++requests <= 64, 'request cap');
    const response = await proofFetch(url, { signal: controller.signal });
    if (!response.ok) throw unavailable(`Asset HTTP ${response.status}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap'); chunks.push(chunk);
    }
    return { type: response.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  };
  try {
    const before = await readAppRelease(base, url => read(url.href));
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: controller.signal });
    const observations = [];
    for (const timezoneId of ['UTC', 'America/Los_Angeles', 'America/Chicago']) {
      const context = await browser.newContext({ timezoneId, serviceWorkers: 'block' });
      try {
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
          if (url.pathname === '/__filings-proof') return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
          if (!/^\/js\/.*\.m?js$/.test(url.pathname)) return route.abort();
          try {
            if (!assets.has(url.href)) assets.set(url.href, await read(url.href));
            const asset = assets.get(url.href);
            assert.match(asset.type, /javascript/);
            await route.fulfill({ contentType: 'text/javascript', body: asset.body });
          } catch (error) { routeFailure = error; await route.abort(); }
        });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date('2026-11-06T12:00:00Z'));
        await page.goto(new URL('/__filings-proof', base).href);
        const observation = await page.evaluate(observeFilings);
        if (routeFailure) throw routeFailure;
        assert.deepEqual(observation.labels, ['Nov 5, 6:30 PM CST', 'Mar 8, 1:59 AM CST', 'Mar 8, 3:00 AM CDT',
          'Nov 1, 1:30 AM CDT', 'Nov 1, 1:30 AM CST', 'Oct 1, 2025, 8:00 AM CDT', 'Feb 29, 2024, 6:00 AM CST',
          ...Array(4).fill('Time unavailable')].map(time => `From Synthetic Sender · ${time}`));
        assert.equal(observation.links, 11); assert.equal(observation.undo, 11); assert.equal(observation.reads, 1);
        observations.push({ timezone: timezoneId, assertions_passed: true });
      } finally { await context.close().catch(error => { if (!controller.signal.aborted) throw error; }); }
    }
    const after = await readAppRelease(base, url => read(url.href));
    assert.deepEqual(after, before, 'unchanged app release identity');
    return { ok: true, deployed_asset_fixture: { release: before, observations, requests, bytes },
      natural_authenticated_observation: { status: 'insufficient_evidence', reason: 'Synthetic asset observation only; authorized signed-in post-deploy proof required' },
      production_acceptance: 'insufficient_evidence' };
  } catch (error) { throw controller.signal.reason || error; }
  finally { clearTimeout(timer); await browser?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.deepEqual([process.argv[2], process.argv[4]], ['--origin', '--timeout-ms']);
    console.log(JSON.stringify(await prove({ origin: process.argv[3], timeoutMs: Number(process.argv[5]) })));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, production_acceptance: 'insufficient_evidence' })); process.exitCode = error.exitCode || 1; }
}
