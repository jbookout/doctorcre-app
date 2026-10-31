import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

const observation = { fact_key: 'base_rent_per_sf', value: '26', unit: 'USD/SF/year', expense_basis: 'nnn',
  source: { document_ref: '00000000-0000-4000-8000-000000000039', page_start: 2, page_end: 3, cited_text: 'Demo rent clause.' } };

test('fact review lists canonical terms and sends record, approve, correct and reject through CARR', async () => {
  const calls = [];
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const { params } = JSON.parse(init.body); calls.push(params);
    return Response.json({ result: { content: [{ text: JSON.stringify({ ok: true, schema_version: 'fact-review.v1', items: [], has_more: false, next_cursor: null, observation: { id: 'demo-observation' }, canonical_fact: null, review_receipt: { decision: params.arguments.decision } }) }] } });
  } });
  const list = { entity_ref: 'demo-deal', include_resolved: true, limit: 100 };
  assert.equal((await client.listFactReview(list)).schema_version, 'fact-review.v1');
  const record = { entity_ref: 'demo-deal', observation, idempotency_key: '00000000-0000-4000-8000-000000000001' };
  await client.recordHumanFact(record);
  const base = { entity_ref: 'demo-deal', fact_key: observation.fact_key, base_version: 1, review_version: 'a'.repeat(64), reason: 'Demo reviewed clause.' };
  const actions = [
    { ...base, decision: 'approve', observation_id: '00000000-0000-4000-8000-000000000002', idempotency_key: '00000000-0000-4000-8000-000000000003' },
    { ...base, decision: 'correct', correction: observation, idempotency_key: '00000000-0000-4000-8000-000000000004' },
    { ...base, decision: 'reject', idempotency_key: '00000000-0000-4000-8000-000000000005' },
  ];
  for (const args of actions) await client.resolveFactReview(args);
  assert.deepEqual(calls, [{ name: 'list-fact-review', arguments: list }, { name: 'record-human-fact', arguments: record }, ...actions.map(args => ({ name: 'resolve-fact-review', arguments: args }))]);
});

