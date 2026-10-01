import { passportProjectionDigest } from './job-passport.js';
// Exact reference joins; titles and shared seats never establish task identity.
export const PROGRESS_WORK_PATH = '/control-room/progress/work';
export function workDetailUrl({ board = 'carr-v5', task, workRequest, session, view } = {}) {
  const query = new URLSearchParams({ board });
  for (const [key, value] of [['task', task], ['work_request', workRequest], ['session', session], ['view', view]]) if (value) query.set(key, value);
  return `${PROGRESS_WORK_PATH}?${query}`;
}
export function workScope(search = '') {
  const query = new URLSearchParams(search);
  return { board: query.get('board') || 'carr-v5', task: query.get('task') || query.get('task_id'),
    workRequest: query.get('work_request') || query.get('work-request'), session: query.get('session') || query.get('session_id'), view: query.get('view') || 'wire' };
}
export function exactReference(value, refs, depth = 0) {
  if (depth > 12 || value == null) return false;
  if (typeof value === 'string') return refs.has(value);
  if (Array.isArray(value)) return value.some(item => exactReference(item, refs, depth + 1));
  if (typeof value === 'object') return Object.values(value).some(item => exactReference(item, refs, depth + 1));
  return false;
}
export function scopeRefs(scope) {
  return new Set([scope.task, scope.workRequest, scope.session, ...(scope.refs || [])].filter(Boolean)
    .flatMap(ref => [ref, `job:${ref}`]));
}
export function scopedTurn(turn, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  if ((scope.sourceSeqs || []).includes(Number(turn.seq))) return true;
  const refs = scopeRefs(scope);
  if (exactReference({ session_id: turn.session_id, task_id: turn.task_id, work_request_ref: turn.work_request_ref }, refs)) return true;
  try { return exactReference(JSON.parse(turn.body), refs); } catch { /* raw conversation below */ }
  // Explicit reference tokens in raw turns identify their topic; they never
  // promote an outcome or establish an executor/session relationship.
  const tokens = String(turn.body || '').split(/[^A-Za-z0-9_:.-]+/);
  return tokens.some(token => refs.has(token.replace(/[.:]+$/, '')));
}
export function scopedQueueCard(card, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  return card.task_id === scope.task || exactReference(card, scopeRefs(scope)) || (scope.sourceSeqs || []).includes(Number(card.source_seq));
}

// The canonical HTTP/MCP read includes current-generation arrays. The wire
// renderer's sealed historical form is a separate contract and stays strict.
export function canonicalPassport(value) {
  const keys = ['schema_version','work_request','accepted_plan_revision','plan_digest','slice_plan','execution_envelopes','slices','current_receipts','current_reviewer_facts','receipts','reviewer_facts','qa_facts','operator_receipt','closure','closure_state','stale_conflict','projection_digest'];
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== keys.sort().join() || value.schema_version !== 'engineering-passport.v1') return false;
  const binding = value.work_request;
  if (!(typeof binding === 'string' && binding.trim() || binding && typeof binding.id === 'string' && Number.isInteger(binding.state_version) && binding.state_version >= 1 && /^sha256:[a-f0-9]{64}$/.test(binding.canonical_record_digest))) return false;
  if (!['execution_envelopes','slices','current_receipts','current_reviewer_facts','receipts','reviewer_facts','qa_facts'].every(key=>Array.isArray(value[key]) && value[key].every(row=>row && typeof row === 'object' && !Array.isArray(row)))) return false;
  return value.projection_digest === passportProjectionDigest(value) && ['complete','blocked'].includes(value.closure_state) && ['none','stale'].includes(value.stale_conflict?.state)
    && value.operator_receipt && ['work','proof','explanation','release','learning'].every(key=>typeof value.closure?.[key]?.state === 'string' && Array.isArray(value.closure[key].evidence_refs));
}
