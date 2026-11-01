import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const shortDate = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

type Group = { owner: string | null; deal_ids: string[] };
type Deal = { id: string; name: string; phase?: string; last_touch?: string | null };
type Board = { missing_next_action?: Group[]; deals: Deal[]; actor: string };

function Panel({ board, scope, labels }: { board: Board | null; scope: string; labels: Record<string, string> }) {
  const [expanded, setExpanded] = useState(false);
  const deals = new Map(board?.deals.map(deal => [deal.id, deal]) || []);
  const groups = (board?.missing_next_action || []).filter(group => scope !== 'mine' || group.owner === null || group.owner === board?.actor)
    .map(group => ({ ...group, deals: group.deal_ids.flatMap(id => { const deal = deals.get(id); return deal ? [deal] : []; }) })).filter(group => group.deals.length);
  const total = groups.reduce((count, group) => count + group.deals.length, 0);
  if (!total) return null;
  return <section className="home-panel home-missing-next-step" aria-label="Deals with no next step">
    <header className="home-panel-head"><h2>Deals with no next step</h2></header>
    {groups.map(group => {
      const owner = group.owner === null ? 'Unassigned' : (labels[group.owner] || group.owner);
      return <div role="group" aria-label={owner} key={group.owner ?? 'unassigned'}>
        <p className="subhead">{owner} · {group.deals.length}</p><div className="home-flags">{(expanded ? group.deals : group.deals.slice(0, 1)).map(deal => <a className="home-flag" key={deal.id} href={`/deals?deal=${encodeURIComponent(deal.id)}&focus=next-step`}><div><strong>{deal.name}</strong><span>{deal.last_touch ? `Last touch ${shortDate(deal.last_touch)}` : 'No last touch'}</span></div><span className="work-card-status">{deal.phase || 'Active'}</span><span className="home-arrow" aria-hidden="true">→</span></a>)}</div>
      </div>;
    })}
    {total > groups.length && <button type="button" className="home-outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${total}`}</button>}
  </section>;
}

export function mountMissingNextStep(host: Element, labels: Record<string, string>) {
  const root = createRoot(host);
  return {
    update(board: Board | null, scope: string) { flushSync(() => root.render(<Panel board={board} scope={scope} labels={labels} />)); },
    dispose() { root.unmount(); },
  };
}
