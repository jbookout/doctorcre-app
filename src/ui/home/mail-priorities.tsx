import { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readMailPriorities, takeEarlyMailPriorities, type MailPage } from './mail-priorities-client';
import type { InboxItem } from './inbox';
type State = { kind: 'collapsed' | 'loading' | 'unavailable' | 'auth-retired' } | { kind: 'ready' | 'empty'; page: MailPage; pageOffset: number };
type Props = { items: readonly InboxItem[]; review(item: InboxItem, opener: HTMLButtonElement): void; locked?: boolean; read?: typeof readMailPriorities };
export function MailPriorities({ items, review, locked = false, read = readMailPriorities }: Props) {
  const [early] = useState(takeEarlyMailPriorities);
  const fromOutcome = (outcome: { page?: MailPage; error?: unknown }): State => {
    if (outcome.page) return outcome.page.state === 'unavailable' ? { kind: 'unavailable' } : { kind: outcome.page.state === 'empty' ? 'empty' : 'ready', page: outcome.page, pageOffset: 0 };
    const error = outcome.error;
    const denied = error && typeof error === 'object' && (('status' in error && [401, 403].includes(Number(error.status))) || ('code' in error && error.code === 'session_changed'));
    return { kind: denied ? 'auth-retired' : 'unavailable' };
  };
  const [state, setState] = useState<State>(() => early?.stopped ? { kind: early.stopped } : early?.outcome ? fromOutcome(early.outcome) : { kind: 'loading' });
  const bodyId = useId();
  const life = useRef<{ retired: boolean; disposed: boolean; pending: AbortController | null }>({ retired: state.kind === 'auth-retired', disposed: false, pending: null });
  useEffect(() => {
    const current = life.current;
    current.disposed = false;
    const retire = () => { current.retired = true; current.pending?.abort(); setState({ kind: 'auth-retired' }); };
    const hide = () => collapse();
    const visibility = () => { if (document.hidden) collapse(); };
    addEventListener('pagehide', hide);
    // eslint-disable-next-line no-restricted-syntax -- Hiding aborts the single limit=25 read; visibility never starts a read.
    document.addEventListener('visibilitychange', visibility);
    addEventListener('doctorcre-session-invalidated', retire);
    early?.detach();
    if (early?.stopped) { current.retired = early.stopped === 'auth-retired'; setState({ kind: early.stopped }); }
    else if (early?.outcome) { const next = fromOutcome(early.outcome); current.retired = next.kind === 'auth-retired'; setState(next); }
    else void load(early);
    return () => { current.disposed = true; current.pending?.abort(); current.pending = null; removeEventListener('doctorcre-session-invalidated', retire); removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  function collapse() {
    const current = life.current;
    const pending = current.pending; current.pending = null; pending?.abort();
    if (!current.disposed && !current.retired) setState({ kind: 'collapsed' });
  }
  async function load(initial?: typeof early) {
    const current = life.current;
    if (current.disposed || current.retired || current.pending) return;
    const controller = initial?.controller || new AbortController(); current.pending = controller;
    setState({ kind: 'loading' });
    try {
      const outcome = initial ? await initial.result : { page: await read(controller.signal) };
      if ('error' in outcome) throw outcome.error;
      const page = outcome.page;
      if (current.disposed || current.retired || current.pending !== controller) return;
      setState(page.state === 'unavailable' ? { kind: 'unavailable' } : { kind: page.state === 'empty' ? 'empty' : 'ready', page, pageOffset: 0 });
    } catch (error) {
      if (current.disposed || current.retired || current.pending !== controller) return;
      const next = fromOutcome({ error });
      if (next.kind === 'auth-retired') current.retired = true;
      setState(next);
    } finally { if (current.pending === controller) current.pending = null; }
  }
  return <section className="home-panel" aria-label="Mail priorities" aria-busy={state.kind === 'loading'}>
    <h2>Mail priorities</h2>
    {state.kind !== 'auth-retired' && <button type="button" disabled={locked} aria-expanded={state.kind !== 'collapsed'} aria-controls={bodyId} onClick={() => state.kind === 'collapsed' ? void load() : collapse()}>{state.kind === 'collapsed' ? 'Show mail priorities' : 'Hide mail priorities'}</button>}
    <div id={bodyId} hidden={state.kind === 'collapsed'}>
      {state.kind === 'loading' && <p role="status">Loading mail priorities…</p>}
      {state.kind === 'auth-retired' && <p role="status">Sign in to view mail priorities.</p>}
      {state.kind === 'unavailable' && <><p role="status">Mail priorities unavailable.</p><button type="button" onClick={() => void load()}>Retry mail priorities</button></>}
      {'page' in state && <>
        <p>Mailbox {state.page.coverage.mailbox} · Recorded inbound pending proposals · As of {state.page.coverage.as_of_day} · Recorded next date in UTC</p>
        {state.kind === 'empty' && <p role="status">No recorded pending mail decisions.</p>}
        {state.page.more && <p>Only the first 25 ranked decisions are shown.</p>}
        {state.page.items.length > 0 && <nav aria-label="Mail pages">
          <p data-mail-range aria-live="polite">Decisions {state.pageOffset + 1}–{Math.min(state.pageOffset + 5, state.page.items.length)} of {state.page.items.length} loaded</p>
          <button type="button" disabled={locked || state.pageOffset === 0} onClick={() => { if (!locked) setState({ ...state, pageOffset: Math.max(0, state.pageOffset - 5) }); }}>Previous mail</button>
          <button type="button" disabled={locked || state.pageOffset + 5 >= state.page.items.length} onClick={() => { if (!locked) setState({ ...state, pageOffset: Math.min(state.pageOffset + 5, Math.floor((state.page.items.length - 1) / 5) * 5) }); }}>Next mail</button>
        </nav>}
        <ol start={state.pageOffset + 1}>{state.page.items.slice(state.pageOffset, state.pageOffset + 5).map(row => {
          const matched = items.find(item => item.source_type === 'email_proposal' && item.source_id === row.proposal_id);
          return <li key={row.proposal_id} data-mail-proposal={row.proposal_id} style={{ overflowWrap: 'anywhere' }}>
            <h3>{matched?.title || row.kindLabel}</h3><p>{row.reasonLabel} · {row.decision_date ? <time dateTime={row.decision_date}>{row.decision_date}</time> : 'Decision date unknown'}</p>
            <p>Source time {row.occurred_at ? <time dateTime={row.occurred_at}>{row.occurred_at}</time> : 'unknown'}</p>
            {matched?.review_reference ? <button type="button" disabled={locked} onClick={event => review(matched, event.currentTarget)}>Review {matched.title}</button> : <a href={matched ? `/?card=${encodeURIComponent(matched.item_id)}` : '/inbox'}>Review in inbox</a>}
          </li>;
        })}</ol>
        <button type="button" disabled={locked} onClick={() => void load()}>Refresh mail priorities</button>
      </>}
    </div>
  </section>;
}
export function mountMailPriorities(host: HTMLElement, props: Props) {
  const root = createRoot(host); root.render(<MailPriorities {...props} />);
  return { dispose() { root.unmount(); } };
}

export { parseMailPage } from "./mail-priorities-client";
