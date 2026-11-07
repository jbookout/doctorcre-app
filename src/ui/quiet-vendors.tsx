import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const PAGE_SIZE = 5;

type Proposal = {
  subject_type: string; subject_id: string; ref: string; name: string;
  basis: 'created_at' | 'last_contact'; anchor_on: string; due_on: string;
  days_overdue: number; owner?: string | null;
};
type Snapshot = { cadence: { vendor_days: number }; proposals: Proposal[] };
type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'refused' }
  | { kind: 'ready'; snapshot: Snapshot; offset: number };
type Options = {
  load: () => Promise<Snapshot>;
  href: (id: string) => string;
  open: (href: string, returnFocusId: string) => void;
};

const ownerKey = (owner: string | null | undefined) => owner == null ? 'missing' : `owner:${owner}`;
const ownerLabel = (owner: string) => owner === 'joe' ? 'Joe' : owner === 'dell' ? 'Dell' : owner;

export function mountQuietVendors(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  let reading = false;
  function QuietVendors() {
    const owner = useRef('all');
    const [notice, setNotice] = useState('');
    const [expanded, setExpanded] = useState(false);
    const action = useRef<HTMLButtonElement>(null);
    const [state, setState] = useState<State>({ kind: 'idle' });
    async function read() {
      if (reading || disposed) return;
      reading = true;
      setState({ kind: 'loading' });
      try {
        const snapshot = await options.load();
        if (!disposed) {
          const available = snapshot.proposals.filter(row => row.subject_type === 'vendor');
          const retained = owner.current === 'all' || available.some(row => ownerKey(row.owner) === owner.current);
          setNotice(retained ? '' : 'The selected owner is no longer in this snapshot. Showing all owners.');
          if (!retained) owner.current = 'all';
          setState({ kind: 'ready', snapshot, offset: 0 });
        }
      } catch {
        if (!disposed) setState({ kind: 'refused' });
      } finally { reading = false; }
    }
    const vendors = state.kind === 'ready' ? state.snapshot.proposals.filter(row => row.subject_type === 'vendor') : [];
    const owners = [...new Set(vendors.map(row => ownerKey(row.owner)))];
    const matching = vendors.filter(row => owner.current === 'all' || ownerKey(row.owner) === owner.current);
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
        <label className="field">Quiet vendor owner{' '}
          <select value={owner.current} onChange={event => {
            owner.current = event.currentTarget.value;
            setNotice(''); setState({ ...state, offset: 0 });
          }}>
            <option value="all">All owners</option>
            {owners.filter(key => key !== 'missing').map(key => <option key={key} value={key}>{ownerLabel(key.slice(6))}</option>)}
            {owners.includes('missing') && <option value="missing">Owner not recorded</option>}
          </select>
        </label>
        {notice && <p role="status">{notice}</p>}
        {vendors.length === 0 ? <p>No quiet vendors in this server snapshot.</p> : <>
          <p role="status">Showing {state.offset + 1}–{Math.min(state.offset + PAGE_SIZE, matching.length)} of {matching.length} {owner.current === 'all' ? 'quiet vendors' : 'matching loaded vendors'}.</p>
          {owner.current === 'all' && <p>Counts describe loaded vendors only.</p>}
          <div role="group" aria-label="Quiet vendor pages">
            <button type="button" className="action" aria-disabled={state.offset === 0} onClick={() => {
              if (state.offset > 0) setState({ ...state, offset: state.offset - PAGE_SIZE });
            }}>Previous vendors</button>
            {' '}
            <button type="button" className="action" aria-disabled={state.offset + PAGE_SIZE >= matching.length} onClick={() => {
              if (state.offset + PAGE_SIZE < matching.length) setState({ ...state, offset: state.offset + PAGE_SIZE });
            }}>Next vendors</button>
          </div>
          <ol>{matching.slice(state.offset, state.offset + PAGE_SIZE).map((row, index) => <li data-vendor-id={row.subject_id} key={`${row.subject_id}-${row.ref}-${state.offset + index}`}>
            <a id={`quiet-vendor-${index}`} href={options.href(row.subject_id)} onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              options.open(event.currentTarget.href, event.currentTarget.id);
            }}>{row.name || row.ref}</a>
            <p><span className="quiet-vendor-detail">{row.basis === 'created_at' ? 'Never contacted · Created' : 'Last contact'} <time dateTime={row.anchor_on}>{row.anchor_on}</time></span>
              {' · '}<span className="quiet-vendor-detail">Due <time dateTime={row.due_on}>{row.due_on}</time></span>
              {' · '}<span className="quiet-vendor-detail">{row.days_overdue === 0 ? 'Due today' : `${row.days_overdue} ${row.days_overdue === 1 ? 'day' : 'days'} overdue`}</span>
              {' · Owner: '}{row.owner == null ? 'not recorded' : ownerLabel(row.owner)}</p>
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
