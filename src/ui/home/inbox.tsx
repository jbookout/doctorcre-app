import { parseReference, parseReview, type ReviewReference, type ReviewRequest } from './review';
import { completeAction, parseActionReceipt, type TaskReceipt } from './task-done';
type BaseItem = Readonly<{
  item_id: string; source_type: string; source_id: string; source_version: string;
  source_state: 'working' | 'needs_attention' | 'done' | 'failed'; title: string;
  activity_at: string; hold_until: string | null; unseen: boolean;
  disposition: 'inbox' | 'snoozed' | 'settled'; snoozed_until: string | null;
  explicit_unsettle: boolean; section: 'inbox' | 'working' | 'held' | 'done' | 'snoozed' | 'settled'; base_version: string;
}>;
export type InboxItem = BaseItem & Readonly<{
  auto_settled: boolean; context_label: string | null; due_on: string | null; open_url: string | null;
  kind_label: 'Task' | 'Call follow-up' | 'Call' | 'Reply draft' | 'Update' | 'Fact review' | 'Tour feedback';
  merged_source_ids: string[]; review_reference?: ReviewReference | null;
}> & (Readonly<{ source_type: 'next_action' | 'capture_post_call_action'; action_id: string; action_version: number; deal_id: string | null }> |
  Readonly<{ source_type: 'capture_session' | 'email_proposal' | 'notification' | 'fact_review' | 'tour_feedback'; action_id: null; action_version: null; deal_id: string | null }>);
export type Snapshot = Readonly<{ ok: true; truncated: boolean; limit: 1000; items: InboxItem[]; working_collapsed: true }> & (Readonly<{ schema_version: 'home-inbox.v2'; auto_settle_enabled: false }> | Readonly<{ schema_version: 'home-inbox.v3'; auto_settle_enabled: true }>);
export type Action = 'snooze' | 'settle' | 'unsettle';
type CommandArgs = Readonly<{ idempotency_key: string; items: ReadonlyArray<Pick<InboxItem, 'item_id' | 'base_version'>> }>;
type DispositionCommand = Readonly<{ action: 'snooze'; args: CommandArgs & Readonly<{ until: string }> }> | Readonly<{ action: 'settle' | 'unsettle'; args: CommandArgs }>;
export type { TaskReceipt } from './task-done';
type TaskCommand = Readonly<{ action: 'complete' | 'reopen'; args: CommandArgs & { action_id: string; base_version: number; completion_event_id?: string } }>;
export type Command = DispositionCommand | TaskCommand;
export function taskCommand(action: 'complete' | 'reopen', item: InboxItem, receipt?: TaskReceipt): TaskCommand {
  if (!item.action_id || !item.action_version || (action === 'complete' && item.source_state !== 'needs_attention')) throw Error('This card cannot be marked done.');
  if (action === 'reopen' && (!receipt?.completion_event_id || receipt.action_id !== item.action_id || receipt.status !== 'done')) throw Error("Can't undo this completion. Its original receipt has no completion event.");
  return { action, args: { idempotency_key: crypto.randomUUID(), items: [{ item_id: item.item_id, base_version: item.base_version }], action_id: item.action_id, base_version: action === 'reopen' && receipt ? receipt.version : item.action_version, ...(action === 'reopen' && receipt?.completion_event_id ? { completion_event_id: receipt.completion_event_id } : {}) } };
}

