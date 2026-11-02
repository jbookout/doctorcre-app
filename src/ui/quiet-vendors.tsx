import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

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
    return <section className="module-card glass" aria-labelledby="quietVendorsTitle" style={{ overflowWrap: 'anywhere', marginBottom: 'var(--space-4)' }}>
      <h2 id="quietVendorsTitle">Quiet vendor follow-ups</h2>
      <p>Review vendor relationships that CARR has marked due for attention.</p>
      <button type="button" className="action" onClick={() => void read()} disabled={state.kind === 'loading'}>
        {state.kind === 'idle' ? 'Show quiet vendors' : state.kind === 'loading' ? 'Loading quiet vendors…' : 'Refresh quiet vendors'}
      </button>
      {state.kind === 'loading' && <p role="status">Loading the server snapshot…</p>}
      {state.kind === 'refused' && <p role="alert">The quiet vendor list is unavailable or was refused. Try refreshing.</p>}
      {state.kind === 'ready' && <>
        <p>Server cadence · {state.snapshot.cadence.vendor_days} days</p>
        {vendors.length === 0 ? <p>No quiet vendors in this server snapshot.</p> : <>
          <p role="status">Showing {state.offset + 1}–{Math.min(state.offset + 20, vendors.length)} of {vendors.length} quiet vendors.</p>
          <ol style={{ maxHeight: '22rem', overflowY: 'auto', paddingInlineStart: 'var(--space-5)' }}>{vendors.slice(state.offset, state.offset + 20).map((row, index) => <li key={`${row.subject_id}-${row.ref}-${state.offset + index}`}>
            <a id={`quiet-vendor-${index}`} href={options.href(row.subject_id)} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              options.open(event.currentTarget.href, event.currentTarget.id);
            }}>{row.name || row.ref}</a>
            <p>{row.basis === 'created_at' ? 'Never contacted · Created' : 'Last contact'} {row.anchor_on}
              {' · Due '}{row.due_on}{' · '}{row.days_overdue} days overdue
              {' · Owner '}{typeof row.owner === 'string' && row.owner.trim() ? row.owner : 'not recorded'}</p>
          </li>)}</ol>
          <div role="group" aria-label="Quiet vendor pages">
            <button type="button" className="action" disabled={state.offset === 0} onClick={() =>
              setState({ ...state, offset: state.offset - 20 })}>Previous vendors</button>
            {' '}
            <button type="button" className="action" disabled={state.offset + 20 >= vendors.length} onClick={() =>
              setState({ ...state, offset: state.offset + 20 })}>Next vendors</button>
          </div>
        </>}
      </>}
    </section>;
  }
  flushSync(() => root.render(<QuietVendors />));
  return { dispose() { disposed = true; flushSync(() => root.unmount()); } };
}
