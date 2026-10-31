import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

for (const reason of ['missing', 'unresolved', 'stale_snapshot']) test(`comparison HTTP preserves ${reason} refusal`, async () => {
  const calls = [];
  const client = createLiveClient({ selfActor: 'joe', docContext: false, fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    calls.push({ path, body: JSON.parse(init.body), csrf: init.headers['x-carr-csrf'] });
    return Response.json({ error: 'comparison_fact_blocked', field: 'base_rent_per_sf', reason }, { status: 400 });
  } });
  const request = { deal_id: '00000000-0000-4000-8000-000000000001', idempotency_key: crypto.randomUUID(),
    fields: [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }] };
  await assert.rejects(client.prepareTermsComparison(request), error => error.payload?.reason === reason && error.payload.field === 'base_rent_per_sf');
  assert.deepEqual(calls, [{ path: '/api/v1/fact-review/comparison', body: request, csrf: 'synthetic-session' }]);
});

test('an interrupted comparison retries its exact HTTP request and confirms the draft', async () => {
  const { readFile } = await import('node:fs/promises');
  const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
  const requests = [];
  const client = createLiveClient({ selfActor: 'joe', docContext: false, fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) throw new TypeError('Synthetic interrupted response');
    return Response.json(plan);
  } });
  const request = { deal_id: plan.deal.id, idempotency_key: crypto.randomUUID(), fields: [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }] };
  await assert.rejects(client.prepareTermsComparison(request), error => error.pendingRequest.idempotency_key === request.idempotency_key);
  assert.equal((await client.prepareTermsComparison(request)).document_id, plan.document_id);
  assert.deepEqual(requests, [request, request]);
});

for (const status of [404, 503]) test(`HTTP ${status} remains unavailable rather than a draft`, async () => {
  const client = createLiveClient({ selfActor: 'joe', docContext: false, fetchImpl: async path => path === '/auth/session'
    ? Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' })
    : Response.json({ error: 'DEPENDENCY_UNAVAILABLE' }, { status }) });
  await assert.rejects(client.prepareTermsComparison({ deal_id: 'demo', fields: [], idempotency_key: crypto.randomUUID() }), error => error.status === status);
});

test('a receipt without the requested fill fields stays uncertain', async () => {
  const { readFile } = await import('node:fs/promises');
  const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
  const client = createLiveClient({ selfActor: 'joe', docContext: false, fetchImpl: async path => path === '/auth/session'
    ? Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' })
    : Response.json({ ...plan, edits: [] }) });
  const request = { deal_id: plan.deal.id, idempotency_key: crypto.randomUUID(), fields: [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }] };
  await assert.rejects(client.prepareTermsComparison(request), error => error.pendingRequest.idempotency_key === request.idempotency_key);
});
