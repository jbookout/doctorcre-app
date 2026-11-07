import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Proposal = {
  subject_type: string; subject_id: string; ref: string; name: string;
  owner?: string | null; basis: 'created_at' | 'last_contact';
  anchor_on: string; due_on: string; days_overdue: number;
};
type Snapshot = { proposals: Proposal[] };
type Update = { kind: 'idle' } | { kind: 'loading' } | { kind: 'refused'; message: string }
  | { kind: 'ready'; snapshot: Snapshot };
type Page = { owner: string; offset: number; notice: string };

export function mountQuietLeads(host: HTMLElement, reason: (row: Proposal) => string) {
  const root = createRoot(host);
  let state: Update = { kind: 'idle' };
  let page: Page = { owner: 'all', offset: 0, notice: '' };
  let disposed = false;
  const ownerKey = (row: Proposal) => row.owner == null ? 'unrecorded' : `owner:${row.owner}`;
  const label = (owner: string) => owner === 'joe' ? 'Joe' : owner === 'dell' ? 'Dell' : `Recorded owner · ${owner}`;
  function render() {
    if (disposed) return;
    const leads = state.kind === 'ready' ? state.snapshot.proposals.filter(row => row.subject_type === 'lead') : [];
    const owners = [...new Set(leads.flatMap(row => row.owner == null ? [] : [row.owner]))].sort();
    const matches = leads.filter(row => page.owner === 'all' || ownerKey(row) === page.owner);
    flushSync(() => root.render(<>
      {state.kind === 'loading' && <p role="status">Loading follow-ups…</p>}
      {state.kind === 'refused' && <p role="alert">{state.message}</p>}
      {state.kind === 'ready' && <>
        <label>Quiet lead owner{' '}<select style={{ maxWidth: '100%' }} value={page.owner} onChange={event => {
          page = { owner: event.target.value, offset: 0, notice: '' }; render();
        }}>
          <option value="all">All owners</option>
          {owners.map(owner => <option key={owner} value={`owner:${owner}`}>{label(owner)}</option>)}
          <option value="unrecorded">Owner not recorded</option>
        </select></label>
        {page.notice && <p role="status">{page.notice}</p>}
        <p role="status">{matches.length ? `Showing ${page.offset + 1}–${Math.min(page.offset + 10, matches.length)} of ${matches.length} matching loaded leads (${leads.length} loaded).` : `0 matching loaded leads (${leads.length} loaded).`}</p>
        {!leads.length ? <p>No quiet leads.</p> : !matches.length ? <p>No quiet leads match this owner.</p> : <>
          <div role="group" aria-label="Quiet lead pages">
            <button type="button" aria-disabled={page.offset === 0} onClick={() => {
              if (page.offset > 0) { page = { ...page, offset: page.offset - 10 }; render(); }
            }}>Previous leads</button>{' '}
            <button type="button" aria-disabled={page.offset + 10 >= matches.length} onClick={() => {
              if (page.offset + 10 < matches.length) { page = { ...page, offset: page.offset + 10 }; render(); }
            }}>Next leads</button>
          </div>
          <ol start={page.offset + 1}>{matches.slice(page.offset, page.offset + 10).map((row, index) => <li key={`${row.subject_id}-${index}`}>
            <a href={`/leads?lead=${encodeURIComponent(row.ref)}`} data-quiet-lead={row.subject_id}>
              <span>{row.name}</span><p>{reason(row)}</p>
            </a>
          </li>)}</ol>
        </>}
      </>}
    </>));
  }
  render();
  return {
    update(next: Update) {
      if (disposed) return;
      if (next.kind === 'idle') page = { owner: 'all', offset: 0, notice: '' };
      if (next.kind === 'ready') {
        const valid = page.owner === 'all' || next.snapshot.proposals.some(row => row.subject_type === 'lead' && ownerKey(row) === page.owner);
        page = { owner: valid ? page.owner : 'all', offset: 0, notice: valid ? '' : 'The selected owner is no longer in this snapshot. Showing all owners.' };
      }
      state = next; render();
    },
    dispose() { if (disposed) return; disposed = true; state = { kind: 'idle' }; page = { owner: 'all', offset: 0, notice: '' }; flushSync(() => root.unmount()); },
  };
}
