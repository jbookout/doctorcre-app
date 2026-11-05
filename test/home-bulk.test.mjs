import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/batch.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { batchRequest, undoRequest, parseBatch, transition } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const items = ['a','b'].map(item_id => ({ item_id, base_version: 'a'.repeat(32) }));
const request = batchRequest('settle', items);
const result = { batch_key: request.args.idempotency_key, results: items.map(({ item_id }) => ({ item_id, status: 'applied' })), snapshot: null };
const selection = { kind: 'selection' };
const applying = transition(selection, { kind: 'apply', request, items });
const results = transition(applying, { kind: 'received', result });
test('selection to applying to results waits for receipts and preserves original items', () => {
  assert.equal(applying.kind, 'applying'); assert.equal(results.kind, 'results');
  assert.deepEqual(results.batch.remaining, ['a','b']);
  assert.equal(transition(applying, { kind: 'reset' }), applying);
  assert.equal(transition(applying, { kind: 'apply', request, items }), applying);
});
for (const status of ['applied','already','not_found','not_allowed']) test(`results to undoing to ${status} preserves remaining exact undo`, () => {
  const undo = undoRequest(results.batch, ['a']);
  assert.deepEqual(undo.args.items, [{ item_id: 'a' }]);
  assert.equal(undo.args.undo_of, request.args.idempotency_key);
  assert.equal('base_version' in undo.args.items[0], false);
  const undoing = transition(results, { kind: 'undo', request: undo });
  assert.equal(undoing.kind, 'undoing');
  const next = transition(undoing, { kind: 'received', result: { ...result, results: [{ item_id: 'a', status }] } });
  assert.equal(next.kind, ['applied','already'].includes(status) ? 'undone' : 'undo_refused');
  assert.deepEqual(next.batch.remaining, ['applied','already'].includes(status) ? ['b'] : ['a','b']);
  assert.equal(next.batch.result.results.length, 2);
  assert.equal(transition(next, { kind: 'reset' }).kind, 'selection');
  assert.equal(transition(next, { kind: 'undo', request: undoRequest(next.batch) }).kind, 'undoing');
});
for (const operation of [applying, transition(results, { kind: 'undo', request: undoRequest(results.batch) })]) test(`${operation.kind} failure retry retains exact request`, () => {
  const uncertain = transition(operation, { kind: 'failed', message: 'Response lost' });
  assert.equal(uncertain.kind, 'uncertain');
  assert.equal(transition(uncertain, { kind: 'reset' }), uncertain);
  assert.equal(transition(uncertain, { kind: 'retry' }), operation);
});
test('mixed apply only authorizes undo for applied cards', () => {
  const next = transition(applying, { kind: 'received', result: { ...result, results: [{ item_id: 'a', status: 'already' }, { item_id: 'b', status: 'applied' }] } });
  assert.deepEqual(next.batch.remaining, ['b']);
  assert.throws(() => undoRequest(next.batch, ['a']));
  assert.equal('items' in undoRequest(next.batch).args, false);
});
test('request enforces 100 distinct cards and future snooze time', () => {
  for (const rows of [[], [items[0], items[0]], Array.from({ length: 101 }, (_, n) => ({ item_id: String(n), base_version: 'a'.repeat(32) }))]) assert.throws(() => batchRequest('settle', rows));
  for (const time of [undefined, 'garbage', '2000-01-01T00:00:00Z']) assert.throws(() => batchRequest('snooze', items, time));
  assert.equal(batchRequest('snooze', items, '2099-01-01T00:00:00Z').args.until, '2099-01-01T00:00:00Z');
});
test('parser requires complete unique receipts and matching batch authority', () => {
  const wire = { ok: true, schema_version: 'home-inbox-batch.v1', ...result };
  assert.equal(parseBatch(wire, request, ['a','b']).results.length, 2);
  for (const value of [{ ...wire, batch_key: 'wrong' }, { ...wire, results: [result.results[0]] }, { ...wire, results: [result.results[0],result.results[0]] }, { ...wire, results: [{ item_id: 'a', status: 'success' },result.results[1]] }]) assert.throws(() => parseBatch(value, request, ['a','b']));
});
