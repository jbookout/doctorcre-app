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
function ContactReasons({ payload, error, busy, retired, home, visibleCount }: State) {
  const rows = payload?.cards.filter(row => !home || row.route === 'research') || [];
  const shown = rows.slice(0, visibleCount);
  return <><header className={home ? 'home-panel-head' : 'section-heading'}><h2>Reasons to reach out</h2>{home && <a className="home-plain-link" data-reason-key="all" href="/leads#contactReasons">All reasons</a>}</header>
    {retired ? <p role="status">Sign in to view contact reasons.</p> : <>
      {error && <p role="status">Contact reasons unavailable.{payload ? ' Showing last update.' : ''} <button type="button" data-reason-key="retry" data-retry-reasons>Try again</button></p>}
      {payload ? <><div className="contact-reason-list">{shown.length ? shown.map(row => <ReasonCard key={row.id} row={row} home={home} />) : <p>No new reasons to reach out.</p>}</div>
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
