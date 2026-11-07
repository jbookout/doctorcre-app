import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Card = { id: string; name: string; kind: string; route: string; city: string; state: string; evidence_date: string; source: string; source_url: string; client_ids: string[]; client_refs: string[] };
type Coverage = { source: string; status: string; coverage?: string };
type State = { payload: { cards: Card[]; coverage: Coverage[]; next_cursor: string | null } | null; error: boolean; busy: boolean; retired: boolean; home: boolean; visibleCount: number };
const kinds: Record<string, [string, string]> = {
  enumeration: ['Practice registered in NPPES', 'Registration date'],
  registry_update: ['Practice registration updated', 'Registry update date'],
  pecos_observation: ['Medicare enrollment listed', 'Publication date'],
  pecos_correction: ['Medicare enrollment evidence corrected', 'Publication date'],
};
const sources: Record<string, string> = {
  nppes: 'NPPES', pecos: 'PECOS', 'formation-al': 'Alabama formations', 'formation-fl': 'Florida formations',
  'recorder-escambia-fl': 'Escambia County recorder', 'recorder-baldwin-al': 'Baldwin County recorder', 'recorder-other': 'Other county recorders',
};
function ReasonCard({ row, home }: { row: Card; home: boolean }) {
  const [reason, basis] = kinds[row.kind]!;
  const followUp = row.route === 'relationship_follow_up';
  const title = followUp ? `Follow up with ${row.client_refs[0] || 'client'}` : row.name;
  const href = home ? '/leads#contactReasons' : followUp ? `/clients?record=${encodeURIComponent(row.client_ids[0]!)}` : null;
  const date = new Date(`${row.evidence_date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  return <article className="work-card work-card--stack "><h3 className="work-card-title">{href ? <a data-reason-key={`title:${row.id}`} href={href}>{title}</a> : title}</h3>
    <div className="work-card-meta">{[row.city, row.state].filter(Boolean).join(' · ')}</div>
    {row.route === 'identity_review' && <span className="work-card-status">Needs review</span>}
    <div className="work-card-body">{followUp && <p>{row.name}</p>}<p>{reason}</p><p>{basis} · <time dateTime={row.evidence_date}>{date}</time></p>{row.route === 'identity_review' && <p>Confirm which practice this belongs to.</p>}</div>
    <div className="work-card-actions"><a data-reason-key={`source:${row.id}`} href={row.source_url} target="_blank" rel="noopener noreferrer">{sources[row.source]} source<span className="sr-only"> for {row.name} (opens in new tab)</span> ↗</a></div>
  </article>;
}
type ReasonCategory = '' | 'research' | 'relationship_follow_up' | 'identity_review';
const reasonCategories: { value: ReasonCategory; label: string }[] = [
  { value: '', label: 'All' }, { value: 'research', label: 'Research' },
  { value: 'relationship_follow_up', label: 'Relationship follow-up' }, { value: 'identity_review', label: 'Identity review' },
];
const filterLabelStyle = { display: 'grid', gap: 'var(--space-1)', color: 'var(--fg-muted)', fontSize: 'var(--font-size-1)' };
type EvidenceWindow = { from: string; through: string };
const emptyWindow: EvidenceWindow = { from: '', through: '' };
function canonicalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function ContactReasons({ payload, error, busy, retired, home, visibleCount }: State) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ReasonCategory>('');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<EvidenceWindow>(emptyWindow);
  const [window, setWindow] = useState<EvidenceWindow>(emptyWindow);
  const [windowError, setWindowError] = useState('');
  const hasWindow = Boolean(window.from || window.through);
  const hasDraft = Boolean(draft.from || draft.through);

  const [previousPayload, setPreviousPayload] = useState(payload);
  const availableSources = [...new Set((payload?.cards || []).map(row => row.source))].sort();
  if (previousPayload !== payload) {
    setPreviousPayload(payload);
    if (source && !availableSources.includes(source)) setSource('');
  }
  const selectedSource = availableSources.includes(source) ? source : '';
  const query = search.trim().toLocaleLowerCase('en-US');
  const rows = (payload?.cards || []).filter(row => home ? row.route === 'research' :
    (!hasWindow || canonicalDate(row.evidence_date) && (!window.from || row.evidence_date >= window.from) && (!window.through || row.evidence_date <= window.through)) && (!selectedSource || row.source === selectedSource) && (!category || row.route === category) && (!query || [row.name, row.city, row.state, ...row.client_refs]
      .some(text => text.toLocaleLowerCase('en-US').includes(query))));
  const shown = rows.slice(0, visibleCount);
  const emptyMessage = home || (!search && !category && !selectedSource && !hasWindow && !payload?.next_cursor) ? 'No new reasons to reach out.'
    : search || category || selectedSource || hasWindow ? 'No matches among loaded reasons.' : 'None on this page. Load more reasons below.';
  return <><header className={home ? 'home-panel-head' : 'section-heading'}><h2>Reasons to reach out</h2>{home && <a className="home-plain-link" data-reason-key="all" href="/leads#contactReasons">All reasons</a>}</header>
    {retired ? <p role="status">Sign in to view contact reasons.</p> : <>
      {error && <p role="status">Contact reasons unavailable.{payload ? ' Showing last update.' : ''} <button type="button" data-reason-key="retry" data-retry-reasons>Try again</button></p>}
      {payload ? <>{!home && Boolean(payload.cards.length || payload.next_cursor || search || category || selectedSource || hasDraft || hasWindow) && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 'var(--space-3)', marginBlock: 'var(--space-3)' }}>
          <label className="search" style={filterLabelStyle}>Search loaded reasons<input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <label style={filterLabelStyle}>Source<select aria-label="Source" value={selectedSource} onChange={event => setSource(event.target.value)}>
            <option value="">All sources</option>
            {availableSources.map(value => <option key={value} value={value}>{sources[value]}</option>)}
          </select></label>
          <label style={filterLabelStyle}>Action category<select value={category} onChange={event => { const selected = reasonCategories.find(option => option.value === event.target.value); if (selected) setCategory(selected.value); }}>
            {reasonCategories.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          if ((draft.from && !canonicalDate(draft.from)) || (draft.through && !canonicalDate(draft.through))) {
            setWindowError('Enter real dates as YYYY-MM-DD. Showing the last applied window.');
          } else if (draft.from && draft.through && draft.from > draft.through) {
            setWindowError('Evidence from must be on or before Evidence through. Showing the last applied window.');
          } else { setWindow(draft); setWindowError(''); }
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 'var(--space-3)' }}>
            <label style={filterLabelStyle}>Evidence from<input type="text" placeholder="YYYY-MM-DD" value={draft.from} aria-invalid={Boolean(windowError)} aria-describedby="evidence-window-help" onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
            <label style={filterLabelStyle}>Evidence through<input type="text" placeholder="YYYY-MM-DD" value={draft.through} aria-invalid={Boolean(windowError)} aria-describedby="evidence-window-help" onChange={event => setDraft({ ...draft, through: event.target.value })} /></label>
          </div>
          <p id="evidence-window-help">Optional dates, YYYY-MM-DD. Both dates are included.</p>
          <button type="submit" className="btn home-outline">Apply evidence window</button>
          {windowError && <p role="alert">{windowError}</p>}
        </form>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <p role="status">{rows.length} {search || category || selectedSource || hasWindow ? 'matching loaded' : 'loaded'} {rows.length === 1 ? 'reason' : 'reasons'}</p>
          {(search || category || selectedSource || hasWindow || hasDraft || windowError) && <button type="button" className="btn home-outline" onClick={() => { setSearch(''); setCategory(''); setSource(''); setDraft(emptyWindow); setWindow(emptyWindow); setWindowError(''); searchInput.current?.focus(); }}>Clear</button>}
        </div>
      </>}
      <div className="contact-reason-list">{shown.length ? shown.map(row => <ReasonCard key={row.id} row={row} home={home} />) : <p>{emptyMessage}</p>}</div>
        {rows.length > visibleCount && <button type="button" className="btn home-outline" data-reason-key="show" data-show-reasons>Show {rows.length - visibleCount} more</button>}
        {!home && <><p className="contact-reason-note">Registry and publication dates do not confirm when a practice opened.</p>
          <ul className="contact-reason-coverage" aria-label="Source coverage">{payload.coverage.map(row => <li key={row.source}>{sources[row.source]} · {row.status === 'available' ? 'Covered' : row.status === 'blocked' ? 'Updates blocked' : 'Not yet covered'}{row.status === 'available' && row.coverage && <> <small>{row.coverage}</small></>}</li>)}</ul>
          {payload.next_cursor && <button type="button" data-reason-key="more" data-more-reasons disabled={busy}>More reasons</button>}</>}
      </> : !error && <p role="status">Loading contact reasons…</p>}
    </>}
  </>;
}
export function createContactReasonsView(host: HTMLElement) {
  const root = createRoot(host);
  return {
    render(state: State) { flushSync(() => root.render(<ContactReasons {...state} />)); },
    dispose() { flushSync(() => root.unmount()); },
  };
}
