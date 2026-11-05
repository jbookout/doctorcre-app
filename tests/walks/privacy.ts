import { test as base, type BrowserContext } from '@playwright/test';
import { object, parseSnapshot, type InboxItem } from '../../src/ui/home/inbox';

type Admission = { items: InboxItem[]; verbs: readonly string[] };
const snapshots = new WeakMap<BrowserContext, Promise<InboxItem[]>>();
const admissions = new WeakMap<BrowserContext, Admission>();
export async function inboxItems(context: BrowserContext): Promise<InboxItem[]> {
  return snapshots.get(context) || [];
}
export function admitItems(context: BrowserContext, items: InboxItem[], verbs: readonly string[]): void {
  admissions.set(context, { items, verbs });
}
export function clearAdmission(context: BrowserContext): void { admissions.delete(context); }

export const test = base.extend<{ walkPrivacy: void }>({
  walkPrivacy: [async ({ context }, use, info) => {
    if (info.project.name === 'setup') return use();
    const batches = new Map<string, { verb: string; ids: string[] }>();
    context.on('response', response => {
      const request = response.request();
      if (new URL(response.url()).pathname === '/mcp' && request.method() === 'POST' && /^read-home-inbox-v[2-5]$/.test(request.postDataJSON()?.params?.name || '')) {
        snapshots.set(context, response.json().then(envelope => {
          if (!response.ok() || envelope.result?.isError) return [];
          const value = JSON.parse(envelope.result.content.find((entry: { type: string }) => entry.type === 'text').text);
          return parseSnapshot(value).items;
        }).catch(() => []));
      }
      if (response.status() >= 400) {
        info.annotations.push({ type: 'http-status', description: `${response.request().resourceType()} ${response.status()}` });
      }
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const path = new URL(request.url()).pathname;
      if (path === '/mcp') {
        let params;
        try { params = request.postDataJSON()?.params; } catch { return route.abort('blockedbyclient'); }
        const name: unknown = params?.name;
        const reads = ['deal-room-board', 'morning-brief', 'notification-feed', 'schedule-board', 'email-match-contacts', 'work-request-card', 'work-queue', 'human-actors', 'search-parties'];
        if (typeof name === 'string' && (/^(read-|get-|list-|preview-|search-)/.test(name) || reads.includes(name))) return route.continue();
        const admission = admissions.get(context);
        const args = params?.arguments;
        if (admission && typeof name === 'string' && admission.verbs.includes(name) && object(args) && typeof args.idempotency_key === 'string') {
          const current = await inboxItems(context);
          const owned = admission.items.filter(item => current.some(row => row.item_id === item.item_id && row.deal_id === item.deal_id && row.action_id === item.action_id));
          const batch = typeof args.undo_of === 'string' ? batches.get(args.undo_of) : undefined;
          const ids = ['set-home-waiting', 'clear-home-waiting'].includes(name) ? [args.item_id] : Array.isArray(args.items) ? args.items.map(item => object(item) ? item.item_id : null) : typeof args.item_id === 'string' ? [args.item_id] : typeof args.action_id === 'string' ? owned.filter(item => item.action_id === args.action_id).map(item => item.item_id) : batch?.ids || [];
          const exact = (args.item_id === undefined || owned.some(item => item.item_id === args.item_id)) && (args.deal_id === undefined || owned.some(item => item.deal_id === args.deal_id)) && ids.length > 0 && ids.every(id => owned.some(item => item.item_id === id));
          const action = !['complete-one-action', 'reopen-one-action'].includes(name) || ids.length === 1 && owned.some(item => item.item_id === ids[0] && item.action_id === args.action_id);
          const undo = args.undo_of === undefined || batch?.verb === name && ids.every(id => batch.ids.includes(String(id)));
          if (exact && action && undo) {
            if (args.reversible === true && args.undo_of === undefined) batches.set(args.idempotency_key, { verb: name, ids: ids as string[] });
            return route.continue();
          }
        }
      }
      // Refuse background outbox replay, email submission and unrequested app writes.
      await route.abort('blockedbyclient');
    });
    try { await use(); } finally {
      for (const error of info.errors) {
        for (const key of Object.keys(error)) Reflect.deleteProperty(error, key);
        error.message = 'Walk failed. Private diagnostic text suppressed.';
      }
    }
  }, { auto: true }],
});
