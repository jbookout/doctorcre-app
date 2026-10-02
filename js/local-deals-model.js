import { noteText } from './pipeline-model.js';

export const PHASE_TRIGGERS = Object.freeze({
  pending: 'Prospective client', research: 'ETL signed', site_selection: 'Tour prepared or scheduled',
  negotiation: 'LOI submitted', legal: 'Draft lease prepared', due_diligence: 'Lease signed',
  closing: 'Due-diligence deadline passed', closed: 'Closed',
});
export const OWNER_FILTERS = Object.freeze([
  { value: 'all', label: 'All' }, { value: 'joe', label: 'Joe' }, { value: 'dell', label: 'Dell' },
]);
export function localDeals(rows, owner = 'all') {
  return (rows || []).filter(d => d.workspace_kind !== 'national_account' && !d.account_client_id
    && !d.invoiced_on && (owner === 'all' || d.owner === owner));
}
export function needsAttention(deal, now = Date.now()) {
  if (deal.operating_state === 'parked') return false;
  const changed = Math.max(...[deal.phase_change?.recorded_at, deal.updated_at,
    ...Object.values(deal.field_base || {}).map(event => event?.recorded_at)]
    .map(value => Date.parse(value || '')).filter(Number.isFinite), -Infinity);
  const review = Date.parse(deal.last_review_at || '');
  const touch = Date.parse(deal.last_touch || '');
  const due = Date.parse(deal.next_date || '');
  return Boolean(deal.attention || deal.needs_attention || deal.flagged || deal.missing_step
    || deal.changed_since_review || deal.gone_quiet || !noteText(deal.next_step)
    || (Number.isFinite(changed) && (!Number.isFinite(review) || changed > review))
    || (Number.isFinite(touch) && now - touch > 14 * 86400000)
    || (Number.isFinite(due) && due < now));
}
export function urgencyOrder(rows, now = Date.now()) {
  return [...rows].sort((a,b) => Number(needsAttention(b,now)) - Number(needsAttention(a,now))
    || (Date.parse(a.next_date || '') || Infinity) - (Date.parse(b.next_date || '') || Infinity)
    || String(a.name).localeCompare(String(b.name)));
}
export function concise(value, limit = 100) {
  const text = noteText(value).replace(/\s+/g,' ').trim();
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + '…';
}
export function automaticMove(deal) {
  const event = deal.phase_change;
  if (!event?.automatic || !event.event_id || !event.prior_phase || !event.evidence_date) return null;
  const date = String(event.evidence_date).slice(0,10).split('-');
  if (date.length !== 3 || !Number.isFinite(Date.parse(event.evidence_date))) return null;
  const reason = concise(event.reason || 'phase changed', 50);
  const prefix = /invoice/i.test(reason) && (event.phase === 'closed' || deal.phase === 'Closed') ? 'Closed by Doc' : 'Moved by Doc';
  return { eventId: event.event_id, text: `${prefix}: ${reason} ${Number(date[1])}/${Number(date[2])}` };
}
export function noteEntries(detail) {
  const activities = (detail.activities || []).map(a => ({
    id: a.id, kind: a.kind || 'Entry', actor: a.actor, when: a.occurred_at || a.recorded_at,
    summary: concise(a.summary || a.detail, 150),
    original: typeof a.detail === 'string' ? a.detail : noteText(a.detail) || noteText(a.summary),
  }));
  const notes = (detail.thread || []).map(n => ({
    id: n.id, kind: n.kind === 'archived_step' ? 'Prior next step' : n.kind === 'note' ? 'Note' : n.kind || 'Entry', actor: n.actor, when: n.at || n.created_at || n.recorded_at,
    summary: concise(n.text,150), original: noteText(n.text),
  }));
  return [...activities, ...notes].filter(n => n.summary).sort((a,b) => (Date.parse(b.when) || 0) - (Date.parse(a.when) || 0));
}
