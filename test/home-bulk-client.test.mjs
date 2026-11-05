import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ stdin: { contents: "export { createInboxClient } from './src/ui/home/inbox'; export { fixtureInboxRpc } from './src/ui/home/fixture'; export { batchRequest, undoRequest } from './src/ui/home/batch';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { createInboxClient, fixtureInboxRpc, batchRequest, undoRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
for (const action of ['settle','snooze']) test(`local synthetic ${action} batch restores exact prior snooze and explicit disposition`, async () => {
  const client = createInboxClient(fixtureInboxRpc());
  const before = await client.read();
  const items = before.items.filter(item => ['demo-review','demo-snooze'].includes(item.item_id));
  const request = batchRequest(action, items, '2099-01-01T00:00:00Z');
  const result = await client.batch(request, items.map(item => item.item_id));
  assert.deepEqual(result.results.map(row => row.status), ['applied','applied']);
  const batch = { request, result, items, remaining: items.map(item => item.item_id) };
  await client.batch(undoRequest(batch), batch.remaining);
  const after = await client.read();
  for (const item of items) assert.deepEqual(after.items.find(next => next.item_id === item.item_id), item);
});
test('confirmed receipts survive a failed read without another mutation', async () => {
  let writes = 0;
  const request = batchRequest('settle', [{ item_id: 'a', base_version: 'a'.repeat(32) }]);
  const client = createInboxClient(async (name) => {
    if (name === 'read-home-inbox-v3') throw Error('read failed');
    writes++;
    return { ok: true, schema_version: 'home-inbox-batch.v1', batch_key: request.args.idempotency_key, results: [{ item_id: 'a', status: 'applied' }] };
  });
  const result = await client.batch(request, ['a']);
  assert.equal(result.snapshot, null); assert.equal(result.results[0].status, 'applied'); assert.equal(writes, 1);
});
test('local synthetic intervening changes refuse exact undo', async () => {
  const client = createInboxClient(fixtureInboxRpc());
  const [item] = (await client.read()).items;
  const request = batchRequest('settle', [item]);
  const result = await client.batch(request, [item.item_id]);
  const current = result.snapshot.items.find(row => row.item_id === item.item_id);
  await client.batch(batchRequest('snooze', [current], '2099-01-01T00:00:00Z'), [item.item_id]);
  const undo = await client.batch(undoRequest({ request, result, items: [item], remaining: [item.item_id] }), [item.item_id]);
  assert.equal(undo.results[0].status, 'not_allowed');
  assert.equal(undo.results[0].error, 'version_conflict');
  assert.equal(undo.snapshot.items.find(row => row.item_id === item.item_id).disposition, 'snoozed');
});
