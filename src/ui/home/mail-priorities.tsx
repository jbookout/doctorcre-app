import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readMailPriorities, type MailPage } from './mail-priorities-client';
import type { InboxItem } from './inbox';
type State = { kind: 'idle' | 'loading' | 'unavailable' | 'auth-retired' } | { kind: 'ready' | 'empty'; page: MailPage };
type Props = { items: readonly InboxItem[]; review(item: InboxItem, opener: HTMLButtonElement): void; locked?: boolean; read?: typeof readMailPriorities };
export function MailPriorities({ items, review, locked = false, read = readMailPriorities }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const life = useRef<{ retired: boolean; disposed: boolean; pending: AbortController | null }>({ retired: false, disposed: false, pending: null });
  useEffect(() => {
    const current = life.current;
    current.disposed = false;
    const retire = () => { current.retired = true; current.pending?.abort(); setState({ kind: 'auth-retired' }); };
    addEventListener('doctorcre-session-invalidated', retire);
    return () => { current.disposed = true; current.pending?.abort(); removeEventListener('doctorcre-session-invalidated', retire); };
  }, []);
  async function load() {
    const current = life.current;
    if (current.disposed || current.retired || current.pending) return;
    const controller = new AbortController(); current.pending = controller;
    setState({ kind: 'loading' });
    try {
      const page = await read(controller.signal);
      if (current.disposed || current.retired || current.pending !== controller) return;
      setState(page.state === 'unavailable' ? { kind: 'unavailable' } : { kind: page.state === 'empty' ? 'empty' : 'ready', page });
    } catch (error) {
      if (current.disposed || current.retired || current.pending !== controller) return;
      const denied = error && typeof error === 'object' && (('status' in error && [401, 403].includes(Number(error.status))) || ('code' in error && error.code === 'session_changed'));
      if (denied) current.retired = true;
      setState({ kind: denied ? 'auth-retired' : 'unavailable' });
    } finally { if (current.pending === controller) current.pending = null; }
  }
  return <section className="home-panel" aria-label="Mail priorities" aria-busy={state.kind === 'loading'}>
    <h2>Mail priorities</h2>
    {state.kind === 'idle' && <button type="button" onClick={() => void load()}>Show mail priorities</button>}
    {state.kind === 'loading' && <p role="status">Loading mail priorities…</p>}
    {state.kind === 'auth-retired' && <p role="status">Sign in to view mail priorities.</p>}
    {state.kind === 'unavailable' && <><p role="status">Mail priorities unavailable.</p><button type="button" onClick={() => void load()}>Retry mail priorities</button></>}
    {'page' in state && <>
      <p>Mailbox {state.page.coverage.mailbox} · Recorded inbound pending proposals · As of {state.page.coverage.as_of_day} · Recorded next date in UTC</p>
      {state.kind === 'empty' && <p role="status">No recorded pending mail decisions.</p>}
      {state.page.more && <p>Only the first 25 ranked decisions are shown.</p>}
      <ol>{state.page.items.map(row => {
        const matched = items.find(item => item.source_type === 'email_proposal' && item.source_id === row.proposal_id);
        return <li key={row.proposal_id} data-mail-proposal={row.proposal_id} style={{ overflowWrap: 'anywhere' }}>
          <h3>{matched?.title || row.kindLabel}</h3><p>{row.reasonLabel} · {row.decision_date ? <time dateTime={row.decision_date}>{row.decision_date}</time> : 'Decision date unknown'}</p>
          <p>Source time {row.occurred_at ? <time dateTime={row.occurred_at}>{row.occurred_at}</time> : 'unknown'}</p>
          {matched?.review_reference ? <button type="button" disabled={locked} onClick={event => review(matched, event.currentTarget)}>Review {matched.title}</button> : <a href={matched ? `/?card=${encodeURIComponent(matched.item_id)}` : '/inbox'}>Review in inbox</a>}
        </li>;
      })}</ol>
      <button type="button" onClick={() => void load()}>Refresh mail priorities</button>
    </>}
  </section>;
}
export function mountMailPriorities(host: HTMLElement, props: Props) {
  const root = createRoot(host); root.render(<MailPriorities {...props} />);
  return { dispose() { root.unmount(); } };
}

export { parseMailPage } from "./mail-priorities-client";
