import { newestFirst } from './change-receipts.mjs';
const text = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function unavailableEvidence(reason = 'read_unavailable') {
  return { state: 'unavailable', count: null, items: [], reason };
}
export function meetingEvidence(activities) {
  const meetings = Array.isArray(activities) ? activities.filter(row => row?.kind === 'meeting') : [];
  if (!meetings.length) return unavailableEvidence('meeting_coverage_unavailable');
  if (!meetings.every(row => text(row.id) && text(row.source) && text(row.summary) && instant(row.occurred_at))) return unavailableEvidence();
  return { state: 'ready', count: meetings.length, items: newestFirst(meetings.map(row => ({ id: row.id,
    kind: 'meeting', title: row.summary, when: row.occurred_at, source: `${row.source} · CARR deal activity` })), item => item.when) };
}
