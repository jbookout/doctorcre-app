export const ACTIVITY_SCHEMA = 'doc-activity.v1';
const text = value => typeof value === 'string' && value.trim().length > 0;
const optionalText = value => value === null || value === undefined || typeof value === 'string';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));
function validRow(row) {
  if (!text(row?.id) || !date(row.at) || !text(row.record?.id) || !text(row.record.type)
    || !text(row.record.name) || !text(row.what) || !optionalText(row.actor) || !optionalText(row.partner)
    || !optionalText(row.why) || !scalar(row.before) || !scalar(row.after)
    || !['available','undone','superseded','irreversible','unavailable'].includes(row.undo?.state)) return false;
  const evidence = row.evidence;
  return evidence === null || evidence === undefined || (evidence.kind === 'entry'
    && (evidence.at === null || evidence.at === undefined || date(evidence.at))
    && ['summary','reason','quote'].every(key => optionalText(evidence[key]))
    && ['before','after'].every(key => evidence[key] === undefined || scalar(evidence[key])));
}
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
  if (answer?.ok !== true || answer.schema_version !== ACTIVITY_SCHEMA || !Array.isArray(answer.entries)
    || !date(answer.as_of) || !Array.isArray(answer.record_types) || !answer.record_types.every(text)
    || !(answer.next_cursor === null || (date(answer.next_cursor?.at) && text(answer.next_cursor?.id)))
    || !answer.entries.every(validRow))
    throw new Error('activity_unavailable');
  const ids = new Set();
  return answer.entries.filter(row => {
    if (ids.has(row.id)) return false;
    ids.add(row.id); return true;
  }).sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}
export function undoArgs(row, key) {
  if (row?.undo?.state !== 'available' || row.undo.verb !== 'revert-deal-field' || row.undo.event_id !== row.id) return null;
  return { event_id: row.id, idempotency_key: key };
}
export const undoLabel = state => ({ available: 'Undo', undone: 'Undone', superseded: 'Changed later',
  irreversible: 'Irreversible', unavailable: 'Undo unavailable' }[state] || 'Undo unavailable');
