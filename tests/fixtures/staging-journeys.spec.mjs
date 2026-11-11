import { test } from '@playwright/test';
import { readPacketPresentation } from '../../src/ui/packet-facts.ts';
import recordedPacket from '../../test/fixtures/packet-parity/share.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { temporaryDirectory } from '../../scripts/temp-directory.mjs';
import { rm } from 'node:fs/promises';
import { startWorkerFixture } from '../../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../../scripts/fixture-app-assets.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detail } from '../../test/fixtures/tour-day.synthetic.mjs';
import { leaseRadarFixture } from '../../js/lease-radar-fixture.js';
import { leaseDetails, tourDay, itinerary, shareLifecycle } from '../staging/journey-flows.mjs';

export const fixture = {
  lease: { id: 'aa000000-0000-4000-8000-000000000001', client_id: 'aa000000-0000-4000-8000-000000000002', client_name: 'Synthetic staging QA lease' },
  tour: { id: detail.id, name: 'Synthetic staging QA accepted tour', route_id: detail.routes[0].id,
    property_ids: detail.stops.map(stop => stop.property_id), stop_ids: detail.stops.map(stop => stop.id),
    property_names: recordedPacket.stops.map(stop => stop.name), projection_id: 'aa000000-0000-4000-8000-000000000003',
    unrelated_property_id: 'aa000000-0000-4000-8000-000000000004' },
};

