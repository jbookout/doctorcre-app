type BaseItem = Readonly<{
  item_id: string; source_type: string; source_id: string; source_version: string;
  source_state: 'working' | 'needs_attention' | 'done' | 'failed'; title: string;
  activity_at: string; hold_until: string | null; unseen: boolean;
  disposition: 'inbox' | 'snoozed' | 'settled'; snoozed_until: string | null;
  explicit_unsettle: boolean; section: 'inbox' | 'working' | 'held' | 'done' | 'snoozed' | 'settled'; base_version: string;
}>;
export type InboxItem = BaseItem & Readonly<{
  context_label: string | null; due_on: string | null; open_url: string | null;
  kind_label: 'Task' | 'Call follow-up' | 'Call' | 'Reply draft' | 'Update';
  merged_source_ids: string[];
}> & (Readonly<{ source_type: 'next_action' | 'capture_post_call_action'; action_id: string; action_version: number; deal_id: string | null }> |
  Readonly<{ source_type: 'capture_session' | 'email_proposal' | 'notification'; action_id: null; action_version: null; deal_id: string | null }>);
export type Snapshot = Readonly<{ ok: true; schema_version: 'home-inbox.v2'; truncated: boolean; limit: 1000; items: InboxItem[]; working_collapsed: true; auto_settle_enabled: false }>;
export type Action = 'snooze' | 'settle' | 'unsettle';
type CommandArgs = Readonly<{ idempotency_key: string; items: ReadonlyArray<Pick<InboxItem, 'item_id' | 'base_version'>> }>;
export type Command = Readonly<{ action: 'snooze'; args: CommandArgs & Readonly<{ until: string }> }> | Readonly<{ action: 'settle' | 'unsettle'; args: CommandArgs }>;
export type ItemResult = { item_id: string; ok: true; item: InboxItem } | { item_id: string; ok: false; error: string; current_version?: string; current_item?: InboxItem };
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
function parseBaseItem(value: unknown): BaseItem {
  if (!object(value) || !['item_id', 'source_type', 'source_id', 'source_version', 'title', 'section', 'base_version'].every(key => text(value[key])) ||
    !(typeof value.source_state === 'string' && ['working', 'needs_attention', 'done', 'failed'].includes(value.source_state)) ||
    !(typeof value.disposition === 'string' && ['inbox', 'snoozed', 'settled'].includes(value.disposition)) ||
    !(typeof value.section === 'string' && ['inbox', 'working', 'held', 'done', 'snoozed', 'settled'].includes(value.section)) || !timestamp(value.activity_at) ||
    !(value.hold_until === null || timestamp(value.hold_until)) || !(value.snoozed_until === null || timestamp(value.snoozed_until)) ||
    typeof value.unseen !== 'boolean' || typeof value.explicit_unsettle !== 'boolean') throw Error('Inbox returned an unreadable item. Refresh to try again.');
  return value as BaseItem;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function parseItem(value: unknown): InboxItem {
  const legacy = parseBaseItem(value);
  if (!object(value) || !(value.context_label === null || text(value.context_label)) ||
    !(value.due_on === null || day(value.due_on)) || !(value.open_url === null || text(value.open_url)) ||
    !(typeof value.kind_label === 'string' && ['Task', 'Call follow-up', 'Call', 'Reply draft', 'Update'].includes(value.kind_label)) ||
    !Array.isArray(value.merged_source_ids) || !value.merged_source_ids.every(uuid) ||
    !(value.deal_id === null || uuid(value.deal_id)) ||
    (['capture_session', 'email_proposal'].includes(legacy.source_type) && value.deal_id !== null)) throw Error('Inbox returned unreadable card context. Refresh to try again.');
  const task = legacy.source_type === 'next_action' || legacy.source_type === 'capture_post_call_action';
  if (task ? !uuid(value.action_id) || !Number.isSafeInteger(value.action_version) || typeof value.action_version !== 'number' || value.action_version < 1 || value.action_version > 2147483647 :
    !['capture_session', 'email_proposal', 'notification'].includes(legacy.source_type) || value.action_id !== null || value.action_version !== null) throw Error('Inbox returned unreadable completion identity. Refresh to try again.');
  return value as InboxItem;
}
export function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.ok !== true || value.schema_version !== 'home-inbox.v2' || !Array.isArray(value.items) || value.items.length > 1000 ||
    typeof value.truncated !== 'boolean' || value.limit !== 1000 || value.working_collapsed !== true || value.auto_settle_enabled !== false) throw Error('Inbox unavailable. The server could not provide the complete inbox.');
  const items = value.items.map(parseItem);
  if (new Set(items.map(item => item.item_id)).size !== items.length) throw Error('Inbox returned duplicate items. Refresh to try again.');
  return { ok: true, schema_version: 'home-inbox.v2', truncated: value.truncated, limit: 1000, items, working_collapsed: true, auto_settle_enabled: false };
}
export function shelves(items: readonly InboxItem[], currentId?: string) {
  const result: { inbox: InboxItem[]; working: InboxItem[]; held: InboxItem[]; done: InboxItem[]; snoozed: InboxItem[]; settled: InboxItem[]; current: InboxItem | undefined } = { inbox: [], working: [], held: [], done: [], snoozed: [], settled: [], current: undefined };
  for (const item of [...items].sort((a, b) => Date.parse(b.activity_at) - Date.parse(a.activity_at) || a.item_id.localeCompare(b.item_id))) {
    if (item.item_id === currentId) result.current = item;
    result[item.section].push(item);
  }
  return result;
}
export function command(action: Action, items: readonly InboxItem[], until?: string): Command {
  if (!items.length || items.length > 100 || new Set(items.map(item => item.item_id)).size !== items.length) throw Error('Select between 1 and 100 distinct cards.');
  if (action === 'snooze' && (!until || Date.parse(until) <= Date.now() || !timestamp(until))) throw Error('Choose a future snooze time.');
  const args = { idempotency_key: crypto.randomUUID(), items: items.map(({ item_id, base_version }) => ({ item_id, base_version })) };
  if (action === 'snooze') {
    if (!until) throw Error('Choose a future snooze time.');
    return { action, args: { ...args, until } };
  }
  return { action, args };
}
export function parseResults(value: unknown, request: Command): Array<{ item_id: string; ok: true; item: BaseItem } | Extract<ItemResult, { ok: false }>> {
  if (!object(value) || value.ok !== true || value.schema_version !== 'home-inbox-command.v1' || !Array.isArray(value.results)) throw Error('Result uncertain. Retry the same request.');
  const rows = value.results;
  if (rows.some(row => !object(row) || !request.args.items.some(item => item.item_id === row.item_id))) throw Error('Result uncertain. Unexpected items in command response.');
  return request.args.items.map(({ item_id }) => {
    const matches = rows.filter((row: unknown) => object(row) && row.item_id === item_id);
    const row: unknown = matches.length === 1 ? matches[0] : null;
    if (object(row) && row.ok === true) {
      try { const item = parseBaseItem(row.item); if (item.item_id === item_id) return { item_id, ok: true, item }; } catch { /* Preserve an unconfirmed item. */ }
    }
    return { item_id, ok: false, error: object(row) && text(row.error) ? row.error : 'Result uncertain. Retry the same request.', ...(object(row) && text(row.current_version) ? { current_version: row.current_version } : {}) };
  });
}
export type InboxClient = { read(signal?: AbortSignal): Promise<Snapshot>; run(request: Command): Promise<ItemResult[]> };
export function createInboxClient(rpc: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>): InboxClient {
  return {
    read: async signal => parseSnapshot(await rpc('read-home-inbox-v2', {}, signal)),
    async run(request) {
      if (navigator.onLine === false) throw Error('Offline. No change was sent. Reconnect and retry manually.');
      const results = parseResults(await rpc(`${request.action}-home-inbox`, request.args), request);
      if (!results.some(result => result.ok)) return results.flatMap(result => result.ok ? [] : [result]);
      const snapshot = parseSnapshot(await rpc('read-home-inbox-v2', {}));
      return results.map(result => {
        if (!result.ok) return result;
        const item = snapshot.items.find(item => item.item_id === result.item_id);
        if (!item) return { item_id: result.item_id, ok: false, error: 'Confirmed change, but card readback is unavailable. Refresh to check its state.' };
        if (item.base_version !== result.item.base_version) return { item_id: result.item_id, ok: false, error: 'intervening_change', current_item: item };
        return { item_id: result.item_id, ok: true, item: { ...item, base_version: result.item.base_version } };
      });
    },
  };
}
