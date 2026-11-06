import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function observeDelivery(model) {
  const { deliveryPhrases, notificationCards, validFeedPayload, acknowledgeArgs } = model;
  const assertions = [];
  const check = (condition, name) => { if (!condition) throw Error(name); assertions.push(name); };
  const row = { id: '11111111-1111-4111-8111-111111111103', severity: 'action_required',
    reason: 'Demo counterparty asked for a fictional revised proposal', subject_type: 'deal', subject_ref: 'd14',
    deep_link: '/signals/11111111-1111-4111-8111-111111111103', created_at: '2026-01-13T18:20:00Z',
    read_at: '2026-01-13T19:00:00Z', quiet_suppressed: false,
    delivery: [{ channel: 'in_app', state: 'delivered' }, { channel: 'device', state: 'delivered' }] };
  const feed = { ok: true, unread_count: 0, quiet_now: false, notifications: [row] };
  check(validFeedPayload(feed), 'notification-feed-parser');
  check(row.delivery.every(entry => ['in_app', 'device'].includes(entry.channel)
    && ['pending', 'delivered', 'suppressed_quiet_hours', 'failed'].includes(entry.state)), 'producer-delivery-contract');
  const cases = [
    ['null', null], ['missing', undefined], ['object', {}], ['string', 'unknown'], ['invalid-row', [null]],
    ['missing-channel', [{}]], ['null-device', [{ channel: 'device', state: null }]],
    ['missing-device-state', [{ channel: 'device' }]], ['invalid-device-state', [{ channel: 'device', state: 1 }]],
    ['object-device-state', [{ channel: 'device', state: {} }]],
    ['unknown-device-state', [{ channel: 'device', state: 'queued' }]],
    ['prototype-state', [{ channel: 'device', state: 'constructor' }]],
    ['unknown-channel', [{ channel: 'other', state: 'delivered' }]],
    ['unknown-in-app-state', [{ channel: 'in_app', state: 'future' }]],
  ];
  for (const [name, delivery] of cases) {
    const card = notificationCards({ ...feed, notifications: [{ ...row, delivery, quiet_suppressed: true }] })[0];
    check(card.delivery.some(entry => entry.phrase === 'Delivery status unavailable')
      && !card.delivery.some(entry => entry.phrase === 'device push is off for you'), `${name}-unavailable`);
    check(card.id === row.id && card.read && card.quietSuppressed
      && acknowledgeArgs(card.id).args.notification_id === row.id, `${name}-identity-and-quiet-marker`);
  }
  for (const [name, delivery] of [['empty', []], ['in-app-only', [{ channel: 'in_app', state: 'delivered' }]]]) {
    check(deliveryPhrases(delivery).some(entry => entry.phrase === 'device push is off for you'), `${name}-confirmed-absence`);
  }
  for (const [state, phrase] of Object.entries({ pending: 'in-app, waiting', delivered: 'delivered', suppressed_quiet_hours: 'device push held by your quiet hours', failed: 'device push failed' })) {
    const card = notificationCards({ ...feed, notifications: [{ ...row, delivery: [{ channel: 'in_app', state: 'delivered' }, { channel: 'device', state }] }] })[0];
    check(card.delivery[0].phrase === 'delivered' && card.delivery[1].phrase === phrase && !card.quietSuppressed, `${state}-known-device`);
  }
  const mixed = deliveryPhrases([{ channel: 'in_app', state: 'delivered' }, { channel: 'device', state: null }]);
  check(mixed[0].phrase === 'delivered' && mixed[1].phrase === 'Delivery status unavailable', 'readable-in-app-preserved');
  return { assertions };
}

export async function observeOnPage(page, assetUrl) {
  return page.evaluate(`(async () => (${observeDelivery.toString()})(await import(${JSON.stringify(assetUrl)})))()`);
}

export async function prove({ origin, timeoutMs }) {
  const { chromium } = await import('playwright');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  let browser;
  try { browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }); }
  catch { throw Object.assign(Error('Isolated browser unavailable'), { exitCode: 78 }); }
  let timedOut = false;
  const shutdown = setTimeout(() => { timedOut = true; void browser.close(); }, Math.max(1, deadline - Date.now() - 100));
  const assets = [];
  let requests = 0, bytes = 0, moduleRequests = 0, routeError;
  const refusal = message => Object.assign(Error(message), { exitCode: 78 });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const get = async url => {
      if (++requests > 22 || Date.now() >= deadline) throw refusal('Proof request budget exhausted');
      let response;
      try { response = await context.request.get(url, { timeout: remaining(), maxRedirects: 0 }); }
      catch { throw refusal('Asset or identity unavailable'); }
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw refusal('Protected asset or sign-in required');
      const body = await response.body();
      bytes += body.length;
      if (bytes > 10 * 1024 * 1024) throw refusal('Proof byte budget exhausted');
      return { response, body };
    };
    const read = async url => {
      const { response, body } = await get(String(url));
      if (response.status() !== 200) throw refusal('Unavailable identity');
      return { body, type: response.headers()['content-type'] || '' };
    };
    const identity = await readAppRelease(origin, read);
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET' || url.origin !== origin) throw Error('Business network request refused');
        if (url.pathname === '/__notification-delivery-proof') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic notification delivery proof</title>' });
        if (!/^\/js\/[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(url.pathname) || url.search) throw Error('Business network request refused');
        if (++moduleRequests > 20) throw refusal('Asset budget exhausted');
        const { response, body } = await get(url.href);
        if (response.status() !== 200 || !/javascript/.test(response.headers()['content-type'] || '')) throw refusal('Protected or missing JavaScript asset');
        assets.push({ url: url.href, sha256: createHash('sha256').update(body).digest('hex') });
        await route.fulfill({ contentType: 'text/javascript', body });
      } catch (error) { routeError = error; await route.abort(); }
    });
    await page.goto(`${origin}/__notification-delivery-proof`, { timeout: remaining() });
    let observation;
    try { observation = await observeOnPage(page, `${origin}/js/notifications-model.js`); }
    catch (error) { throw routeError || error; }
    if (routeError) throw routeError;
    const final = await readAppRelease(origin, read);
    if (JSON.stringify(final) !== JSON.stringify(identity)) throw Error('Release changed during proof');
    return { schema: 'notification-device-delivery-unknown-proof.v1', status: 'passed', origin, release: identity, assets, requests, ...observation, limitation: 'Deployed synthetic resilience only; natural private-data coverage unproven.' };
  } catch (error) {
    if (timedOut) throw refusal('Whole-run timeout');
    throw error;
  } finally { clearTimeout(shutdown); await browser.close(); }
}

async function main() {
  let timer;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error('Use --origin URL --timeout-ms MILLISECONDS');
    const url = new URL(args[1]), timeoutMs = Number(args[3]);
    if (url.href !== `${url.origin}/` || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw Error('Expected HTTPS origin or loopback fixture');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw Error('Invalid timeout');
    timer = setTimeout(() => { console.log(JSON.stringify({ status: 'unproven', error: 'Whole-run timeout' })); process.exit(78); }, timeoutMs);
    console.log(JSON.stringify(await prove({ origin: url.origin, timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: error.exitCode === 78 ? 'unproven' : 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
