import assert from 'node:assert/strict';
import contract from './home-bulk-contract.json' with { type: 'json' };
export const makeItem = id => ({ item_id: id, title: `Synthetic ${id}`, source_type: 'notification', source_id: id, source_version: 'synthetic:1', source_state: 'needs_attention', activity_at: '2026-11-01T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'a'.repeat(32), auto_settled: false, context_label: 'Demo practice', due_on: null, open_url: null, kind_label: 'Update', merged_source_ids: [], action_id: null, action_version: null, deal_id: null });
export function createBatchFake(items, { mixed = false, stale = false, lost = false, missing = false, hold = false, undoLost = false } = {}) {
  const calls = [], receipts = new Map(), batches = new Map();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { items, calls, release, async rpc(name, args) {
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return { error: 'unknown_tool' };
    if (name === 'read-home-inbox-v3') return { ok: true, schema_version: 'home-inbox.v3', items: structuredClone(items), truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true };
    if (!contract.verbs[name]) return { ok: true, items: [], enabled: false };
    calls.push({ name, args: structuredClone(args) });
    if (hold) { hold = false; await gate; }
    const schema = contract.verbs[name];
    assert.ok(Object.keys(args).every(key => key in schema.properties));
    const previous = receipts.get(args.idempotency_key);
    if (previous) { assert.deepEqual(previous.args, args); return previous.result; }
    assert.equal(args.reversible, true);
    assert.match(args.idempotency_key, /^[0-9a-f-]{36}$/);
    const batch = args.undo_of ? batches.get(args.undo_of) : new Map();
    const requested = args.items || [...batch.keys()].map(item_id => ({ item_id }));
    assert.ok(requested.length >= 1 && requested.length <= 100);
    const results = requested.map((entry, index) => {
      const item = items.find(item => item.item_id === entry.item_id);
      let status = 'applied', error;
      if (args.undo_of) {
        const saved = batch.get(entry.item_id);
        if (saved.status !== 'applied' || saved.undone) status = 'already';
        else if (stale) { status = 'not_allowed'; error = 'version_conflict'; }
        else { Object.assign(item, saved.before); saved.undone = true; }
      } else {
        assert.match(entry.base_version, /^[a-f0-9]{32}$/);
        if (mixed && index > 0) status = ['applied', 'already', 'not_found', 'not_allowed'][index];
        batch.set(entry.item_id, { status, before: structuredClone(item) });
        if (status === 'applied') Object.assign(item, { disposition: name.startsWith('snooze') ? 'snoozed' : 'settled', section: name.startsWith('snooze') ? 'snoozed' : 'settled', snoozed_until: args.until || null, base_version: 'b'.repeat(32) });
      }
      return { item_id: entry.item_id, status, ...(error ? { error } : {}) };
    });
    if (missing && !args.undo_of) { const index = items.findIndex(item => item.item_id === 'c'); if (index >= 0) items.splice(index, 1); }
    const result = { ok: true, schema_version: 'home-inbox-batch.v1', batch_key: args.undo_of || args.idempotency_key, results };
    if (!args.undo_of) batches.set(args.idempotency_key, batch);
    receipts.set(args.idempotency_key, { args: structuredClone(args), result });
    if (lost || undoLost && args.undo_of) { lost = false; undoLost = false; throw Error('Response lost'); }
    return result;
  } };
}
