import { useState } from 'react';
import { createRoot } from 'react-dom/client';

type Deal = { id: string; name: string; last_touch?: string | null; phase?: string | null };
type Board = { deals: Deal[]; actor: string; missing_next_action: { owner: string | null; deal_ids: string[] }[] };
type Props = { board: Board | null; scope: string; labels: Record<string, string> };
function lastTouchLabel(day: unknown): string {
  if (day === null) return 'No last touch';
  if (typeof day !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(day)) return 'Last touch unavailable';
  const date = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return 'Last touch unavailable';
  return `Last touch ${date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}`;
}
function MissingNextStep({ board, scope, labels }: Props) {
  const [expanded, setExpanded] = useState(false);
  const deals = new Map((board?.deals || []).map(deal => [deal.id, deal]));
  const groups = (board?.missing_next_action || []).filter(group => scope !== 'mine' || group.owner === null || group.owner === board?.actor)
    .map(group => ({ ...group, deals: group.deal_ids.flatMap(id => { const deal = deals.get(id); return deal ? [deal] : []; }) })).filter(group => group.deals.length);
  const total = groups.reduce((count, group) => count + group.deals.length, 0);
  if (!total) return null;
  return <section className="home-panel home-missing-next-step" aria-label="Deals with no next step">
    <header className="home-panel-head"><h2>Deals with no next step</h2></header>
    {groups.map(group => { const owner = group.owner === null ? 'Unassigned' : (labels[group.owner] || group.owner); return <div role="group" aria-label={owner} key={owner}><p className="subhead">{owner} · {group.deals.length}</p><div className="home-flags">{(expanded ? group.deals : group.deals.slice(0, 1)).map(deal => <a className="home-flag" href={`/deals?deal=${encodeURIComponent(deal.id)}&focus=next-step`} key={deal.id}><div><strong>{deal.name}</strong><span>{lastTouchLabel(deal.last_touch)}</span></div><span className="work-card-status">{deal.phase || 'Active'}</span><span className="home-arrow" aria-hidden="true">→</span></a>)}</div></div>; })}
    {total > groups.length && <button type="button" className="home-outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${total}`}</button>}
  </section>;
}
export function mountMissingNextStep(host: HTMLElement, labels: Record<string, string>) {
  const root = createRoot(host);
  return { update(board: Board | null, scope: string) { root.render(<MissingNextStep board={board} scope={scope} labels={labels} />); }, dispose() { root.unmount(); } };
}
