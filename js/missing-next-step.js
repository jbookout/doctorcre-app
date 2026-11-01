import { escapeText as E } from './change-receipts.mjs';

const shortDate = day => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

export function mountMissingNextStep(host, labels) {
  let board = null, scope = 'mine', expanded = false;
  const render = () => {
    const deals = new Map(board?.deals.map(deal => [deal.id, deal]) || []);
    const groups = (board?.missing_next_action || []).filter(group => scope !== 'mine' || group.owner === null || group.owner === board?.actor)
      .map(group => ({ ...group, deals: group.deal_ids.flatMap(id => { const deal = deals.get(id); return deal ? [deal] : []; }) })).filter(group => group.deals.length);
    const total = groups.reduce((count, group) => count + group.deals.length, 0);
    host.innerHTML = total ? `<section class="home-panel home-missing-next-step" aria-label="Deals with no next step">
      <header class="home-panel-head"><h2>Deals with no next step</h2></header>
      ${groups.map(group => {
        const owner = group.owner === null ? 'Unassigned' : (labels[group.owner] || group.owner);
        return `<div role="group" aria-label="${E(owner)}"><p class="subhead">${E(owner)} · ${group.deals.length}</p><div class="home-flags">${(expanded ? group.deals : group.deals.slice(0, 1)).map(deal => `<a class="home-flag" href="/deals?deal=${E(encodeURIComponent(deal.id))}&amp;focus=next-step"><div><strong>${E(deal.name)}</strong><span>${E(deal.last_touch ? `Last touch ${shortDate(deal.last_touch)}` : 'No last touch')}</span></div><span class="work-card-status">${E(deal.phase || 'Active')}</span><span class="home-arrow" aria-hidden="true">→</span></a>`).join('')}</div></div>`;
      }).join('')}
      ${total > groups.length ? `<button type="button" class="home-outline" aria-expanded="${expanded}">${expanded ? 'Show less' : `Show all ${total}`}</button>` : ''}
    </section>` : '';
  };
  const toggle = event => {
    if (!event.target.closest('button')) return;
    expanded = !expanded;
    render();
    host.querySelector('button')?.focus();
  };
  host.addEventListener('click', toggle);
  return {
    update(nextBoard, nextScope) { board = nextBoard; scope = nextScope; render(); },
    dispose() { host.removeEventListener('click', toggle); host.replaceChildren(); },
  };
}
