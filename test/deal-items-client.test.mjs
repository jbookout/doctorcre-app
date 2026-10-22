import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

test('Tell Dr. CRE and Done use item-specific canonical verbs and retain supplied safety keys', async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    const request = JSON.parse(init.body); calls.push({ path, ...request.params });
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, item: { id: 'demo-item' } }) }] } });
  } });
  await client.instructDealItem({ deal: 'demo-deal', item_id: 'demo-item', text: 'Arrange a call.', idempotency_key: 'demo-instruct' });
  await client.completeDealItem({ deal: 'demo-deal', item_id: 'demo-item', idempotency_key: 'demo-complete' });
  assert.deepEqual(calls, [
    { path: '/mcp', name: 'instruct-deal-item', arguments: { deal: 'demo-deal', item_id: 'demo-item', text: 'Arrange a call.', idempotency_key: 'demo-instruct' } },
    { path: '/mcp', name: 'complete-deal-item', arguments: { deal: 'demo-deal', item_id: 'demo-item', idempotency_key: 'demo-complete' } },
  ]);
});
