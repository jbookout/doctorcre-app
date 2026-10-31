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

for (const method of ['prepareTermsComparison', 'recordHumanFact', 'resolveFactReview']) test(`${method} does not send after cancellation during session preparation`, async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const session = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path) => {
    if (path === '/auth/session') { started(); await session; return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' }); }
    writes++; return Response.json({});
  } });
  const controller = new AbortController();
  const args = { deal_id: 'd14', entity_ref: 'd14', fact_key: 'base_rent_per_sf', fields: [], idempotency_key: crypto.randomUUID() };
  const result = client[method](args, { signal: controller.signal }).catch(error => error);
  await waiting; controller.abort(); release(); await result;
  assert.equal(writes, 0);
});

test('comparison does not send after cancellation during adapter loading', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const loading = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const client = createLiveClient({ selfActor: 'joe', loadComparison: async () => { started(); await loading; return import('../js/terms-comparison-http.mjs'); }, fetchImpl: async path => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    writes++; return Response.json({});
  } });
  const controller = new AbortController();
  const result = client.prepareTermsComparison({ deal_id: 'd14', fields: [], idempotency_key: crypto.randomUUID() }, { signal: controller.signal }).catch(error => error);
  await waiting; controller.abort(); release(); await result;
  assert.equal(writes, 0);
});

test('aborting an in-flight comparison retains the exact request for reconciliation', async () => {
  const { readFile } = await import('node:fs/promises');
  const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
  let started; const sent = new Promise(resolve => { started = resolve; });
  const requests = [];
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return new Promise((resolve, reject) => { started(); init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    return Response.json(plan);
  } });
  const request = { deal_id: plan.deal.id, idempotency_key: crypto.randomUUID(), fields: [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }] };
  const controller = new AbortController();
  const first = client.prepareTermsComparison(request, { signal: controller.signal });
  await sent; controller.abort();
  await assert.rejects(first, error => error.pendingRequest.idempotency_key === request.idempotency_key);
  assert.equal((await client.prepareTermsComparison(request)).document_id, plan.document_id);
  assert.deepEqual(requests, [request, request]);
});

test('a canceled reconciliation keeps the earlier uncertain request', async () => {
  const { readFile } = await import('node:fs/promises');
  const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
  let loads = 0, release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const client = createLiveClient({ selfActor: 'joe', loadComparison: async () => {
    if (++loads === 2) { started(); await gate; }
    return import('../js/terms-comparison-http.mjs');
  }, fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) throw new Error('connection lost');
    return Response.json(plan);
  } });
  const request = { deal_id: plan.deal.id, idempotency_key: crypto.randomUUID(), fields: [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }] };
  await assert.rejects(client.prepareTermsComparison(request));
  const controller = new AbortController();
  const retry = client.prepareTermsComparison(request, { signal: controller.signal });
  await waiting; controller.abort(); release();
  await assert.rejects(retry, error => error.pendingRequest.idempotency_key === request.idempotency_key);
  assert.equal((await client.prepareTermsComparison(request)).document_id, plan.document_id);
  assert.deepEqual(requests, [request, request]);
});
