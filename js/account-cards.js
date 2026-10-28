// Portfolio cards render only the account rows supplied by deal-room-board.
export function renderAccountCards(accounts, { esc, relative, actorName, dateLabel }) {
  if (!accounts.length) return '<div class="empty">No national accounts yet. Add the first portfolio when it is won.</div>';
  return accounts.map((item) => {
    const name = esc(item.account_name || 'National account');
    const count = Number(item.open_deals || 0);
    const overdue = Number(item.overdue_deals || 0);
    const pulse = overdue > 0 ? 'overdue'
      : Number(item.attention_deals || 0) > 0 || Number(item.stale_deals || 0) > 0 ? 'attention'
      : count > 0 ? 'healthy' : 'dormant';
    const owner = esc(actorName(item.account_owner));
    const next = item.next_action;
    return `
    <button type="button" class="account-card" data-account="${esc(item.account_client_id)}" data-pulse="${pulse}">
      <header><div><h2>${name}</h2><p class="account-ref">${esc(item.account_client_ref || 'National account')}</p></div>
        <span class="account-owner" title="Owned by ${owner}">${item.account_owner === 'dell' ? 'D' : item.account_owner === 'joe' ? 'J' : '?'}</span></header>
      ${next?.next_step ? `<div class="account-next-action"><span${overdue ? ' class="is-alert"' : ''}>${overdue ? 'Oldest overdue action' : 'Next market action'}</span><strong>${esc(next.next_step)}</strong><span>${esc(next.name)}${next.next_date ? ` · ${esc(dateLabel(next.next_date))}` : ''}</span></div>` : `<p class="account-next-action"><strong>${overdue ? `${overdue} overdue dates` : count ? `${count} active deals` : 'No active deals'}</strong></p>`}
      <div class="account-metrics"><div><b>${count}</b><span>Active work</span></div>
        <div><b>${Number(item.attention_deals || 0)}</b><span>Attention</span></div>
        <div${overdue > 0 ? ' class="is-alert"' : ''}><b>${overdue}</b><span>Overdue</span></div>
        <div><b>${Number(item.stale_deals || 0)}</b><span>Gone quiet</span></div></div>
      <div class="account-flow-labels" aria-label="Account structure"><span>Account</span><span>Sub-clients</span><span>Market deals</span></div>
      <p class="account-summary">${Number(item.parked_deals || 0)} parked · Last account review: ${esc(relative(item.last_review_at))} · <span class="account-open">Open account</span></p>
    </button>`;
  }).join('');
}
