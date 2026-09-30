// Portfolio cards render only the account rows supplied by deal-room-board.
// The SVG shows the CARR record grain: parent, sub-client layer, market deals.
// The middle node is neutral: the board supplies no sub-client count.
export function renderAccountCards(accounts, { esc, relative, actorName }) {
  if (!accounts.length) return '<div class="empty">No national accounts yet. Add the first portfolio when it is won.</div>';
  return accounts.map((item) => {
    const name = esc(item.account_name || 'National account');
    const count = Number(item.open_deals || 0);
    const overdue = Number(item.overdue_deals || 0);
    const pulse = overdue > 0 ? 'overdue'
      : Number(item.attention_deals || 0) > 0 || Number(item.stale_deals || 0) > 0 ? 'attention'
      : count > 0 ? 'healthy' : 'dormant';
    const owner = esc(actorName(item.account_owner));
    return `
    <button type="button" class="account-card" data-account="${esc(item.account_client_id)}" data-pulse="${pulse}">
      <header><div><p class="eyebrow">${esc(item.account_client_ref || 'National account')}</p><h2>${name}</h2></div>
        <span class="account-owner" title="Owned by ${owner}">${item.account_owner === 'dell' ? 'D' : item.account_owner === 'joe' ? 'J' : '?'}</span></header>
      <svg class="account-flow" viewBox="0 0 320 76" role="img" aria-label="${name}: account parent connects through sub-clients to ${count} active market deals; ${overdue} overdue">
        <path class="flow-link" d="M65 45 H136 M168 45 H248"/>
        <path class="flow-arrow" d="m239 40 9 5-9 5"/>
        <rect class="flow-parent" x="14" y="27" width="52" height="36" rx="11"/>
        <rect class="flow-child" x="136" y="27" width="32" height="36" rx="11"/>
        <rect class="flow-deals" x="249" y="27" width="56" height="36" rx="11"/>
        <text class="flow-count" x="277" y="50" text-anchor="middle">${count}</text>
      </svg>
      <div class="account-flow-labels" aria-hidden="true"><span>Account</span><span>Sub-clients</span><span>Market deals</span></div>
      <div class="account-metrics"><div><b>${count}</b><span>Active work</span></div>
        <div><b>${Number(item.attention_deals || 0)}</b><span>Attention</span></div>
        <div><b>${overdue}</b><span>Overdue</span></div>
        <div><b>${Number(item.stale_deals || 0)}</b><span>Gone quiet</span></div></div>
      <footer>${Number(item.parked_deals || 0)} parked · Last account review: ${esc(relative(item.last_review_at))} · Open agenda →</footer>
    </button>`;
  }).join('');
}