export type ItemResult = { item_id: string; ok: true; item: InboxItem; receipt?: TaskReceipt } | { item_id: string; ok: false; error: string; current_version?: string; current_item?: InboxItem };
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
export function parseItem(value: unknown, v3 = false): InboxItem {
  const legacy = parseBaseItem(value);
  if (!object(value) || !(value.context_label === null || text(value.context_label)) ||
    !(value.due_on === null || day(value.due_on)) || !(value.open_url === null || text(value.open_url)) ||
    !(typeof value.kind_label === 'string' && ['Task', 'Call follow-up', 'Call', 'Reply draft', 'Update', ...(v3 ? ['Fact review', 'Tour feedback'] : [])].includes(value.kind_label)) ||
    !Array.isArray(value.merged_source_ids) || !value.merged_source_ids.every(uuid) ||
    !(value.deal_id === null || uuid(value.deal_id)) ||
    (['capture_session', 'email_proposal'].includes(legacy.source_type) && value.deal_id !== null)) throw Error('Inbox returned unreadable card context. Refresh to try again.');
  const task = legacy.source_type === 'next_action' || legacy.source_type === 'capture_post_call_action';
  if (task ? !uuid(value.action_id) || !Number.isSafeInteger(value.action_version) || typeof value.action_version !== 'number' || value.action_version < 1 || value.action_version > 2147483647 :
    !['capture_session', 'email_proposal', 'notification', ...(v3 ? ['fact_review', 'tour_feedback'] : [])].includes(legacy.source_type) || value.action_id !== null || value.action_version !== null) throw Error('Inbox returned unreadable completion identity. Refresh to try again.');
  if (v3 && (typeof value.auto_settled !== 'boolean' || value.auto_settled && (legacy.section !== 'settled' || legacy.disposition !== 'settled' || legacy.source_state !== 'done' || legacy.explicit_unsettle || !['next_action', 'capture_post_call_action', 'email_proposal', 'fact_review', 'tour_feedback'].includes(legacy.source_type)))) throw Error('Inbox returned unreadable settlement context. Refresh to try again.');
  const reference = v3 ? parseReference(value.review_reference) : null;
  return { ...value, ...(value.review_reference === undefined ? {} : { review_reference: reference && reference.item_id === legacy.item_id && reference.source_version === legacy.source_version ? reference : null }), auto_settled: v3 ? value.auto_settled : false } as InboxItem;
}
export function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.ok !== true || (value.schema_version !== 'home-inbox.v2' && value.schema_version !== 'home-inbox.v3') || !Array.isArray(value.items) || value.items.length > 1000 ||
    typeof value.truncated !== 'boolean' || value.limit !== 1000 || value.working_collapsed !== true || value.auto_settle_enabled !== (value.schema_version === 'home-inbox.v3')) throw Error('Inbox unavailable. The server could not provide the complete inbox.');
  const items = value.items.map(item => parseItem(item, value.schema_version === 'home-inbox.v3'));
  if (new Set(items.map(item => item.item_id)).size !== items.length) throw Error('Inbox returned duplicate items. Refresh to try again.');
  const shared = { ok: true, truncated: value.truncated, limit: 1000, items, working_collapsed: true } as const;
  return value.schema_version === 'home-inbox.v3' ? { ...shared, schema_version: 'home-inbox.v3', auto_settle_enabled: true } : { ...shared, schema_version: 'home-inbox.v2', auto_settle_enabled: false };
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
export type InboxClient = { review?: { current(item: InboxItem): Promise<InboxItem>; load(item: InboxItem, signal?: AbortSignal): Promise<ReturnType<typeof parseReview>>; run(item: InboxItem, request: ReviewRequest): Promise<{ item: InboxItem; receipt?: TaskReceipt; saved_version?: number }> }; read(signal?: AbortSignal): Promise<Snapshot>; run(request: Command): Promise<ItemResult[]> };
export function createInboxClient(rpc: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>): InboxClient {
  async function read(signal?: AbortSignal): Promise<Snapshot> {
    let value: unknown;
    try { value = await rpc('read-home-inbox-v3', {}, signal); }
    catch (error) {
      if (!object(error) || !object(error.payload) || error.payload.error !== 'unknown_tool') throw error;
      value = { error: 'unknown_tool' };
    }
    if (object(value) && value.error === 'unknown_tool') {
      const legacy = await rpc('read-home-inbox-v2', {}, signal);
      if (!object(legacy) || legacy.schema_version !== 'home-inbox.v2') throw Error('Inbox unavailable. The earlier inbox could not be verified.');
      return parseSnapshot(legacy);
    }
    if (!object(value) || value.schema_version !== 'home-inbox.v3') throw Error('Inbox unavailable. Automatic settlement could not be verified.');
    return parseSnapshot(value);
  }
  return {
    read,
    review: {
      async current(item) {
        const current = (await read()).items.find(row => row.item_id === item.item_id);
        if (!current) throw Object.assign(Error('Card no longer available.'), { payload: { error: 'home_review_not_found' } });
        return current;
      },
      async load(item, signal) {
        if (!item.review_reference) throw Error('This card has no inline review.');
        const value = await rpc('read-home-review', { item_id: item.item_id, source_version: item.source_version }, signal);
        if (object(value) && typeof value.error === 'string') throw Object.assign(Error(value.error), { payload: value });
        const detail = parseReview(value, item.review_reference);
        if (detail.operations.some(op => op.verb === 'complete-one-action' ? op.args.action_id !== item.action_id : op.verb === 'resolve-fact-review' ? JSON.stringify([op.args.entity_ref, op.args.fact_key]) !== item.source_id : op.args.proposal_id !== item.source_id)) throw Error('Review source does not match this card.');
        return detail;
      },
      async run(item, request) {
        if (navigator.onLine === false) throw Error('Offline. Nothing was sent.');
        const value = await rpc(request.verb, request.args);
        if (object(value) && typeof value.error === 'string') throw Object.assign(Error(value.error), { payload: value });
        if (!object(value) || value.ok !== true) throw Error('Receipt unavailable.');
        let receipt: TaskReceipt | undefined;
        if (request.verb === 'complete-one-action') {
          if (typeof request.args.action_id !== 'string' || typeof request.args.base_version !== 'number') throw Error('Task identity unavailable.');
          receipt = parseActionReceipt(value, { action_id: request.args.action_id, base_version: request.args.base_version, idempotency_key: request.args.idempotency_key }, 'done');
        } else if (request.verb === 'resolve-fact-review') {
          if (value.schema_version !== 'fact-review.v1' || !object(value.review_receipt) || value.review_receipt.entity_ref !== request.args.entity_ref || value.review_receipt.fact_key !== request.args.fact_key) throw Error('Review receipt unavailable.');
        } else if (value.proposal_id !== item.source_id || !Number.isSafeInteger(value.version) || typeof value.version !== 'number' || typeof request.args.base_version !== 'number' || value.version <= request.args.base_version) throw Error('Draft receipt unavailable.');
        const current = (await read()).items.find(row => row.item_id === item.item_id);
        if (!current) throw Error('Receipt received, but exact card readback is unavailable.');
        return { item: current, ...(request.verb === 'edit-email-draft' && typeof value.version === 'number' ? { saved_version: value.version } : {}), ...(receipt && current.action_id === receipt.action_id && current.action_version === receipt.version && current.source_state === 'done' ? { receipt } : {}) };
      },
    },
    async run(request) {
      if (navigator.onLine === false) throw Error('Offline. No change was sent. Reconnect and retry manually.');
      if (request.action === 'complete' || request.action === 'reopen') {
        const { items, ...args } = request.args;
        const receipt = request.action === 'complete' ? await completeAction({ completeOneAction: args => rpc('complete-one-action', args) }, args) : parseActionReceipt(await rpc('reopen-one-action', args), args, 'open');
        const snapshot = await read();
        const item_id = items[0]!.item_id;
        const item = snapshot.items.find(item => item.item_id === item_id && item.action_id === receipt.action_id);
        if (!item) throw Error('Task receipt confirmed, but readback is unavailable. Retry the same request.');
        if (item.action_version !== receipt.version || item.source_state !== (receipt.status === 'done' ? 'done' : 'needs_attention')) return [{ item_id, ok: false, error: 'intervening_change', current_item: item }];
        return [{ item_id, ok: true, item, receipt }];
      }
      const results = parseResults(await rpc(`${request.action}-home-inbox`, request.args), request);
      if (!results.some(result => result.ok)) return results.flatMap(result => result.ok ? [] : [result]);
      const snapshot = await read();
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
