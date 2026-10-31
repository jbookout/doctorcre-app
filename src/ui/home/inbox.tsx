export type InboxItem = Readonly<{
  item_id: string; source_type: string; source_id: string; source_version: string;
  source_state: 'working' | 'needs_attention' | 'done' | 'failed'; title: string;
  activity_at: string; hold_until: string | null; unseen: boolean;
  disposition: 'inbox' | 'snoozed' | 'settled'; snoozed_until: string | null;
  explicit_unsettle: boolean; section: 'inbox' | 'working' | 'snoozed' | 'settled'; base_version: string;
}>;
export type Snapshot = Readonly<{ ok: true; schema_version: 'home-inbox.v1'; items: InboxItem[]; working_collapsed: true; auto_settle_enabled: false }>;
export type Action = 'snooze' | 'settle' | 'unsettle';
type CommandArgs = Readonly<{ idempotency_key: string; items: ReadonlyArray<Pick<InboxItem, 'item_id' | 'base_version'>> }>;
export type Command = Readonly<{ action: 'snooze'; args: CommandArgs & Readonly<{ until: string }> }> | Readonly<{ action: 'settle' | 'unsettle'; args: CommandArgs }>;
export type ItemResult = { item_id: string; ok: true; item: InboxItem } | { item_id: string; ok: false; error: string; current_version?: string };
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export function parseItem(value: unknown): InboxItem {
  if (!object(value) || !['item_id', 'source_type', 'source_id', 'source_version', 'title', 'section', 'base_version'].every(key => text(value[key])) ||
    !(typeof value.source_state === 'string' && ['working', 'needs_attention', 'done', 'failed'].includes(value.source_state)) ||
    !(typeof value.disposition === 'string' && ['inbox', 'snoozed', 'settled'].includes(value.disposition)) ||
    !(typeof value.section === 'string' && ['inbox', 'working', 'snoozed', 'settled'].includes(value.section)) || !timestamp(value.activity_at) ||
    !(value.hold_until === null || timestamp(value.hold_until)) || !(value.snoozed_until === null || timestamp(value.snoozed_until)) ||
    typeof value.unseen !== 'boolean' || typeof value.explicit_unsettle !== 'boolean') throw Error('Inbox returned an unreadable item. Refresh to try again.');
  return value as InboxItem;
}
export function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.ok !== true || value.schema_version !== 'home-inbox.v1' || !Array.isArray(value.items) || value.items.length > 1000 ||
    value.working_collapsed !== true || value.auto_settle_enabled !== false) throw Error('Inbox unavailable. The server could not provide the complete inbox.');
  const items = value.items.map(parseItem);
  if (new Set(items.map(item => item.item_id)).size !== items.length) throw Error('Inbox returned duplicate items. Refresh to try again.');
  return { ok: true, schema_version: 'home-inbox.v1', items, working_collapsed: true, auto_settle_enabled: false };
}
export function shelves(items: readonly InboxItem[], currentId?: string) {
  const result: { inbox: InboxItem[]; working: InboxItem[]; snoozed: InboxItem[]; settled: InboxItem[]; current: InboxItem | undefined } = { inbox: [], working: [], snoozed: [], settled: [], current: undefined };
  for (const item of [...items].sort((a, b) => Date.parse(b.activity_at) - Date.parse(a.activity_at) || a.item_id.localeCompare(b.item_id))) {
    if (item.item_id === currentId) { result.current = item; continue; }
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
export function parseResults(value: unknown, request: Command): ItemResult[] {
  if (!object(value) || value.ok !== true || value.schema_version !== 'home-inbox-command.v1' || !Array.isArray(value.results)) throw Error('Result uncertain. Retry the same request.');
  const rows = value.results;
  if (rows.some(row => !object(row) || !request.args.items.some(item => item.item_id === row.item_id))) throw Error('Result uncertain. Unexpected items in command response.');
  return request.args.items.map(({ item_id }) => {
    const matches = rows.filter((row: unknown) => object(row) && row.item_id === item_id);
    const row: unknown = matches.length === 1 ? matches[0] : null;
    if (object(row) && row.ok === true) {
      try { const item = parseItem(row.item); if (item.item_id === item_id) return { item_id, ok: true, item }; } catch { /* Preserve an unconfirmed item. */ }
    }
    return { item_id, ok: false, error: object(row) && text(row.error) ? row.error : 'Result uncertain. Retry the same request.', ...(object(row) && text(row.current_version) ? { current_version: row.current_version } : {}) };
  });
}
export type InboxClient = { read(signal?: AbortSignal): Promise<Snapshot>; run(request: Command): Promise<ItemResult[]> };
export function createInboxClient(rpc: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>): InboxClient {
  return {
    read: async signal => parseSnapshot(await rpc('read-home-inbox', {}, signal)),
    async run(request) {
      if (navigator.onLine === false) throw Error('Offline. No change was sent. Reconnect and retry manually.');
      return parseResults(await rpc(`${request.action}-home-inbox`, request.args), request);
    },
  };
}
