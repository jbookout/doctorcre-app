import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientPortalClient } from '../js/client-portal-client.js';

const portal = {
  slug: 'demo-practice',
  roadmap: { current_phase: 'negotiation', phases: [
    { slug: 'research', label: 'Research' }, { slug: 'negotiation', label: 'Negotiation' },
    { slug: 'closed', label: 'Closed' },
  ] },
  materials: [{ kind: 'document', title: 'Demo terms', content: 'Shared terms only.' }],
};
const response = payload => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));

test('portal reader sends only the selected portal and password over authenticated same-origin MCP', async () => {
  let request;
  const client = createClientPortalClient({ fetchImpl: async (path, init) => {
    request = { path, init };
    return response({ ok: true, schema_version: 'client-portal.v1', portal });
  } });
  assert.deepEqual(await client.read({ slug: 'demo-practice', password: 'synthetic-password' }), portal);
  assert.equal(request.path, '/mcp');
  assert.equal(request.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(request.init.body).params, {
    name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'synthetic-password' },
  });
});

test('portal reader refuses another portal, unsupported versions and incomplete roadmap or material', async () => {
  const valid = { ok: true, schema_version: 'client-portal.v1', portal };
  for (const payload of [
    { ...valid, schema_version: 'client-portal.v2' },
    { ...valid, portal: { ...portal, slug: 'another-practice' } },
    { ...valid, portal: { ...portal, roadmap: { ...portal.roadmap, current_phase: 'missing' } } },
    { ...valid, portal: { ...portal, roadmap: { ...portal.roadmap, phases: [] } } },
    { ...valid, portal: { ...portal, materials: [{ kind: 'note', title: 'Internal', content: 'Do not share' }] } },
    { ...valid, portal: { ...portal, materials: [{ kind: 'report', title: 'Incomplete' }] } },
    { ok: false, error: 'portal_access_denied' },
  ]) {
    const client = createClientPortalClient({ fetchImpl: async () => response(payload) });
    await assert.rejects(client.read({ slug: 'demo-practice', password: 'synthetic-password' }), /Portal unavailable/);
  }
});
