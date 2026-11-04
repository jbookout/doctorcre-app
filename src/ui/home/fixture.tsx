import { object, parseResults, type Command, type InboxItem } from './inbox';
export function fixtureInboxRpc() {
  const make = (item_id: string, title: string, state: InboxItem['source_state'], disposition: InboxItem['disposition'] = 'inbox'): InboxItem => ({ completed_at: state === 'done' ? new Date().toISOString() : null, auto_settled: false, context_label: 'Demo practice with a long owning deal name', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001', item_id, title, source_type: 'next_action', source_id: item_id, source_version: 'synthetic:1', source_state: state, activity_at: new Date().toISOString(), hold_until: null, unseen: state === 'done', disposition, snoozed_until: disposition === 'snoozed' ? new Date(Date.now() + 3_600_000).toISOString() : null, explicit_unsettle: false, section: disposition !== 'inbox' ? disposition : state === 'done' ? 'done' : state === 'working' ? 'working' : 'inbox', base_version: 'synthetic:1' });
  const items = [make('demo-review', 'Review the practice tour follow-up', 'needs_attention'), make('demo-call', 'Confirm next steps from the pipeline call', 'needs_attention'), make('demo-complete', 'Tour itinerary is ready to review', 'done'), make('demo-working', 'Preparing your market comparison', 'working'), make('demo-snooze', 'Check in with the demo practice', 'needs_attention', 'snoozed'), make('demo-settled', 'Demo call summary reviewed', 'done', 'settled')];
  items.forEach((item, index) => Object.assign(item, { action_id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}` }));
  const receipts = new Map<string, unknown>();
  return async (name: string, args: unknown) => {
    if (name === 'read-home-inbox-v4' || name === 'read-home-inbox-v3') return { ok: true, schema_version: name === 'read-home-inbox-v4' ? 'home-inbox.v4' : 'home-inbox.v3', truncated: false, limit: 1000, items: structuredClone(items).map(item => {
      const auto_settled = item.source_state === 'done' && item.disposition === 'inbox' && !item.explicit_unsettle;
      return { ...item, auto_settled, ...(auto_settled ? { disposition: 'settled', section: 'settled' } : {}) };
    }), working_collapsed: true, auto_settle_enabled: true };
    if (name === 'read-home-inbox-v2') return { ok: true, schema_version: 'home-inbox.v2', truncated: false, limit: 1000, items: structuredClone(items), working_collapsed: true, auto_settle_enabled: false };
    if (name === 'complete-one-action' || name === 'reopen-one-action') {
      if (!object(args)) throw Error('Invalid task request');
      const prior = receipts.get(String(args.idempotency_key)); if (prior) return prior;
      const item = items.find(item => item.action_id === args.action_id);
      if (!item || item.action_version !== args.base_version) throw Object.assign(Error('This task changed.'), { payload: { error: 'version_conflict' } });
      const done = name === 'complete-one-action';
      Object.assign(item, { completed_at: done ? new Date().toISOString() : null, action_version: item.action_version! + 1, source_state: done ? 'done' : 'needs_attention', section: done ? 'done' : item.disposition, base_version: crypto.randomUUID() });
      const receipt = { ok: true, action_id: item.action_id, version: item.action_version, status: done ? 'done' : 'open', completion_event_id: args.completion_event_id || crypto.randomUUID() };
      receipts.set(String(args.idempotency_key), receipt); return receipt;
    }
    const request = { action: name.split('-')[0], args } as Command;
    const prior = receipts.get(request.args.idempotency_key); if (prior) return prior;
    const results = request.args.items.map(({ item_id, base_version }) => {
      const item = items.find(item => item.item_id === item_id);
      if (!item || item.base_version !== base_version) return { item_id, ok: false, error: 'version_conflict', current_version: item?.base_version };
      const next = { ...item, disposition: request.action === 'settle' ? 'settled' : request.action === 'snooze' ? 'snoozed' : 'inbox', snoozed_until: request.action === 'snooze' ? request.args.until : null, explicit_unsettle: request.action === 'unsettle', base_version: crypto.randomUUID() };
      Object.assign(item, next, { section: next.disposition !== 'inbox' ? next.disposition : next.explicit_unsettle ? 'inbox' : item.source_state === 'done' ? 'done' : item.source_state === 'working' ? 'working' : 'inbox' }); return { item_id, ok: true, item: { ...item } };
    });
    const result = { ok: true, schema_version: 'home-inbox-command.v1', results }; parseResults(result, request);
    receipts.set(request.args.idempotency_key, result); return result;
  };
}
