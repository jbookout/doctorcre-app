import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const PAGE_SIZE = 5;

type Proposal = {
  subject_type: string; subject_id: string; ref: string; name: string;
  basis: 'created_at' | 'last_contact'; anchor_on: string; due_on: string;
  days_overdue: number; owner?: unknown;
};
type Snapshot = { cadence: { vendor_days: number }; proposals: Proposal[] };
type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'refused' }
  | { kind: 'ready'; snapshot: Snapshot; offset: number };
type Options = {
  load: () => Promise<Snapshot>;
  href: (id: string) => string;
  open: (href: string, returnFocusId: string) => void;
};

export function mountQuietVendors(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  function QuietVendors() {
    const [expanded, setExpanded] = useState(false);
    const action = useRef<HTMLButtonElement>(null);
    const [state, setState] = useState<State>({ kind: 'idle' });
    async function read() {
      if (state.kind === 'loading' || disposed) return;
      setState({ kind: 'loading' });
      try {
        const snapshot = await options.load();
        if (!disposed) setState({ kind: 'ready', snapshot, offset: 0 });
      } catch {
        if (!disposed) setState({ kind: 'refused' });
      }
    }
    const vendors = state.kind === 'ready' ? state.snapshot.proposals.filter(row => row.subject_type === 'vendor') : [];
    return <section className={expanded ? 'quiet-vendors module-card glass' : 'quiet-vendors quiet-vendors-idle'} aria-label="Quiet vendor follow-ups">
      <h2 id="quietVendorsTitle" hidden={!expanded}>Quiet vendor follow-ups</h2>
      <p hidden={!expanded}>Review vendor relationships that CARR has marked due for attention.</p>
      <button ref={action} type="button" className="action" aria-expanded={expanded} aria-controls="quietVendorsContent"
        aria-disabled={expanded && state.kind === 'loading'} onClick={() => {
          if (!expanded) { setExpanded(true); if (state.kind === 'idle') void read(); }
          else void read();
        }}>
        {!expanded ? 'Show quiet vendors' : state.kind === 'loading' ? 'Loading quiet vendors…' : 'Refresh quiet vendors'}
      </button>
      {expanded && <button type="button" className="action" onClick={() => {
        action.current?.focus(); setExpanded(false);
      }}>Hide quiet vendors</button>}
      <div id="quietVendorsContent" hidden={!expanded} aria-busy={state.kind === 'loading'}>
      {state.kind === 'loading' && <p role="status">Loading the server snapshot…</p>}
      {state.kind === 'refused' && <p role="alert">The quiet vendor list is unavailable or was refused. Try refreshing.</p>}
      {state.kind === 'ready' && <>
        <p>Server cadence · {state.snapshot.cadence.vendor_days} days</p>
        {vendors.length === 0 ? <p>No quiet vendors in this server snapshot.</p> : <>
          <p role="status">Showing {state.offset + 1}–{Math.min(state.offset + PAGE_SIZE, vendors.length)} of {vendors.length} quiet vendors.</p>
          <div role="group" aria-label="Quiet vendor pages">
            <button type="button" className="action" aria-disabled={state.offset === 0} onClick={() => {
              if (state.offset > 0) setState({ ...state, offset: state.offset - PAGE_SIZE });
            }}>Previous vendors</button>
            {' '}
            <button type="button" className="action" aria-disabled={state.offset + PAGE_SIZE >= vendors.length} onClick={() => {
              if (state.offset + PAGE_SIZE < vendors.length) setState({ ...state, offset: state.offset + PAGE_SIZE });
            }}>Next vendors</button>
          </div>
          <ol>{vendors.slice(state.offset, state.offset + PAGE_SIZE).map((row, index) => <li key={`${row.subject_id}-${row.ref}-${state.offset + index}`}>
            <a id={`quiet-vendor-${index}`} href={options.href(row.subject_id)} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              options.open(event.currentTarget.href, event.currentTarget.id);
            }}>{row.name || row.ref}</a>
            <p><span className="quiet-vendor-detail">{row.basis === 'created_at' ? 'Never contacted · Created' : 'Last contact'} <time dateTime={row.anchor_on}>{row.anchor_on}</time></span>
              {' · '}<span className="quiet-vendor-detail">Due <time dateTime={row.due_on}>{row.due_on}</time></span>
              {' · '}<span className="quiet-vendor-detail">{row.days_overdue === 0 ? 'Due today' : `${row.days_overdue} ${row.days_overdue === 1 ? 'day' : 'days'} overdue`}</span>
              {' · Owner '}{row.owner === 'dell' ? 'Dell' : row.owner === 'joe' ? 'Joe' : typeof row.owner === 'string' && row.owner.trim() ? row.owner : 'not recorded'}</p>
          </li>)}</ol>

        </>}
      </>}
      </div>
    </section>;
  }
  flushSync(() => root.render(<QuietVendors />));
  return {
    update() { flushSync(() => root.render(<QuietVendors />)); },
    dispose() { disposed = true; flushSync(() => root.unmount()); },
  };
}
