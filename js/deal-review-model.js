import { toDay } from './calendar-model.js';
import { radarToday } from './lease-radar-model.js';

export function validDealBoard(board) {
  return board && typeof board === 'object' && !Array.isArray(board) && Array.isArray(board.deals)
    && board.deals.every(deal => deal && typeof deal === 'object' && !Array.isArray(deal)
      && typeof deal.id === 'string' && deal.id.trim().length > 0
      && ['name', 'owner', 'phase', 'operating_state', 'workspace_kind', 'account_client_id'].every(key => deal[key] == null || typeof deal[key] === 'string')
      && ['attention', 'in_market'].every(key => deal[key] == null || typeof deal[key] === 'boolean'));
}

export function scopedDeals(board, scope) {
  if (!validDealBoard(board) || (scope === 'mine' && !board.actor)) return null;
  return board.deals.filter(deal => !isClosedDeal(deal)
    && (deal.operating_state || 'active') === 'active'
    && (scope !== 'mine' || deal.owner === board.actor));
}

export function localDeals(rows, owner = 'all') {
  return (rows || []).filter(d => d.workspace_kind !== 'national_account' && !d.account_client_id
    && !(d.client_status === 'prospect' && d.prospect_engagement_status !== 'active')
    && !isClosedDeal(d) && (owner === 'all' || d.owner === owner));
}
export function isClosedDeal(deal) {
  return String(deal.phase).toLowerCase() === 'closed' || Boolean(deal.outcome || deal.closed_on || deal.invoiced_on);
}
/** The oldest due day before `today` among the deal's open actions, or null. */
export function overdueSince(deal, today) {
  if (isClosedDeal(deal) || (deal.operating_state || 'active') !== 'active') return null;
  const dues = Array.isArray(deal.items)
    ? deal.items.filter(item => item.status === 'open').map(item => toDay(item.due_on))
    : typeof deal.next_step === 'string' && deal.next_step.trim() ? [toDay(deal.next_date)] : [];
  return dues.filter(due => due && due < today).sort()[0] || null;
}
export function needsAttention(deal, now = Date.now()) {
  return overdueSince(deal, radarToday(new Date(now))) !== null;
}
/** "N days overdue" between two calendar days, or '' when `since` is not before `today`. */
export function overdueLabel(since, today) {
  const days = since && today ? Math.round((Date.parse(today) - Date.parse(since)) / 864e5) : 0;
  return days > 0 ? `${days} day${days === 1 ? '' : 's'} overdue` : '';
}
/** Most overdue first; deals with nothing overdue keep their order after them. */
export function mostOverdueFirst(deals, today) {
  const since = deal => overdueSince(deal, today) || '9999-12-31';
  return [...deals].sort((a, b) => since(a).localeCompare(since(b)));
}

export function requireReviewReceipt(receipt) {
  if (receipt?.ok !== true || typeof receipt.session_id !== 'string' || !receipt.session_id.trim())
    throw Object.assign(new Error('Agenda receipt is incomplete. Check outcome to recover the original session.'), { code: 'unknown_outcome' });
  return receipt;
}
