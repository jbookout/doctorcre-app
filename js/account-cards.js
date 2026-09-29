// Portfolio cards render only the account rows supplied by deal-room-board.
// The SVG shows the CARR record grain: one parent client, sub-clients, then
// separate market deals. It does not infer account status from a deal name.
export function renderAccountCards(accounts, { esc, relative, actorName }) {
  if (!accounts.length) return '<div class="empty">No national accounts yet. Add the first portfolio when it is won.</div>';
  return accounts.map((item) => {
    const name = esc(item.account_name || 'National account');
    const count = Number(item.open_deals || 0);
    const pulse = Number(item.overdue_deals || 0) > 0 ? 'overdue'
      : Number(item.attention_deals || 0) > 0 || Number(item.stale_deals || 0) > 0 ? 'attention'
      : count > 0 ? 'healthy' : 'dormant';
    const owner = esc(actorName(item.account_owner));
    return `
    <button type="button" class="account-card" data-account="${esc(item.account_client_id)}" data-pulse="${pulse}">
      <header><div><p class="eyebrow">${esc(item.account_client_ref || 'National account')}</p><h2>${name}</h2></div>
        <span class="account-owner" title="Owned by ${owner}">${item.account_owner === 'dell' ? 'D' : item.account_owner === 'joe' ? 'J' : '?'}</span></header>
      <svg class="account-flow" viewBox="0 0 320 105" role="img" aria-label="${name}: account parent connects to sub-clients and ${count} active market deals">
        <path class="flow-link" d="M65 45 H104 V23 H136 M104 45 V67 H136 M168 23 H211 V45 H248 M168 67 H211 V45"/>
        <path class="flow-arrow" d="m239 40 9 5-9 5"/>
        <rect class="flow-parent" x="14" y="27" width="52" height="36" rx="11"/>
        <circle class="flow-child" cx="151" cy="23" r="13"/>
        <circle class="flow-child" cx="151" cy="67" r="13"/>
        <rect class="flow-deals" x="249" y="27" width="56" height="36" rx="11"/>
        <text class="flow-count" x="277" y="50" text-anchor="middle">${count}</text>
        <text class="flow-label" x="40" y="88" text-anchor="middle">Account</text>
        <text class="flow-label" x="151" y="100" text-anchor="middle">Sub-clients</text>
        <text class="flow-label" x="277" y="88" text-anchor="middle">Market deals</text>
      </svg>
      <div class="account-metrics"><div><b>${count}</b><span>Active work</span></div>
        <div><b>${Number(item.attention_deals || 0)}</b><span>Attention</span></div>
        <div><b>${Number(item.stale_deals || 0)}</b><span>Gone quiet</span></div></div>
      <footer>${Number(item.parked_deals || 0)} parked · Last account review: ${esc(relative(item.last_review_at))} · Open agenda →</footer>
    </button>`;
  }).join('');
}
