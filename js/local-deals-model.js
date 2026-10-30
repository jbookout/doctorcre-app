import { compareDatedEntries } from './change-receipts.mjs';
import { noteText } from './pipeline-model.js';
import { needsAttention } from './deal-review-model.js';

export const PHASE_TRIGGERS = Object.freeze({
  pending: 'Prospective client', research: 'ETL signed', site_selection: 'Tour prepared or scheduled',
  negotiation: 'LOI submitted', legal: 'Draft lease prepared', due_diligence: 'Lease signed',
  closing: 'Due-diligence deadline passed', closed: 'Closed',
});
export function lostDeals(rows, owner = 'all', query = '') { return historyDeals(rows, owner, query, true); }
export function closedDeals(rows, owner = 'all', query = '') { return historyDeals(rows, owner, query, false); }
function historyDeals(rows, owner = 'all', query = '', lost = false) {
  const search = query.trim().toLowerCase();
  return (rows || []).filter(d => (lost ? d.outcome === 'lost' : Boolean(d.outcome === 'won' || !d.outcome && (d.closed_on || d.invoiced_on))) && d.workspace_kind !== 'national_account' && !d.account_client_id
    && (owner === 'all' || d.owner === owner)
    && (!search || [d.name, d.client_name, d.client_ref, d.type, d.closed_on].some(v => String(v || '').toLowerCase().includes(search))))
    .sort((a,b) => String(b.closed_on || '').localeCompare(String(a.closed_on || '')) || String(a.name).localeCompare(String(b.name)));
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
  // The board projection does not bind automatic=true to a Doc actor.
  const prefix = /invoice/i.test(reason) && (event.phase === 'closed' || deal.phase === 'Closed')
    ? 'Closed automatically' : 'Moved automatically';
  return { eventId: event.event_id, text: `${prefix}: ${reason} ${Number(date[1])}/${Number(date[2])}` };
}
export function noteEntries(detail) {
  const activities = (detail.activities || []).map(a => ({
    id: a.id, kind: a.kind || 'Entry', actor: a.actor, when: a.occurred_at || a.recorded_at,
    summary: concise(a.summary || a.detail, 150),
    original: typeof a.detail === 'string' ? a.detail : noteText(a.detail),
  }));
  const notes = (detail.thread || []).map(n => ({
    id: n.id, kind: n.kind === 'archived_step' ? 'Prior next step' : n.kind === 'note' ? 'Note' : n.kind || 'Entry', actor: n.actor, when: n.at || n.created_at || n.recorded_at,
    summary: concise(n.text,150), original: noteText(n.text),
  }));
  return [...activities, ...notes].filter(n => n.summary).sort(compareDatedEntries);
}