import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
async function fixture() {
  const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8'));
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(seed)).toString('base64')}`, docContext: false });
}

test('fixture reviews three sourced values, preserves canonical on rejection, and refuses stale evidence', async () => {
  const client = await fixture();
  const read = async () => (await client.listFactReview({ entity_ref: 'd14', include_resolved: true })).items[0];
  const initial = await read();
  assert.equal(initial.observations.length, 3);
  assert.equal(initial.pending, true);
  const resolve = (item, patch) => client.resolveFactReview({ entity_ref: 'd14', fact_key: item.fact_key, base_version: item.canonical_version,
    review_version: item.review_version, reason: 'Demo reviewed all documents.', idempotency_key: crypto.randomUUID(), ...patch });
  const approved = await resolve(initial, { decision: 'approve', observation_id: initial.observations[2].id });
  assert.equal(approved.canonical_fact.normalized_value, '26');
  assert.equal((await read()).pending, false);
  await assert.rejects(resolve(initial, { decision: 'reject' }), error => error.payload?.error === 'version_conflict');
  const correction = { ...observation, value: '27', source: { ...observation.source, document_ref: initial.observations[0].source.document_ref } };
  const corrected = await resolve(await read(), { decision: 'correct', correction });
  assert.equal(corrected.canonical_fact.normalized_value, '27');
  const record = { entity_ref: 'd14', observation: { ...correction, value: '28' }, idempotency_key: crypto.randomUUID() };
  const recorded = await client.recordHumanFact(record);
  assert.equal(recorded.observation.method, 'human');
  assert.equal((await client.recordHumanFact(record)).replayed, true);
  assert.equal((await read()).observations.length, 5);
  await resolve(await read(), { decision: 'reject' });
  const final = await read();
  assert.equal(final.pending, false);
  assert.equal(final.canonical_fact.normalized_value, '27');
  assert.deepEqual(final.review_history.map(item => item.decision), ['approve', 'correct', 'reject']);
  assert.equal((await client.listFactReview({ entity_ref: 'd14' })).items.length, 0);
  await assert.rejects(client.recordHumanFact({ ...record, entity_ref: 'd20', idempotency_key: crypto.randomUUID() }), error => error.payload?.error === 'document_not_found');
});

test('a missing term receipt stays uncertain and retry retains the original request', async () => {
  const calls = [];
  const args = { entity_ref: 'demo-deal', fact_key: 'base_rent_per_sf', base_version: 0, review_version: 'a'.repeat(64), decision: 'reject', reason: 'Demo review.', idempotency_key: crypto.randomUUID() };
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    calls.push(JSON.parse(init.body).params.arguments);
    return Response.json({ result: { content: [{ text: JSON.stringify({ ok: true, schema_version: 'fact-review.v1',
      ...(calls.length > 1 ? { canonical_fact: null, review_receipt: { decision: 'reject' } } : {}) }) }] } });
  } });
  await assert.rejects(client.resolveFactReview(args), { code: 'unknown_outcome' });
  assert.equal((await client.resolveFactReview(args)).review_receipt.decision, 'reject');
  assert.deepEqual(calls, [args, args]);
});

for (const method of ['recordHumanFact', 'resolveFactReview']) test(`${method} preserves a stale refusal`, async () => {
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path) => path === '/auth/session'
    ? Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' })
    : Response.json({ result: { isError: true, content: [{ text: JSON.stringify({ error: 'version_conflict', current_version: 3 }) }] } }) });
  await assert.rejects(client[method]({ entity_ref: 'demo-deal', idempotency_key: crypto.randomUUID() }), error => error.payload.error === 'version_conflict' && error.payload.current_version === 3);
});

test('fixture list pages resolved and pending terms and normalizes a recorded lease term', async () => {
  const client = await fixture();
  const existing = (await client.listFactReview({ entity_ref: 'd14' })).items[0];
  const recorded = await client.recordHumanFact({ entity_ref: 'd14', idempotency_key: crypto.randomUUID(), observation: {
    fact_key: 'term_months', value: '5', unit: 'years', source: { ...observation.source, document_ref: existing.observations[0].source.document_ref },
  } });
  const first = await client.listFactReview({ entity_ref: 'd14', limit: 1 });
  assert.equal(first.has_more, true);
  const second = await client.listFactReview({ entity_ref: 'd14', limit: 1, cursor: first.next_cursor });
  assert.equal(second.items[0].fact_key, 'term_months');
  assert.equal(second.has_more, false);
  const item = second.items[0];
  await client.resolveFactReview({ entity_ref: 'd14', fact_key: 'term_months', base_version: 0, review_version: item.review_version,
    decision: 'approve', observation_id: recorded.observation.id, reason: 'Demo reviewed lease term.', idempotency_key: crypto.randomUUID() });
  const final = (await client.listFactReview({ entity_ref: 'd14', include_resolved: true })).items.find(row => row.fact_key === 'term_months');
  assert.equal(final.canonical_fact.normalized_value, '60');
  assert.equal(final.canonical_fact.canonical_unit, 'months');
  assert.equal(final.observations[0].value, '5');
  assert.equal(final.observations[0].unit, 'years');
});

test('live client lists deal document metadata through CARR', async () => {
  const calls = [];
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    calls.push(JSON.parse(init.body).params);
    return Response.json({ result: { content: [{ text: JSON.stringify({ ok: true, schema_version: 'deal-documents.v1', documents: [], has_more: false, next_cursor: null }) }] } });
  } });
  const args = { deal_id: '00000000-0000-4000-8000-000000000039', limit: 100 };
  assert.equal((await client.listDealDocuments(args)).schema_version, 'deal-documents.v1');
  assert.deepEqual(calls, [{ name: 'list-deal-documents', arguments: args }]);
});
