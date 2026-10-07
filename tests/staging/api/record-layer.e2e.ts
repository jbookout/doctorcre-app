import { describe } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';
import { test } from './fixture.ts';

// API tests (docs/api-testing.mdx) for the record-layer calls the app makes
// through the staging Worker's CARR proxy. No model calls. Bodies are checked
// with toMatchSchema; nothing token-bearing is ever printed.
const Freshness = z.object({ source: z.string(), observed_at: z.string(), valid_until: z.string() }).passthrough();

describe('staging API, signed in', { session: 'staging-partner', tags: ['api'] }, () => {
  test('release identity names the staging app and both contracts', async ({ api, app }) => {
    await app.open('/status');
    const response = await api('/app-release');
    expect(response.status).toBe(200);
    const release = expect(await response.json()).toMatchSchema(z.object({
      service: z.literal('doctorcre-app'), environment: z.literal('staging'), source_commit: z.string().regex(/^[a-f0-9]{40}$/),
      carr_contract: z.object({ schema: z.literal('doctorcre-carr-interface.v1'), version: z.string() }),
      route_contract: z.object({ schema: z.literal('doctorcre-app-routes.v1'), version: z.string() }),
    }).passthrough());
    expect(release.source_commit).toMatch(/^[a-f0-9]{40}$/);
  });

  test('session is the dedicated E2E Joe principal and is not a reauth prompt', async ({ api, app }) => {
    await app.open('/status');
    const response = await api('/auth/session');
    expect(response.status).toBe(200);
    const session = expect(await response.json()).toMatchSchema(z.object({
      actor: z.object({ slug: z.literal('joe'), display: z.string() }), csrf_token: z.string().min(32),
      reauth_required: z.literal(false), e2e_principal: z.literal('e2e-joe'),
    }).passthrough());
    expect(session.actor.display).toContain('E2E');
  });

  test('command center returns counts with freshness for the Home dashboard', async ({ api, app }) => {
    await app.open('/status');
    const response = await api('/api/v1/command-center');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const cc = expect(await response.json()).toMatchSchema(z.object({
      viewer: z.literal('joe'),
      needs_you_now: z.array(z.object({ kind: z.string(), scope: z.string(), count: z.number().int().nonnegative(), destination: z.string().startsWith('/') }).passthrough()),
      metrics: z.array(z.object({ scope: z.string(), active_deals: z.number().int().nonnegative(), source: Freshness }).passthrough()).min(1),
    }).passthrough());
    for (const item of cc.needs_you_now) expect(new URL(item.destination, app.baseUrl).origin).toBe(new URL(app.baseUrl!).origin);
  });

  test('system work lists current work requests with a human next action', async ({ api, app }) => {
    await app.open('/status');
    const response = await api('/api/system-work/current');
    expect(response.status).toBe(200);
    const body = expect(await response.json()).toMatchSchema(z.object({ ok: z.literal(true), data: z.object({ ok: z.literal(true), items: z.array(z.object({ human_ref: z.string().regex(/^WR-\d+$/), title: z.string(), state: z.string() }).passthrough()) }) }));
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  test('relationship network uses its contract and every edge joins two typed nodes', async ({ api, app }) => {
    await app.open('/status');
    const response = await api('/api/v1/business/relationships?contract=relationship-network.v1');
    expect(response.status).toBe(200);
    const net = expect(await response.json()).toMatchSchema(z.object({ schema: z.literal('carr-relationship-network.v1'), observed_at: z.string(), edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), kind: z.string() }).passthrough()) }).passthrough());
    for (const edge of net.edges) { expect(edge.from).toMatch(/^[a-z_]+:/); expect(edge.to).toMatch(/^[a-z_]+:/); }
  });

  test('the Jev deal reading endpoint refuses GET (write-only door)', async ({ api, app }) => {
    await app.open('/status');
    expect((await api('/api/v1/jev-deal-reading')).status).toBe(405);
  });
});

describe('staging API, signed out', { tags: ['api'] }, () => {
  for (const path of ['/api/v1/command-center', '/api/system-work/current', '/auth/session']) {
    test(`${path} refuses an unsigned request`, async ({ app }) => {
      const response = await fetch(new URL(path, app.baseUrl), { redirect: 'manual' });
      expect(response.status).toBe(401);
    });
  }
  test('release identity is GET only', async ({ app }) => {
    expect((await fetch(new URL('/app-release', app.baseUrl), { method: 'POST', redirect: 'manual' })).status).toBe(405);
  });
  test('an app screen sends a signed-out browser to sign-in with its return path', async ({ app }) => {
    const response = await fetch(new URL('/deals', app.baseUrl), { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/auth/login?return_to=%2Fdeals');
  });
});
