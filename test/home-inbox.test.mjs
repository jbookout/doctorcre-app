import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot, shelves } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
export const item = (item_id, fields = {}) => ({ item_id, source_type: 'task', source_id: item_id, source_version: 'source:1', source_state: 'needs_attention', title: 'Synthetic follow-up', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', ...fields });
const snapshot = items => ({ ok: true, schema_version: 'home-inbox.v1', items, working_collapsed: true, auto_settle_enabled: false });
test('actor snapshot rejects duplicate identities and refusal is not empty', () => {
  assert.throws(() => parseSnapshot(snapshot([item('a'), item('a')])));
  assert.throws(() => parseSnapshot({ ok: false, error: 'read_limit_exceeded' }));
  assert.deepEqual(parseSnapshot(snapshot([])).items, []);
});
test('Done is not Settled and current Working card remains reachable', () => {
  const state = parseSnapshot(snapshot([item('done', { source_state: 'done', unseen: true }), item('work', { source_state: 'working', section: 'working' }), item('settled', { disposition: 'settled', section: 'settled' })]));
  const placed = shelves(state.items, 'work');
  assert.deepEqual(placed.inbox.map(row => row.item_id), ['done']);
  assert.equal(placed.current.item_id, 'work');
  assert.equal(placed.working.length, 0);
  assert.equal(placed.settled[0].item_id, 'settled');
});

test('commands retain exact retry identity and inspect mixed and missing results', async () => {
  const { createInboxClient, command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = []; let attempt = 0;
  const client = createInboxClient(async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (++attempt === 1) throw Error('Response lost');
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [
      { item_id: 'a', ok: true, item: item('a', { disposition: 'settled', base_version: 'opaque:2' }) },
      { item_id: 'b', ok: false, error: 'version_conflict', current_version: 'opaque:9' },
    ] };
  });
  const request = command('settle', [item('a'), item('b'), item('c')]);
  await assert.rejects(client.run(request), /Response lost/);
  const result = await client.run(request);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(result[0].item.disposition, 'settled');
  assert.equal(result[1].error, 'version_conflict');
  assert.match(result[2].error, /uncertain/);
  const offline = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try { await assert.rejects(client.run(request), /Offline/); assert.equal(calls.length, 2); }
  finally { Object.defineProperty(globalThis, 'navigator', offline); }
});
