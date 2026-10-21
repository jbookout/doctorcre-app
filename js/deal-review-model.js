import { toDay } from './calendar-model.js';
import { radarToday } from './lease-radar-model.js';

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
  const due = toDay(deal.next_date);
  return Boolean(typeof deal.next_step === 'string' && deal.next_step.trim() && due && due < radarToday(new Date(now)));
}
