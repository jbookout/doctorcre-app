import { parseResults, type Command, type InboxItem } from './inbox';
export function fixtureInboxRpc() {
  const make = (item_id: string, title: string, state: InboxItem['source_state'], disposition: InboxItem['disposition'] = 'inbox'): InboxItem => ({ item_id, title, source_type: 'task', source_id: item_id, source_version: 'synthetic:1', source_state: state, activity_at: new Date().toISOString(), hold_until: null, unseen: state === 'done', disposition, snoozed_until: disposition === 'snoozed' ? new Date(Date.now() + 3_600_000).toISOString() : null, explicit_unsettle: false, section: state === 'working' ? 'working' : disposition, base_version: 'synthetic:1' });
  const items = [make('demo-review', 'Review the practice tour follow-up', 'needs_attention'), make('demo-call', 'Confirm next steps from the pipeline call', 'needs_attention'), make('demo-complete', 'Tour itinerary is ready to review', 'done'), make('demo-working', 'Preparing your market comparison', 'working'), make('demo-snooze', 'Check in with the demo practice', 'needs_attention', 'snoozed'), make('demo-settled', 'Demo call summary reviewed', 'done', 'settled')];
  const receipts = new Map<string, unknown>();
  return async (name: string, args: unknown) => {
    if (name === 'read-home-inbox') return { ok: true, schema_version: 'home-inbox.v1', items: structuredClone(items), working_collapsed: true, auto_settle_enabled: false };
    const request = { action: name.split('-')[0], args } as Command;
    const prior = receipts.get(request.args.idempotency_key); if (prior) return prior;
    const results = request.args.items.map(({ item_id, base_version }) => {
      const item = items.find(item => item.item_id === item_id);
      if (!item || item.base_version !== base_version) return { item_id, ok: false, error: 'version_conflict', current_version: item?.base_version };
      const next = { ...item, disposition: request.action === 'settle' ? 'settled' : request.action === 'snooze' ? 'snoozed' : 'inbox', snoozed_until: request.args.until || null, explicit_unsettle: request.action === 'unsettle', base_version: crypto.randomUUID() };
      Object.assign(item, next); return { item_id, ok: true, item: { ...item } };
    });
    const result = { ok: true, schema_version: 'home-inbox-command.v1', results }; parseResults(result, request);
    receipts.set(request.args.idempotency_key, result); return result;
  };
}
