import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, shelves, type Action, type Command, type InboxClient, type InboxItem, type ItemResult, type Snapshot } from './inbox';
import { recordRoutes } from './routes';

type Pending = { request: Command; before: readonly InboxItem[]; undoing?: true };
type Undo = { action: Action; items: readonly InboxItem[]; until?: string };
const queryKey = ['home-inbox'];
const message = (error: unknown) => error instanceof Error ? error.message : 'Result uncertain. Retry the same request.';
function Inbox({ client }: { client: InboxClient }) {
  const { item_id } = useParams();
  const cache = useQueryClient();
  const query = useQuery({ queryKey, queryFn: ({ signal }) => client.read(signal) });
  const [scope, setScope] = useState('all');
  const [selected, select] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failures, setFailures] = useState<ItemResult[]>([]);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [snooze, setSnooze] = useState<readonly InboxItem[] | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    // eslint-disable-next-line no-restricted-syntax -- Online callback updates React connectivity state once per event; zero refetches.
    addEventListener('online', update); addEventListener('offline', update);
    return () => { removeEventListener('online', update); removeEventListener('offline', update); };
  }, []);
  function focusRow() {
    // eslint-disable-next-line no-restricted-syntax -- One frame focuses the first visible inbox row per keyboard navigation action; zero reads.
    requestAnimationFrame(() => {
      const target = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-inbox-row] h3 a, summary') || []).find(node => node.getClientRects().length);
      target?.focus();
    });
  }
  async function run(operation: Pending) {
    if (inFlight.current) return;
    if (!navigator.onLine) { setNotice('Offline. No change was sent. Reconnect and retry manually.'); return; }
    inFlight.current = true; setBusy(true); setPending(operation); setNotice('Waiting for server confirmation…');
    try {
      const results = await client.run(operation.request);
      const successes = results.flatMap(result => result.ok ? [result.item] : []);
      const failed = results.filter(result => !result.ok);
      cache.setQueryData<Snapshot>(queryKey, snapshot => snapshot ? { ...snapshot, items: snapshot.items.map(item => successes.find(next => next.item_id === item.item_id) || item) } : snapshot, { updatedAt: query.dataUpdatedAt });
      setFailures(failed);
      select(new Set(failed.map(result => result.item_id)));
      if (successes.length && !operation.undoing) {
        setUndo(successes.flatMap(item => {
          const previous = operation.before.find(before => before.item_id === item.item_id);
          return previous ? [{ action: previous.disposition === 'settled' ? 'settle' : previous.disposition === 'snoozed' ? 'snooze' : 'unsettle', items: [item], ...(previous.snoozed_until ? { until: previous.snoozed_until } : {}) }] : [];
        }));
      }
      setNotice(`${successes.length} confirmed. ${failed.length ? `${failed.length} failed or uncertain. Kept for review.` : operation.undoing ? 'Undone.' : 'You can undo this change.'}`);
      if (!failed.length) setPending(null);
      focusRow();
    } catch (error) { setNotice(`Result uncertain. ${message(error)} Retry the same request.`); }
    finally { setBusy(false); inFlight.current = false; }
  }
  function act(action: Action, items: readonly InboxItem[], until?: string, undoing = false) {
    if (pending) { setNotice('Resolve or dismiss the previous request before starting another.'); return; }
    try { void run({ request: command(action, items, until), before: items, ...(undoing ? { undoing: true as const } : {}) }); }
    catch (error) { setNotice(message(error)); }
  }
  const items = query.data?.items || [];
  const placed = shelves(scope === 'unseen' ? items.filter(item => item.unseen || item.item_id === item_id) : items, item_id);
  const picked = items.filter(item => selected.has(item.item_id));
  function row(item: InboxItem) {
    const primary = item.disposition === 'settled' ? 'Un-settle' : item.disposition === 'snoozed' ? 'Wake' : 'Settle';
    return <article key={item.item_id} className="inbox-row" data-inbox-row={item.item_id}
      onTouchStart={event => { const touch = event.touches[0]; if (touch) gesture.current = { x: touch.clientX, y: touch.clientY }; }}
      onTouchEnd={event => {
        const touch = event.changedTouches[0], start = gesture.current; gesture.current = null;
        if (!touch || !start || Math.abs(touch.clientY - start.y) > 45 || Math.abs(touch.clientX - start.x) < 90 || busy) return;
        if (touch.clientX > start.x) act(primary === 'Settle' ? 'settle' : 'unsettle', [item]);
        else setSnooze([item]);
      }}>
      <label className="inbox-select"><input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.has(item.item_id)} disabled={busy}
        onChange={event => select(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.item_id); else next.delete(item.item_id); return next; })} /></label>
      <div className="inbox-copy"><p className="inbox-meta"><span>{item.source_type.replaceAll('_', ' ')}</span><span className={`inbox-badge inbox-${item.source_state}`}>{item.source_state === 'done' ? `Done${item.unseen ? ' · Unseen' : ''}` : item.source_state.replaceAll('_', ' ')}</span></p>
        <h3><Link to={recordRoutes.card(item.item_id)}>{item.title}</Link></h3>
        <p className="inbox-detail">{item.disposition === 'snoozed' && item.snoozed_until ? `Snoozed until ${new Date(item.snoozed_until).toLocaleString()}` : item.disposition === 'settled' ? 'Settled by you' : item.source_state === 'working' ? 'Dr. CRE is working. You can come back to this.' : 'Ready for your attention'}{item.hold_until ? ` · On hold until ${item.hold_until}` : ''}</p>
        {item_id === item.item_id && recordRoutes.source(item) && <a className="inbox-source" href={recordRoutes.source(item) || undefined}>Open source record ↗</a>}
      </div>
      <div className="inbox-actions"><button type="button" disabled={busy} onClick={() => act(primary === 'Settle' ? 'settle' : 'unsettle', [item])}>{primary}</button><button type="button" disabled={busy} onClick={() => setSnooze([item])}>Snooze</button></div>
    </article>;
  }
  return <div ref={root} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches('[data-inbox-row] h3 a')) return;
    const links = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-inbox-row] h3 a') || []).filter(link => link.getClientRects().length);
    const index = links.indexOf(event.target); const next = links[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  }}>
    <header className="inbox-header"><div><p className="inbox-eyebrow">YOUR WORKSPACE</p><h1>Inbox</h1><p>Your attention, updates and work in progress.</p></div><button type="button" disabled={query.isFetching || busy || !!pending || !online} onClick={() => void query.refetch()}>Refresh inbox</button></header>
    <div className="inbox-health" role="status">{!online ? 'Offline · Inbox changes unavailable. Nothing will replay automatically.' : query.isFetching ? 'Updating inbox…' : query.isError ? 'Update unavailable' : query.isStale ? 'Snapshot may be stale · Refresh before acting.' : 'Up to date'}<span>Partner inbox</span></div>
    {notice && <div className="inbox-notice" role="status"><p>{notice}</p>{failures.map(result => !result.ok && <p key={result.item_id}>{items.find(item => item.item_id === result.item_id)?.title || result.item_id} · {result.error === 'version_conflict' ? 'This card changed on the server. Dismiss and refresh before another action.' : result.error}</p>)}
      {pending && <><button disabled={busy || !online} onClick={() => void run(pending)}>Retry same request</button><button disabled={busy} onClick={() => { setPending(null); setFailures([]); setNotice('Request dismissed. Refresh to check canonical state before another action.'); void query.refetch(); }}>Dismiss and refresh</button></>}
      {!pending && undo.map(previous => <button key={previous.items[0]?.item_id} disabled={busy} onClick={() => { setUndo(entries => entries.filter(entry => entry !== previous)); act(previous.action, previous.items, previous.until, true); }}>{undo.length === 1 ? 'Undo' : `Undo ${previous.items[0]?.title}`}</button>)}
    </div>}
    {query.isPending ? <p className="inbox-empty" role="status">Loading your inbox…</p> : query.isError ? <div className="inbox-empty" role="alert"><h2>Inbox unavailable</h2><p>{message(query.error)}</p><p>Refresh to try again.</p></div> : <>
      {item_id && <section className="inbox-section"><div className="inbox-section-title"><h2>Current card</h2><Link to={recordRoutes.inbox()}>Back to inbox</Link></div>{placed.current ? row(placed.current) : <p role="status">This card is not in your current inbox snapshot.</p>}</section>}
      <div className="inbox-filters" role="group" aria-label="Inbox scope"><button data-scope="all" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All cards</button><button data-scope="mine" aria-pressed={scope === 'unseen'} onClick={() => setScope('unseen')}>Unseen</button></div>
      <section className="inbox-section" aria-label="Inbox"><div className="inbox-section-title"><h2>Needs your attention <span>{placed.inbox.length}</span></h2><p>Done means finished work. Settle when you’re ready.</p></div>
        {placed.inbox.length ? placed.inbox.map(row) : <div className="inbox-empty"><h3>You’re all caught up.</h3><p>New work will appear here. Your shelves stay below.</p></div>}</section>
      {(['working', 'snoozed', 'settled'] as const).map(shelf => <details className="inbox-shelf" key={shelf}><summary><span>{shelf === 'working' ? 'Dr. CRE is working' : shelf === 'snoozed' ? 'Snoozed' : 'Settled'}</span><span>{placed[shelf].length}</span></summary>{placed[shelf].length ? placed[shelf].map(row) : <p className="inbox-shelf-empty">Nothing here right now.</p>}</details>)}
    </>}
    {picked.length > 0 && <div className="inbox-bulk" aria-label="Selected cards"><strong>{picked.length} selected</strong><button disabled={busy || picked.length > 100} onClick={() => act('settle', picked)}>Settle selected</button><button disabled={busy || picked.length > 100} onClick={() => act('unsettle', picked)}>Un-settle selected</button><button disabled={busy || picked.length > 100} onClick={() => setSnooze(picked)}>Snooze selected</button><button onClick={() => select(new Set())}>Clear</button></div>}
    {snooze && <dialog className="inbox-snooze" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => { setSnooze(null); focusRow(); }} aria-label="Snooze cards"><h2>Snooze {snooze.length === 1 ? 'card' : `${snooze.length} cards`}</h2><p>Return this to your inbox later.</p>{[1, 24].map(hours => <button autoFocus={hours === 1} key={hours} onClick={() => { const rows = snooze; setSnooze(null); act('snooze', rows, new Date(Date.now() + hours * 3_600_000).toISOString()); }}>{hours === 1 ? '1 hour' : '24 hours'}</button>)}<button onClick={() => { setSnooze(null); focusRow(); }}>Cancel</button></dialog>}
    <footer className="inbox-footer">Use ↑ ↓ to move between cards. On your phone, swipe right to settle or wake, left to snooze.</footer>
  </div>;
}
export function mountInbox(host: HTMLElement, client: InboxClient) {
  // eslint-disable-next-line no-restricted-syntax -- Inbox queries and mutations set retry=false, with focus/reconnect refetch disabled; zero automatic retries.
  const query = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: 'always' }, mutations: { retry: false, networkMode: 'always' } } });
  const root = createRoot(host);
  const inbox: ReactNode = <Inbox client={client} />;
  root.render(<QueryClientProvider client={query}><BrowserRouter><Routes><Route path="/inbox" element={inbox} /><Route path="/inbox.html" element={inbox} /><Route path="/inbox/card/:item_id" element={inbox} /></Routes></BrowserRouter></QueryClientProvider>);
  addEventListener('doctorcre-session-invalidated', () => { query.clear(); root.unmount(); }, { once: true });
}
