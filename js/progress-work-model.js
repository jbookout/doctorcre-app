import { validCanonicalEngineeringPassport, passportProjectionDigest } from './job-passport.js';
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
const workFields = new Set(['work_request','work_request_id','work_request_ref','canonical_work_ref']);
const taskFields = new Set(['task_id','task_ref']);
const jobFields = new Set(['job_ref','job_id']);
const attemptFields = new Set(['attempt_id','attempt_ref','latest_attempt_ref']);
const bindingFields = new Set([...taskFields,...workFields,'session_id','canonical_session_id','session_ref','native_session_ref']);
function exactReference(value, refs, depth = 0) {
  if (depth > 12 || value == null) return false;
  if (typeof value === 'string') return refs.has(value);
  if (Array.isArray(value)) return value.some(item => typeof item === 'object' && exactReference(item, refs, depth + 1));
  if (typeof value === 'object') {
    if (refs.has(value.session_status?.claimed) || refs.has(value.assignment?.ref)) return true;
    return Object.entries(value).some(([key,item]) =>
    bindingFields.has(key) ? typeof item === 'string' ? refs.has(item) : key === 'work_request' && refs.has(item?.id)
      : typeof item === 'object' && exactReference(item, refs, depth + 1));
  }
  return false;
}
// Attempt numbers are local to a job. Retain their validated envelope identity
// rather than widening the set of globally sufficient references.
export function passportAttempts(passport) {
  const envelopes = new Map(passport.execution_envelopes.map(envelope => [passportProjectionDigest(envelope), envelope]));
  return passport.receipts.map(receipt => ({ attemptId: receipt.attempt_id, envelopeDigest: receipt.envelope_digest,
    jobRef: envelopes.get(receipt.envelope_digest).request.job_ref }));
}
function evidenceIdentity(value, scope) {
  const refs = scopeRefs(scope), attempts = scope.attempts || [];
  if (!scope.task && !scope.workRequest) return {contradicts:false,boundAttempt:false};
  let contradicts = false, boundAttempt = false;
  function visit(value, inherited = {}, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item,inherited,depth+1)); return; }
    const context = {...inherited};
    // Read the work binding first; JSON member order cannot change a join.
    for (const [key,item] of Object.entries(value)) {
      const ref = typeof item === 'string' ? item : key === 'work_request' ? item?.id : null;
      if ((workFields.has(key) || taskFields.has(key)) && refs.has(ref)) context.workBound = true;
    }
    for (const [key,item] of Object.entries(value)) {
      const ref = typeof item === 'string' ? item : key === 'work_request' ? item?.id : null;
      if (!ref) continue;
      if (workFields.has(key) || taskFields.has(key)) {
        if (!refs.has(ref)) contradicts = true;
      } else if (jobFields.has(key)) {
        context.jobRef = ref;
        if (!attempts.some(attempt => attempt.jobRef === ref) && !refs.has(ref)) contradicts = true;
      } else if (key === 'envelope_digest') {
        context.envelopeDigest = ref;
        if (!context.workBound && !attempts.some(attempt => attempt.envelopeDigest === ref)) contradicts = true;
      }
    }
    for (const [key,item] of Object.entries(value)) {
      if (attemptFields.has(key) && typeof item === 'string' && (context.jobRef || context.envelopeDigest)) {
        const matched = attempts.some(attempt => attempt.attemptId === item
          && (!context.jobRef || attempt.jobRef === context.jobRef)
          && (!context.envelopeDigest || attempt.envelopeDigest === context.envelopeDigest));
        if (matched) boundAttempt = true;
        // An explicit work binding can include older envelopes not in the
        // current read. It never authorizes a tuple from a different known job.
        else if (!(context.workBound && !context.jobRef && !attempts.some(attempt => attempt.envelopeDigest === context.envelopeDigest))) contradicts = true;
      } else if (typeof item === 'object') visit(item,context,depth+1);
    }
  }
  visit(value);
  return {contradicts,boundAttempt};
}
export function sourceSequence(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value))) return null;
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}
function sequenceJoin(value, scope) {
  const seq = sourceSequence(value);
  return seq !== null && (scope.sourceSeqs || []).some(item => sourceSequence(item) === seq);
}
// Conversation mentions remain visible but cannot establish executor links.
export function executionTurn(turn, scope) {
  let body;
  try { body = JSON.parse(turn.body); } catch { /* raw conversation has no structured identity */ }
  const value = {...turn, body}, identity = evidenceIdentity(value,scope);
  if (identity.contradicts) return false;
  return identity.boundAttempt || sequenceJoin(turn.seq,scope) || exactReference(value,scopeRefs(scope));
}
function scopeRefs(scope) {
  return new Set([scope.task, scope.workRequest, scope.session, ...(scope.refs || [])].filter(Boolean)
    .flatMap(ref => [ref, `job:${ref}`]));
}
export function scopedTurn(turn, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  if (executionTurn(turn,scope)) return true;
  const refs = scopeRefs(scope);
  try { JSON.parse(turn.body); return false; } catch { /* raw conversation below */ }
  // Explicit reference tokens in raw turns identify their topic; they never
  // promote an outcome or establish an executor/session relationship.
  const tokens = String(turn.body || '').split(/[^A-Za-z0-9_:.-]+/);
  return tokens.some(token => refs.has(token.replace(/[.:]+$/, '')));
}
export function scopedQueueCard(card, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  const identity = evidenceIdentity(card,scope);
  return !identity.contradicts && (identity.boundAttempt || exactReference(card,scopeRefs(scope)) || sequenceJoin(card.source_seq,scope));
}

// The canonical HTTP/MCP read includes current-generation arrays. The wire
// renderer's sealed historical form is a separate contract and stays strict.
export function canonicalPassport(value) {
  try { return validCanonicalEngineeringPassport(value); } catch { return false; }
}
