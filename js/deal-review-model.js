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
export function needsAttention(deal, now = Date.now()) {
  if (isClosedDeal(deal) || (deal.operating_state || 'active') !== 'active') return false;
  if (Array.isArray(deal.items)) return deal.items.some(item => item.status === 'open' && toDay(item.due_on) && toDay(item.due_on) < radarToday(new Date(now)));
  const due = toDay(deal.next_date);
  return Boolean(typeof deal.next_step === 'string' && deal.next_step.trim() && due && due < radarToday(new Date(now)));
}

export function requireReviewReceipt(receipt) {
  if (receipt?.ok !== true || typeof receipt.session_id !== 'string' || !receipt.session_id.trim())
    throw Object.assign(new Error('Agenda receipt is incomplete. Check outcome to recover the original session.'), { code: 'unknown_outcome' });
  return receipt;
}