export async function localFixture(browser, {denyShortlist = false} = {}) {
  let active = false, exchanged = false, tokenDigest = '', denied = false;
  const tour = structuredClone(detail);
  Object.assign(tour, { name: fixture.tour.name, route_version_id: fixture.tour.route_id, route_version_state: 'accepted',
    accepted_route_version: 1, projection_id: fixture.tour.projection_id, projection_status: 'approved', share_grants: [] });
  tour.stops.forEach(stop => { stop.locked_appointment = false; });
  tour.routes[0].acceptance_digest = 'sha256:' + 'a'.repeat(64);
  const lease = leaseRadarFixture();
  Object.assign(lease.leases[0], fixture.lease);
  const packet = structuredClone(recordedPacket);
  const presentation = readPacketPresentation(packet);
  assert.ok(presentation, 'recorded share packet must satisfy the production presentation parser');
  assert.equal(presentation.stops.length, tour.stops.length);
  tour.stops.forEach((stop, index) => {
    stop.property_name = presentation.stops[index].name;
    stop.property_address = presentation.stops[index].address;
  });
  const projectionRef = 'projection:public:abcdefghijklmnop';
  const assets = await appAssetSnapshot();
  const server = await startWorkerFixture({ assets, env:{ APP_ENV:'staging', CARR:{fetch:async req => {
    const url = new URL(req.url);
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    const json = (body, status = 200) => Response.json(body,{status});
    if (url.pathname === '/api/share/shortlist' && denyShortlist) { denied = true; return json({error:'not_found'},404); }
    if (url.pathname === '/api/tours/detail') return json({ data: tour, csrf_token: 'synthetic' });
    if (url.pathname === '/api/tours/library') return json({ data: { tours: [{ id: tour.id, name: tour.name, status: 'active' }] }, csrf_token: 'synthetic' });
    if (url.pathname === '/api/tours/share/issue') {
      tokenDigest = JSON.parse(body).token_digest;
      active = true; tour.share_grant_id = 'aa000000-0000-4000-8000-000000000005';
      return json({ data: { ok: true, share_grant_id: tour.share_grant_id, status: 'active' } });
    }
    if (url.pathname === '/api/tours/share/revoke') { active = false; return json({ data: { ok: true } }); }
    if (url.pathname === '/api/share/exchange') {
      const { token } = JSON.parse(body);
      if (!active || 'sha256:' + createHash('sha256').update(token).digest('hex') !== tokenDigest) return json({ error: 'not_found' }, 404);
      exchanged = true; return json({ ok: true });
    }
    if (url.pathname.startsWith('/api/share/')) {
      if (!active || !exchanged) return json({ error: 'not_found' }, 404);
      if (url.pathname === '/api/share/report') return json({ data: packet });
      if (url.pathname === '/api/share/map') return json({ error: 'not_found' }, 404);
      if (url.pathname === '/api/share/feedback') return json({ data: { projection_ref: projectionRef,
        permission_scopes: ['shortlist'], items: packet.stops.map(stop => ({ property_ref: stop.property_ref })) } });
      if (url.pathname === '/api/share/shortlist') {
        if (req.headers.get('origin') !== `http://${req.headers.get('host')}` || req.headers.get('sec-fetch-site') !== 'same-origin') return json({ error: 'forbidden' }, 403);
        const input = JSON.parse(body);
        return packet.stops.some(stop => stop.property_ref === input.property_ref) ? json({ data: { saved: true } }) : json({ error: 'not_found' }, 404);
      }
    }
    if (url.pathname === '/api/v1/business/leases') return json(lease);
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
    if (url.pathname === '/mcp') return json({ result: { content: [{ type: 'text', text: '{"ok":true,"deals":[],"items":[],"notifications":[],"state":"unavailable"}' }] } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return json({});
    return new Response(null);
  }}} });
  const origin = server.origin;
  const context = await browser.newContext({ baseURL: origin });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let contextClosed = false, closing;
  context.once('close', () => { contextClosed = true; });
  const close = () => closing ??= (async () => {
    try {
      if (!contextClosed) await context.close();
    } catch (error) {
      if (!/(?:^|: )Target page, context or browser has been closed(?:\n|$)/.test(error.message)) throw error;
    } finally {
      await server.close();
    }
  })();
  return { page: await context.newPage(), server, get denied(){return denied;}, close };
}

for (const [name, flow] of Object.entries({ leaseDetails, tourDay, itinerary, shareLifecycle })) {
  test(`staging acceptance logic against synthetic HTTP fixtures: ${name}`, async ({ browser }) => {
    const local = await localFixture(browser);
    try { await flow(local.page, fixture); } finally { await local.close(); }
  });
}

test('Share acceptance rejects a server denying every shortlist write', async ({ browser }) => {
  const local = await localFixture(browser,{denyShortlist:true});
  try {
    await assert.rejects(shareLifecycle(local.page, fixture), error => {
      assert.equal(error.message.includes('allowed-property shortlist write succeeds'), true);
      return true;
    });
    assert.equal(local.denied, true, 'the HTTP server must receive the shortlist write');
  } finally {
    await local.close();
  }
});

test('Share lifecycle waits for the shell to place its submit control', async ({ browser }) => {
  const local = await localFixture(browser);
  let releaseShell;
  const shellReady = new Promise(resolve => { releaseShell = resolve; });
  await local.page.route('**/js/app-shell.js', async route => { await shellReady; await route.continue(); });
  await local.page.exposeFunction('releaseShareShell', releaseShell);
  await local.page.addInitScript(() => {
    document.addEventListener('input', event => {
      if (event.target.id === 'receipt-digest') setTimeout(() => { void window.releaseShareShell(); }, 200);
    }, { once: true });
  });
  const locator = local.page.locator.bind(local.page);
  local.page.locator = selector => {
    const control = locator(selector);
    if (selector === '#share-form button[type="submit"]') {
      const click = control.click.bind(control);
      control.click = options => click({ ...options, delay: 400 });
    }
    return control;
  };
  local.page.context().setDefaultTimeout(3000);
  try { await shareLifecycle(local.page, fixture); }
  finally { releaseShell(); await local.close(); }
});

test('Fixture cleanup releases its server when context disposal fails', async ({ browser }) => {
  const local = await localFixture(browser);
  const context = local.page.context();
  const close = context.close.bind(context);
  const failure = new Error('synthetic context disposal failure');
  context.close = async () => { throw failure; };
  try {
    await assert.rejects(local.close(), failure);
    await assert.rejects(fetch(local.server.origin), TypeError, 'server disposal must survive context disposal failure');
  } finally {
    context.close = close;
    await close();
    await local.server.close();
  }
});

test('Fixture cleanup tolerates an already closed context and repeated disposal', async ({ browser }) => {
  const local = await localFixture(browser);
  await local.page.context().close();
  await Promise.all([local.close(), local.close()]);
  await assert.rejects(fetch(local.server.origin), TypeError);
});

for (const connected of [true, false]) {
  test(`Fixture cleanup preserves HAR failure after context closes with browser connected=${connected}`, async ({ browser }, testInfo) => {
    const blocker = testInfo.outputPath('har-blocker');
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(blocker, 'This file prevents creating the HAR directory.');
    const local = await localFixture({
      newContext: options => browser.newContext({ ...options, recordHar: { path: `${blocker}/journey.har` } }),
      isConnected: () => connected,
    });
    const context = local.page.context();
    let closed = false;
    context.once('close', () => { closed = true; });
    try {
      await assert.rejects(local.close(), error => {
        assert.equal(closed, true, 'the real context close event precedes the HAR error');
        assert.match(error.message, /EEXIST|ENOTDIR/);
        return true;
      });
      await assert.rejects(fetch(local.server.origin), TypeError);
      await assert.rejects(local.close(), /EEXIST|ENOTDIR/);
    } finally {
      await local.server.close();
    }
  });
}

test('Fixture cleanup tolerates a target closing during disposal', async ({ browser }) => {
  const local = await localFixture(browser);
  const context = local.page.context();
  const close = context.close.bind(context);
  context.close = async () => {
    await close();
    await context.newPage();
  };
  await Promise.all([local.close(), local.close()]);
  await assert.rejects(fetch(local.server.origin), TypeError);
});


test('Journey fixture refuses outside-root file URLs and raw encoded traversal', async ({ browser }) => {
  const directory = temporaryDirectory('/tmp/WR622.S20.J7-path-probe-');
  const marker = `${directory}/outside.txt`;
  const sentinel = 'SYNTHETIC_OUTSIDE_ROOT_WR622_S20_J7';
  await writeFile(marker, sentinel);
  const local = await localFixture(browser);
  try {
    for (const path of [`/file://${marker}`, `/..%2f${marker.slice(1)}`, `/../${marker.slice(1)}`,
      `/..%252f${marker.slice(1)}`, `/file%3a%2f%2f${marker}`, `/..%5c${marker.slice(1)}`]) {
      const result = await new Promise((resolve, reject) => {
        get(local.server.origin, { path }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
          response.on('error', reject);
        }).on('error', reject);
      });
      assert.ok([400, 404].includes(result.status), `${path}: ${result.status}`);
      assert.equal(result.body.includes(sentinel), false, path);
      console.log(`outside-root probe ${path}: ${result.status}, sentinel=false`);
    }
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Share lifecycle serves the packet presentation through the real consumer parser', async ({ browser }) => {
  const local = await localFixture(browser);
  try {
    const token = 'synthetic-contract-probe';
    await local.page.request.post('/api/tours/share/issue', {
      data: { token_digest: 'sha256:' + createHash('sha256').update(token).digest('hex') },
    });
    await local.page.request.post('/api/share/exchange', { data: { token } });
    const response = await local.page.request.get('/api/share/report');
    assert.equal(response.status(), 200);
    const { data } = await response.json();
    const presentation = readPacketPresentation(data);
    assert.ok(presentation, 'share journey response must satisfy the versioned packet parser');
    assert.deepEqual(presentation.stops.map(stop => stop.name), fixture.tour.property_names);
    assert.deepEqual(presentation.stops.map(stop => stop.property_ref), data.stops.map(stop => stop.property_ref));
  } finally {
    await local.close();
  }
});
