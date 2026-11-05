import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';

type FeedPage = { deals: { deal_id: string; pending_count: number }[]; next_cursor: string | null };
type State = { kind: 'idle' | 'loading' | 'refreshing' | 'unavailable' } | { kind: 'ready'; counts: Map<string, number> };
type ReadPage = (cursor: string | null) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parsePage(value: unknown): FeedPage {
  if (!record(value) || value.ok !== true || value.schema_version !== 'board-tour-proposals.v1' || !Array.isArray(value.deals) || value.deals.length > 100 ||
    !(value.next_cursor === null || typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length <= 2048)) throw Error('invalid_feed');
  const deals = value.deals.map(row => {
    if (!record(row) || typeof row.deal_id !== 'string' || !row.deal_id.trim() || row.deal_id.length > 200 ||
      typeof row.pending_count !== 'number' || !Number.isSafeInteger(row.pending_count) || row.pending_count < 0) throw Error('invalid_count');
    return { deal_id: row.deal_id, pending_count: row.pending_count };
  });
  return { deals, next_cursor: value.next_cursor };
}

export function createBoardProposalBadges({ document: doc, readPage, open }: {
  document: Document; readPage: ReadPage; open(dealId: string, trigger: HTMLButtonElement): Promise<void>;
}) {
  const container = doc.createElement('div'); doc.body.append(container);
  const root = createRoot(container), win = doc.defaultView;
  let state: State = { kind: 'idle' }, generation = 0, busy = false, again = false, retired = false;
  let focusDeal: string | null = null;
  function paint() {
    if (retired) return;
    const current = state;
    flushSync(() => root.render(<>{Array.from(doc.querySelectorAll<HTMLElement>('[data-board-proposal-host]')).map((host, index) => {
      const dealId = host.dataset.boardProposalHost;
      if (!dealId) return null;
      const count = current.kind === 'ready' ? current.counts.get(dealId) ?? 0 : 0;
      const kind = current.kind === 'ready' ? count > 0 ? 'pending' : 'zero' : current.kind;
      return createPortal(<span data-proposal-state={kind}>
        {kind === 'pending' ? <button type="button" className="badge" aria-label={`${count} pending client tours. Open proposal`} onClick={async event => {
          const trigger = event.currentTarget;
          focusDeal = dealId;
          await open(dealId, trigger);
          focusProposal();
        }}>{count} pending client tour{count === 1 ? '' : 's'}</button> :
          <span className={kind === 'unavailable' ? 'muted' : 'sr-only'}>{kind === 'zero' ? 'No pending client tours' : kind === 'unavailable' ? 'Client tour proposals unavailable' : kind === 'loading' || kind === 'refreshing' ? 'Checking client tour proposals' : ''}</span>}
      </span>, host, String(index));
    })}</>));
  }
  function focusProposal() {
    if (!focusDeal || new URL(doc.location.href).searchParams.get('deal') !== focusDeal) return;
    const host = doc.getElementById('workspace-tour-proposals');
    if (!host) return;
    host.tabIndex = -1; host.focus(); host.scrollIntoView({ block: 'nearest' }); focusDeal = null;
  }
  async function refresh() {
    if (retired) return;
    if (busy) { again = true; return; }
    busy = true;
    const ticket = ++generation;
    state = { kind: state.kind === 'idle' ? 'loading' : 'refreshing' }; paint();
    try {
      const counts = new Map<string, number>(), cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 100; ++page) {
        const result = parsePage(await readPage(cursor));
        if (retired || ticket !== generation) return;
        for (const row of result.deals) {
          if (counts.has(row.deal_id)) throw Error('duplicate_deal');
          counts.set(row.deal_id, row.pending_count);
        }
        cursor = result.next_cursor;
        if (cursor === null) { state = { kind: 'ready', counts }; return; }
        if (cursors.has(cursor)) throw Error('repeated_cursor');
        cursors.add(cursor);
      }
      throw Error('page_limit');
    } catch { if (!retired && ticket === generation) state = { kind: 'unavailable' }; }
    finally {
      if (!retired && ticket === generation) { busy = false; paint(); if (again) { again = false; void refresh(); } }
    }
  }
  const holderMarker = (node: Node) => node instanceof Element && (node.matches('[data-tour-proposal-badge]') || !!node.querySelector('[data-tour-proposal-badge]'));
  const observer = new MutationObserver(records => {
    focusProposal();
    // The holder's onPending callback publishes only counts confirmed by its list readback.
    if (!retired && records.some(change => [...change.addedNodes, ...change.removedNodes].some(holderMarker))) void refresh();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  function invalidate() {
    ++generation; busy = false; again = false; focusDeal = null; state = { kind: 'idle' }; paint();
    retired = true; observer.disconnect();
  }
  win?.addEventListener('doctorcre-session-invalidated', invalidate, { once: true });
  return { paint, refresh, dispose() { retired = true; ++generation; observer.disconnect(); win?.removeEventListener('doctorcre-session-invalidated', invalidate); root.unmount(); container.remove(); } };
}

export async function bootBoardProposalBadges(options: { document: Document; open(dealId: string, trigger: HTMLButtonElement): Promise<void> }) {
  const { createMcpRequests } = await import(new URL('./mcp-requests.mjs', import.meta.url).href);
  const request = createMcpRequests();
  return createBoardProposalBadges({ ...options, async readPage(cursor) {
    const result = await request('list-board-tour-proposals', { limit: 100, ...(cursor === null ? {} : { cursor }) }, { timeoutMs: 10000 });
    if (result.kind !== 'payload' || result.isError) throw Error('unavailable');
    return result.payload;
  } });
}
