import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot, createInboxClient, command, shelves } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const item = fields => ({ item_id: 'task', source_type: 'next_action', source_id: 'task', source_version: 'source:1', source_state: 'done', title: 'Synthetic task', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'settled', snoozed_until: null, explicit_unsettle: false, section: 'settled', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000001', action_version: 7, deal_id: null, auto_settled: true, ...fields });
const snapshot = items => ({ ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, limit: 1000, truncated: false, items });
for (const source_type of ['next_action', 'capture_post_call_action', 'email_proposal', 'fact_review', 'tour_feedback']) test(`v3 accepts canonical resolution of ${source_type} outside the working list`, () => {
  const task = ['next_action', 'capture_post_call_action'].includes(source_type);
  const parsed = parseSnapshot(snapshot([item({ source_type, ...(task ? {} : { action_id: null, action_version: null }), kind_label: source_type === 'fact_review' ? 'Fact review' : source_type === 'tour_feedback' ? 'Tour feedback' : task ? 'Task' : 'Reply draft' })]));
  assert.equal(parsed.auto_settle_enabled, true);
  assert.equal(parsed.items[0].auto_settled, true);
  assert.equal(shelves(parsed.items).working.length, 0);
  assert.equal(shelves(parsed.items).settled.length, 1);
});
test('v3 cannot manufacture an automatic resolution from malformed data', () => {
  for (const fields of [{ auto_settled: undefined }, { auto_settled: 'true' }, { section: 'inbox' }, { disposition: 'inbox' }, { explicit_unsettle: true }, { source_state: 'working' }, { source_type: 'notification', action_id: null, action_version: null, kind_label: 'Update' }]) assert.throws(() => parseSnapshot(snapshot([item(fields)])), JSON.stringify(fields));
});
test('v3 read and disposition readback preserve opaque command authority', async () => {
  const calls = [];
  const client = createInboxClient(async (name, args) => {
    calls.push(name);
    if (name === 'read-home-inbox-v3') return snapshot([item({ auto_settled: false, explicit_unsettle: true, section: 'inbox', base_version: 'opaque:2' })]);
    return { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: 'task', ok: true, item: item({ section: 'inbox', explicit_unsettle: true, auto_settled: false, base_version: 'opaque:2' }) }] };
  });
  const initial = await client.read();
  const [result] = await client.run(command('unsettle', [initial.items[0]]));
  assert.equal(result.ok, true); assert.equal(result.item.explicit_unsettle, true);
  assert.deepEqual(calls, ['read-home-inbox-v3', 'unsettle-home-inbox', 'read-home-inbox-v3']);
});
test('unsupported v3 falls back to explicit v2 without claiming automatic settlement', async () => {
  const calls = [];
  const client = createInboxClient(async name => {
    calls.push(name);
    if (name === 'read-home-inbox-v3') throw Object.assign(Error('Unsupported'), { payload: { error: 'unknown_tool' } });
    return { ...snapshot([item({ auto_settled: undefined, section: 'done' })]), schema_version: 'home-inbox.v2', auto_settle_enabled: false };
  });
  const read = await client.read();
  assert.equal(read.auto_settle_enabled, false); assert.equal(read.items[0].auto_settled, false);
  assert.deepEqual(calls, ['read-home-inbox-v3', 'read-home-inbox-v2']);
});
for (const code of ['partner_required', 'network_error', 'invalid_projection']) test(`v3 ${code} cannot be concealed by a legacy fallback`, async () => {
  const calls = [];
  const client = createInboxClient(async name => { calls.push(name); throw Object.assign(Error(code), { payload: { error: code } }); });
  await assert.rejects(client.read(), new RegExp(code));
  assert.deepEqual(calls, ['read-home-inbox-v3']);
});
