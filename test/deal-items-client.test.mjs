import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

test('Tell Dr. CRE and Done use item-specific canonical verbs and retain supplied safety keys', async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    const request = JSON.parse(init.body); calls.push({ path, ...request.params });
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, item: { id: 'demo-item' } }) }] } });
  } });
  await client.recordDealItem({ deal: 'demo-deal', title: 'Arrange next call', due_on: null, bullets: [{ kind: 'promised', text: 'Arrange next call' }], idempotency_key: 'demo-record' });
  await client.instructDealItem({ deal: 'demo-deal', item_id: 'demo-item', text: 'Arrange a call.', idempotency_key: 'demo-instruct' });
  await client.completeDealItem({ deal: 'demo-deal', item_id: 'demo-item', idempotency_key: 'demo-complete' });
  assert.deepEqual(calls, [
    { path: '/mcp', name: 'record-deal-item', arguments: { deal: 'demo-deal', title: 'Arrange next call', due_on: null, bullets: [{ kind: 'promised', text: 'Arrange next call' }], idempotency_key: 'demo-record', source_ref: 'app:deal-item:demo-record' } },
    { path: '/mcp', name: 'instruct-deal-item', arguments: { deal: 'demo-deal', item_id: 'demo-item', text: 'Arrange a call.', idempotency_key: 'demo-instruct' } },
    { path: '/mcp', name: 'complete-deal-item', arguments: { deal: 'demo-deal', item_id: 'demo-item', idempotency_key: 'demo-complete' } },
  ]);
});

test('the fixture records instructions as status facts and stores later follow-ups as items', async () => {
  const { createFixtureClient } = await import('../js/fixture-client.js');
  const { readFile } = await import('node:fs/promises');
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}`, docContext: false });
  const original = structuredClone((await client.getDeal('d14')).deal.items);
  await client.instructDealItem({ deal: 'd14', item_id: original[0].id, text: 'Arrange the call.', idempotency_key: 'synthetic-instruction' });
  assert.equal((await client.getDeal('d14')).deal.items[0].bullets.at(-1).kind, 'status');
  await client.recordDealItem({ deal: 'd14', title: 'Arrange next call', due_on: '2026-10-23', bullets: [{ kind: 'promised', text: 'Arrange the next call.' }], idempotency_key: 'synthetic-follow-up' });
  const items = (await client.getDeal('d14')).deal.items;
  assert.equal(items.length, original.length + 1);
  assert.deepEqual(items.slice(0, original.length).map(i => i.id), original.map(i => i.id));
  assert.equal(items.at(-1).due_on, '2026-10-23');
  assert.equal(items.at(-1).status, 'open');
  assert.equal(items.at(-1).bullets[0].text, 'Arrange the next call.');
  await client.recordDealItem({ deal: 'd14', title: 'Arrange next call', due_on: '2026-10-23', bullets: [{ kind: 'promised', text: 'Arrange the next call.' }], idempotency_key: 'synthetic-follow-up' });
  assert.equal((await client.getDeal('d14')).deal.items.length, items.length);
});
