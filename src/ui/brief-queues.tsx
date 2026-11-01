import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

// React reads `window` while it renders. Each Node test hosts the dialog in
// its own document, so aim those globals at this document before painting.
function useDocumentWindow(node: HTMLElement) {
  const view = node.ownerDocument.defaultView;
  if (!view || globalThis.window === view) return;
  globalThis.window = view;
  globalThis.document = node.ownerDocument;
}

export const briefQueueLabels = {
  today: 'Today queue',
  loops: 'Open loops',
  needs_joe: 'Needs Joe',
  assurance_cadence: 'Assurance alerts',
} as const;
export type BriefQueueName = keyof typeof briefQueueLabels;

const todayKinds = ['next_action', 'post_call_action', 'critical_date', 'ingest'] as const;
type Row = { [key: string]: unknown };
type QueueSection = { state?: string; items: unknown[]; total?: number; total_scope?: string };
type BriefFacts = { sponsor?: unknown; sections: Partial<Record<BriefQueueName, QueueSection>> };
type QueuePage = { total: number; has_more: boolean; total_scope?: string; state?: string };
type ListState = { active: BriefQueueName; items: Row[]; page: QueuePage | null; busy: boolean; error: boolean };

function present(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function textOf(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || !('text' in value)) return undefined;
  return value.text;
}

export function briefQueueIdentity(queue: string, row: Row): string | null {
  if (queue === 'today') {
    const kind = row.item_kind;
    return present(row.id) && typeof kind === 'string' && (todayKinds as readonly string[]).includes(kind) ? `${kind}:${row.id}` : null;
  }
  if (queue === 'loops') return row.kind === 'open_loop' && present(String(row.number ?? '')) ? `open_loop:${String(row.number)}` : null;
  if (queue === 'needs_joe') return present(row.key) && present(row.title) ? JSON.stringify([row.source, row.key, row.title]) : null;
  return present(row.notification_id) ? row.notification_id : null;
}

export function briefQueueTitle(queue: string, row: Row): unknown {
  if (queue === 'today') return row.what || row.subject_name || `${String(row.item_kind)} ${String(row.id)}`;
  if (queue === 'loops') return row.title || row.label || `Open loop ${String(row.number)}`;
  if (queue === 'needs_joe') return row.title || `Decision ${String(row.key)}`;
  return row.reason || `Alert ${String(row.subject_ref || row.notification_id)}`;
}

function coverageLine(section: QueueSection | undefined): string {
  if (!section || !Number.isInteger(section.total)) return 'coverage unknown';
  const scope = section.total_scope === 'available_sources' ? ' from available sources' : '';
  return `${section.items.length} of ${section.total}${scope}`;
}
function statusLine(section: QueueSection | undefined): string {
  if (section?.state === 'partial') return ' · Some sources are unavailable';
  if (section?.state === 'unavailable') return ' · Unavailable';
  return '';
}
function factEntries(queue: string, row: Row): [string, unknown][] {
  if (queue === 'today') return [['Subject', row.subject_name || row.subject_ref], ['Kind', row.item_kind], ['Due', row.due_on], ['Owner', row.owner_partner || row.owner]];
  if (queue === 'loops') return [['Due', row.due_on], ['Owner', row.owner_partner || row.owner], ['Blocker', row.blocker_detail]];
  if (queue === 'needs_joe') return [['Why', textOf(row.why)], ['Action', row.action], ['Blocks', textOf(row.blocks)], ['Since', row.since]];
  return [['Severity', row.severity], ['Subject', row.subject_ref], ['Created', row.created_at]];
}

function QueueMenu({ facts, active }: { facts: BriefFacts | null; active: BriefQueueName | null }) {
  if (!facts) return null;
  const queues = (Object.keys(briefQueueLabels) as BriefQueueName[]).filter(queue => queue !== 'needs_joe' || facts.sponsor === 'joe');
  if (active && queues.includes(active)) return <label className="morning-queue-switch">
    <select data-brief-queue-switch="" aria-label="Work queue" defaultValue={active} key={active}>
      {queues.map(queue => <option key={queue} value={queue}>{briefQueueLabels[queue]}</option>)}
    </select>
  </label>;
  return <>
    <p>Selected priorities. Open a queue for all eligible work.</p>
    {queues.map(queue => {
      const section = facts.sections[queue];
      return <button key={queue} type="button" data-brief-queue={queue}>{`${briefQueueLabels[queue]} · ${coverageLine(section)}${statusLine(section)}`}</button>;
    })}
  </>;
}
function QueueList({ active, items, page, busy, error }: ListState) {
  const status = [busy ? 'Updating…' : '', error ? 'Queue update unavailable; retry to continue.' : ''].filter(Boolean).join(' · ');
  return <section className="morning-queue">
    {status ? <p role="status">{status}</p> : null}
    {page?.state === 'partial' ? <p>Some sources are unavailable. This list may be incomplete.</p> : null}
    <p>Urgency order. Refresh for a new list.</p>
    <ol>{items.map(row => {
      const id = briefQueueIdentity(active, row);
      const title = briefQueueTitle(active, row);
      if (!present(id) || !present(title)) return null;
      return <li key={id} data-queue-item={id}><details><summary>{title}</summary><dl>{factEntries(active, row).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></details></li>;
    })}</ol>
    {!page || page.has_more ? <button type="button" data-brief-queue-more="" disabled={busy}>{error ? 'Retry queue' : page ? 'Load more' : 'Load queue'}</button> : null}
    <button type="button" data-brief-queue-back="">Back to priorities</button>
  </section>;
}

export function createBriefQueueView(menu: HTMLElement, content: HTMLElement) {
  let menuRoot: Root | null = null;
  let listRoot: Root | null = null;
  const paint = (node: HTMLElement, current: Root | null, render: () => ReactNode) => {
    useDocumentWindow(node);
    const root = current ?? createRoot(node);
    flushSync(() => root.render(render()));
    return root;
  };
  return {
    renderMenu(facts: BriefFacts | null, active: BriefQueueName | null = null) { menuRoot = paint(menu, menuRoot, () => <QueueMenu facts={facts} active={active} />); },
    renderList(state: ListState) { listRoot = paint(content, listRoot, () => <QueueList {...state} />); },
    clearList() {
      if (!listRoot) return;
      useDocumentWindow(content);
      flushSync(() => listRoot?.unmount());
      listRoot = null;
    },
    dispose() {
      if (listRoot) { useDocumentWindow(content); flushSync(() => listRoot?.unmount()); listRoot = null; }
      if (menuRoot) { useDocumentWindow(menu); flushSync(() => menuRoot?.unmount()); menuRoot = null; }
    },
  };
}
