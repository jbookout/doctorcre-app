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
  load: () => Promise<unknown>;
  href: (id: string) => string;
  open: (href: string, returnFocusId: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProposal(value: unknown): value is Proposal {
  if (!isRecord(value)) return false;
  return typeof value.subject_type === 'string' && value.subject_type.trim().length > 0
    && typeof value.subject_id === 'string' && value.subject_id.trim().length > 0
    && typeof value.ref === 'string' && value.ref.trim().length > 0
    && typeof value.name === 'string'
    && (value.basis === 'created_at' || value.basis === 'last_contact')
    && typeof value.anchor_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.anchor_on)
    && typeof value.due_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.due_on)
    && typeof value.days_overdue === 'number' && Number.isSafeInteger(value.days_overdue);
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || !isRecord(value.cadence)
    || typeof value.cadence.vendor_days !== 'number'
    || !Number.isSafeInteger(value.cadence.vendor_days) || value.cadence.vendor_days < 1
    || !Array.isArray(value.proposals) || value.proposals.length > 1000
    || !value.proposals.every(isProposal)) throw new TypeError('Invalid quiet vendor snapshot');
  return { cadence: { vendor_days: value.cadence.vendor_days }, proposals: value.proposals };
}

export function mountQuietVendors(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  function QuietVendors() {
    const [expanded, setExpanded] = useState(false);
    const action = useRef<HTMLButtonElement>(null);
    const reading = useRef(false);
    const [state, setState] = useState<State>({ kind: 'idle' });
    async function read() {
      if (reading.current || disposed) return;
      reading.current = true;
      setState({ kind: 'loading' });
      try {
        const snapshot = parseSnapshot(await options.load());
        if (!disposed) setState({ kind: 'ready', snapshot, offset: 0 });
      } catch {
        if (!disposed) setState({ kind: 'refused' });
      } finally {
        reading.current = false;
      }
    }
    const vendors = state.kind === 'ready' ? state.snapshot.proposals.filter(row => row.subject_type === 'vendor') : [];
    return <section className={expanded ? 'quiet-vendors module-card glass' : 'quiet-vendors quiet-vendors-idle'} aria-label="Quiet vendor follow-ups">
      <h2 hidden={!expanded}>Quiet vendor follow-ups</h2>
      <p hidden={!expanded}>Review vendor relationships that CARR has marked due for attention.</p>
      <button ref={action} type="button" className="action" aria-expanded={!expanded ? false : undefined} aria-controls={!expanded ? "quietVendorsContent" : undefined}
        aria-disabled={expanded && state.kind === 'loading'} onClick={() => {
          if (!expanded) { setExpanded(true); if (state.kind === 'idle') void read(); }
          else void read();
        }}>
        {!expanded ? 'Show quiet vendors' : state.kind === 'loading' ? 'Loading quiet vendors…' : 'Refresh quiet vendors'}
      </button>
      {expanded && <> {' '}<button type="button" className="action" aria-expanded="true" aria-controls="quietVendorsContent" onClick={() => {
        action.current?.focus(); setExpanded(false);
      }}>Hide quiet vendors</button></>}
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
              {' · Owner: '}{row.owner === 'dell' ? 'Dell' : row.owner === 'joe' ? 'Joe' : typeof row.owner === 'string' && row.owner.trim() ? row.owner : 'not recorded'}</p>
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
