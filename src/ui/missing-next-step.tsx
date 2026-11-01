import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { homeListLimit } from './home-list-limit';

type Group = { owner: string | null; deal_ids: string[] };
type Deal = { id: string; name: string };
type Board = { missing_next_action?: Group[]; deals: Deal[]; actor: string };

function Panel({ board, scope, limit }: { board: Board | null; scope: string; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  const names = new Map(board?.deals.map(deal => [deal.id, deal.name]) || []);
  const groups = (board?.missing_next_action || []).filter(group => scope !== 'mine' || group.owner === board?.actor)
    .map(group => ({ ...group, deals: group.deal_ids.filter(id => names.has(id)) })).filter(group => group.deals.length);
  const total = groups.reduce((count, group) => count + group.deals.length, 0);
  let remaining = expanded ? total : limit;
  if (!total) return null;
  return <section className="home-panel" aria-label="Deals with no next step">
    <header className="home-panel-head"><h2>Deals with no next step</h2></header>
    {groups.map(group => {
      const visible = group.deals.slice(0, remaining); remaining -= visible.length;
      const owner = group.owner === null ? 'Unassigned' : ({ joe: 'Joe', dell: 'Dell' }[group.owner] || group.owner);
      return visible.length ? <div role="group" aria-label={owner} key={group.owner ?? 'unassigned'}>
        <h3>{owner}</h3><div className="home-flags">{visible.map(id => <a className="home-flag" key={id} href={`/deals?deal=${encodeURIComponent(id)}`}><strong>{names.get(id)}</strong><span className="home-arrow" aria-hidden="true">↗</span></a>)}</div>
      </div> : null;
    })}
    {!expanded && total > limit && <button type="button" className="home-outline" onClick={() => setExpanded(true)}>Show all {total}</button>}
  </section>;
}

export function mountMissingNextStep(host: Element, win: Window) {
  const root = createRoot(host);
  return {
    update(board: Board | null, scope: string) { flushSync(() => root.render(<Panel board={board} scope={scope} limit={homeListLimit(win)} />)); },
    dispose() { root.unmount(); },
  };
}
