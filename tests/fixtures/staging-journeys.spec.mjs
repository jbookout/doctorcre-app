import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detail } from '../../test/fixtures/tour-day.synthetic.mjs';
import { leaseRadarFixture } from '../../js/lease-radar-fixture.js';
import { leaseDetails, tourDay, itinerary, shareLifecycle } from '../staging/journey-flows.mjs';

const root = new URL('../../', import.meta.url);
export const fixture = {
  lease: { id: 'aa000000-0000-4000-8000-000000000001', client_id: 'aa000000-0000-4000-8000-000000000002', client_name: 'Synthetic staging QA lease' },
  tour: { id: detail.id, name: 'Synthetic staging QA accepted tour', route_id: detail.routes[0].id,
    property_ids: detail.stops.map(stop => stop.property_id), stop_ids: detail.stops.map(stop => stop.id),
    property_names: detail.stops.map(stop => stop.property_name), projection_id: 'aa000000-0000-4000-8000-000000000003',
    unrelated_property_id: 'aa000000-0000-4000-8000-000000000004' },
};

export async function localFixture(browser) {
  let active = false, exchanged = false, tokenDigest = '';
  const tour = structuredClone(detail);
  Object.assign(tour, { name: fixture.tour.name, route_version_id: fixture.tour.route_id, route_version_state: 'accepted',
    accepted_route_version: 1, projection_id: fixture.tour.projection_id, projection_status: 'approved', share_grants: [] });
  tour.stops.forEach(stop => { stop.locked_appointment = false; });
  tour.routes[0].acceptance_digest = 'sha256:' + 'a'.repeat(64);
  const lease = leaseRadarFixture();
  Object.assign(lease.leases[0], fixture.lease);
  const publicRef = property => 'property:public:' + createHash('sha256').update(`carr-internal:${fixture.tour.projection_id}:${property}`).digest('hex').slice(0, 32);
  const packet = { stops: tour.stops.map(stop => ({ name: stop.property_name, address: stop.property_address,
    property_ref: publicRef(stop.property_id), route_label: stop.route_label, route_sequence: stop.route_sequence })) };
  const projectionRef = 'projection:public:abcdefghijklmnop';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/tours/detail') return json({ data: tour, csrf_token: 'synthetic' });
    if (url.pathname === '/api/tours/library') return json({ data: { tours: [{ id: tour.id, name: tour.name, status: 'active' }] }, csrf_token: 'synthetic' });
    if (url.pathname === '/api/tours/share/issue') {
      tokenDigest = JSON.parse(Buffer.concat(chunks).toString()).token_digest;
      active = true; tour.share_grant_id = 'aa000000-0000-4000-8000-000000000005';
      return json({ data: { ok: true, share_grant_id: tour.share_grant_id, status: 'active' } });
    }
    if (url.pathname === '/api/tours/share/revoke') { active = false; return json({ data: { ok: true } }); }
    if (url.pathname === '/api/share/exchange') {
      const { token } = JSON.parse(Buffer.concat(chunks).toString());
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
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] !== 'same-origin') return json({ error: 'forbidden' }, 403);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        return packet.stops.some(stop => stop.property_ref === body.property_ref) ? json({ data: { saved: true } }) : json({ error: 'not_found' }, 404);
      }
    }
    if (url.pathname === '/api/v1/business/leases') return json(lease);
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
    if (url.pathname === '/mcp') return json({ result: { content: [{ type: 'text', text: '{"ok":true,"deals":[],"items":[],"notifications":[],"state":"unavailable"}' }] } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return json({});
    const file = url.pathname === '/leases' ? 'lease-radar.html' : url.pathname === '/share' ? 'reports/share.html'
      : ['/share.js','/share-bootstrap.js','/share.css'].includes(url.pathname) ? `reports${url.pathname}` : url.pathname.slice(1);
    try {
      const content = await readFile(new URL(file, root));
      res.writeHead(200, { 'content-type': /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ baseURL: origin });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  return { page: await context.newPage(), server, close: async () => { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

for (const [name, flow] of Object.entries({ leaseDetails, tourDay, itinerary, shareLifecycle })) {
  test(`staging acceptance logic against synthetic HTTP fixtures: ${name}`, async ({ browser }) => {
    const local = await localFixture(browser);
    try { await flow(local.page, fixture); } finally { await local.close(); }
  });
}

test('Share acceptance rejects a server denying every shortlist write', async ({ browser }) => {
  const local = await localFixture(browser);
  const [respond] = local.server.listeners('request');
  local.server.removeListener('request', respond);
  let denied = false;
  local.server.on('request', (request, response) => {
    if (request.url !== '/api/share/shortlist') return respond(request, response);
    denied = true;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  try {
    await assert.rejects(shareLifecycle(local.page, fixture), error => {
      assert.equal(error.message.includes('allowed-property shortlist write succeeds'), true);
      return true;
    });
    assert.equal(denied, true, 'the HTTP server must receive the shortlist write');
  } finally {
    await local.close();
  }
});
