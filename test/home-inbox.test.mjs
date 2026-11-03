import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot, shelves } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
export const item = (item_id, fields = {}) => ({ item_id, source_type: 'next_action', source_id: item_id, source_version: 'source:1', source_state: 'needs_attention', title: 'Synthetic follow-up', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: 'Demo practice', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001', ...fields });
const snapshot = items => ({ ok: true, schema_version: 'home-inbox.v2', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: false });
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
  assert.equal(placed.working.length, 1);
  assert.equal(placed.settled[0].item_id, 'settled');
});

test('commands retain exact retry identity and inspect mixed and missing results', async () => {
  const { createInboxClient, command } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = []; let attempt = 0;
  const client = createInboxClient(async (name, args) => {
    if (name === 'read-home-inbox-v2') return snapshot([item('a', { disposition: 'settled', base_version: 'opaque:2' })]);
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

test('unexpected command results cannot confirm another item', async () => {
  const { command, parseResults } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const request = command('settle', [item('a')]);
  assert.throws(() => parseResults({ ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'other', ok: true, item: item('other') }] }, request), /uncertain/);
});

test('wire states must be strings and placement uses the canonical section', () => {
  for (const fields of [{ source_state: ['done'] }, { disposition: ['inbox'] }, { section: 'unknown' }]) assert.throws(() => parseSnapshot(snapshot([item('a', fields)])));
  const state = parseSnapshot(snapshot([item('a', { source_state: 'working', section: 'inbox' })]));
  assert.deepEqual(shelves(state.items).inbox.map(row => row.item_id), ['a']);
});

test('v2 preserves producer context, completion identity and opaque versions', () => {
  const parsed = parseSnapshot(snapshot([item('a'), item('loop', { deal_id: null, context_label: null, open_url: null })]));
  assert.equal(parsed.items[0].action_version, 7);
  assert.equal(parsed.items[0].base_version, 'opaque:1');
  assert.equal(parsed.items[1].deal_id, null);
  for (const fields of [{ action_id: null }, { action_version: null }, { action_version: '7' }, { action_version: 0 }, { action_version: 1.5 }, { action_id: 'bad' }, { deal_id: 'bad' }, { deal_id: undefined }, { action_id: undefined }, { action_version: undefined }]) {
    assert.throws(() => parseSnapshot(snapshot([item('bad', fields)])), JSON.stringify(fields));
  }
  assert.doesNotThrow(() => parseSnapshot(snapshot([item('update', { source_type: 'notification', kind_label: 'Update', action_id: null, action_version: null, deal_id: null, section: 'held' })])));
  assert.throws(() => parseSnapshot(snapshot([item('update', { source_type: 'notification', kind_label: 'Update' })])));
});

test('v1 command receipts recover v2 metadata through one authoritative read', async () => {
  const { command, createInboxClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const calls = [];
  const request = command('settle', [item('a', { base_version: 'do-not-parse:007' })]);
  const client = createInboxClient(async (name, args) => {
    calls.push({ name, args });
    if (name === 'read-home-inbox-v2') return snapshot([item('a', { disposition: 'settled', section: 'settled', base_version: 'next:opaque', context_label: 'Updated deal' })]);
    const { context_label, due_on, open_url, kind_label, merged_source_ids, action_id, action_version, deal_id, ...legacy } = item('a', { disposition: 'settled', section: 'settled' });
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'a', ok: true, item: legacy }] };
  });
  const [result] = await client.run(request);
  assert.equal(result.item.context_label, 'Updated deal');
  assert.equal(result.item.action_version, 7);
  assert.equal(result.item.base_version, 'next:opaque');
  assert.deepEqual(calls.map(call => call.name), ['settle-home-inbox', 'read-home-inbox-v2']);
  assert.equal(calls[0].args.items[0].base_version, 'do-not-parse:007');
});

test('source links use only supported producer destinations', async () => {
  const built = await build({ entryPoints: ['src/ui/home/routes.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { recordRoutes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
  for (const open_url of [null, 'javascript:alert(1)', 'https://example.com', '//example.com', '/\\example.com', '/missing-page']) assert.equal(recordRoutes.source(item('a', { open_url })), null);
  const url = '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step';
  assert.equal(recordRoutes.source(item('a', { open_url: url })), url);
});
