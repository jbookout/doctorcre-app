export const ACTIVITY_SCHEMA = 'doc-activity.v1';
export const typeLabel = value => String(value || '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
export function activityFilters({ partner = '', record_type = '', from = '', to = '' } = {}) {
  const args = { limit: 50 };
  if (partner) args.partner = partner;
  if (record_type) args.record_type = record_type;
  if (from) args.since = new Date(`${from}T00:00:00`).toISOString();
  if (to) { const date = new Date(`${to}T00:00:00`); date.setDate(date.getDate() + 1); args.until = date.toISOString(); }
  return args;
}
export function activityRows(answer) {
  if (answer?.ok !== true || answer.schema_version !== ACTIVITY_SCHEMA || !Array.isArray(answer.entries))
    throw new Error('activity_unavailable');
  const ids = new Set();
  return answer.entries.filter(row => {
    if (!row?.id || !row.record?.id || !Number.isFinite(Date.parse(row.at)) || ids.has(row.id)) return false;
    ids.add(row.id); return true;
  }).sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}
export function undoArgs(row, key) {
  if (row?.undo?.state !== 'available' || row.undo.verb !== 'revert-deal-field' || row.undo.event_id !== row.id) return null;
  return { event_id: row.id, idempotency_key: key };
}
export const undoLabel = state => ({ available: 'Undo', undone: 'Undone', superseded: 'Changed later',
  irreversible: 'Irreversible', unavailable: 'Undo unavailable' }[state] || 'Undo unavailable');
