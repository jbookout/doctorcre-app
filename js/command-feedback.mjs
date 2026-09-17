/**
 * One logical operation, one idempotency key — for every command the product
 * sends, not only for a board cell.
 *
 * The Deal Room already had this shape, per `deal|field`, in
 * field-write-reconciliation.mjs. Everything else that writes — closing a loop,
 * completing an action, answering a work item — was minting a fresh key per
 * attempt, which is the defect that module was written to remove. So the
 * bookkeeping moves here, keyed by an `operationKey` the caller names, and the
 * cell module becomes one caller of it.
 *
 * The rules are unchanged, because they are the record layer's rules:
 *
 *   - the request is built ONCE — the caller's arguments plus one key — and
 *     frozen. Every later attempt sends that same object. A re-send under the
 *     same key with the same arguments replays the STORED answer and writes
 *     nothing; the same key with different arguments is refused as `key_reuse`.
 *     There is no verb that looks an operation up by key, so re-sending the
 *     frozen request IS the reconcile for an unknown outcome.
 *   - while a request is open, a second one for that operation is not sent at
 *     all. That is the double-click guard, and it guards duplicate SENDS, not
 *     the outcome.
 *   - an unresolved operation is not silently replaced. A DIFFERENT intent for
 *     the same operation is blocked while the first is still unknown, because
 *     minting a second key over the top of it is the defect, not the fix.
 *   - only the server's answer settles anything. No timer, no blind re-send, no
 *     optimistic value, and nothing in here touches the DOM, the network or
 *     storage.
 *
 * A conflict is terminal for the SAME request: re-sending it replays the same
 * refusal, so the sentence tells the person to re-read and decide rather than
 * offering a retry.
 *
 * UNDO IS NOT KEYED HERE, AND THAT IS DELIBERATE. This module keys on the
 * operation: one intent to write, one idempotency key, one dock row. Undo keys
 * on the change-feed EVENT the server recorded, in change-receipts.mjs, because
 * one operation can produce several events (a board move files a note, a next
 * step and a critical date), a change made in another session has no operation
 * here at all, and whether an event can still be undone is a computation over
 * the whole feed (supersession per deal and field, ownership, age) that a
 * per-operation map cannot express. So every production page records its dock
 * entries with `undo: false` and mounts the dock with no `onUndo`; the Undo
 * button below stays as the dock's hook for a page that has a single-event
 * operation and chooses to wire it, and the Undo people use lives in the Recent
 * changes popup. Deferred tweak 7 (decision 20b3e28a) considered unifying the
 * two and did not: the plumbing is small, the semantics are a redesign.
 */

import { FEEDBACK_STATES, feedbackLabel } from './visual-system.js';
import { escapeText } from './change-receipts.mjs';

/** Codes that mean the server BROKE, not that it declined. */
const SERVER_FAULT_CODES = new Set(['unhandled_verb_failure', 'internal_error']);

/** Refusals that are really "the version you read is not the version there is". */
const BASE_VERSION_CODES = new Set(['missing_base_version', 'invalid_base_version']);

/**
 * Statuses that are a DECISION about this request rather than a failure around
 * it. 401 and 403 are taken at the door, before the verb runs: nothing was
 * saved, nothing is pending, and inviting a retry would be a lie. Everything
 * else non-2xx is uncertain, because a proxy can produce almost any status.
 */
const DEFINITIVE_HTTP = new Set([401, 403]);

// Sentence tails. The caller supplies the subject — "Attention flag on
// Riverbank Dental", or the default "This change".
const COMMAND_SENTENCE = Object.freeze({
  superseded: 'was recorded. Something newer has since landed on this record, so the page is showing what it holds now rather than applying this one.',
  no_answer: 'could not be confirmed — nothing came back from the server. It may already be saved: use Check outcome on the command dock, or open the record to check, before changing it again.',
  server_error: 'could not be confirmed — the server reported an error instead of confirming it. It may already be saved: use Check outcome on the command dock, or open the record to check, before changing it again.',
  unauthorized: 'was not saved — this session is not signed in, or is not allowed to make it. Sign in again, re-open the record, and make the change from what it holds now.',
  key_reuse: 'was already sent under the same safety key for a different request, so the server refused it. Open the record and check what it holds now.',
  version_conflict: 'was not saved — the record changed since you read it. Re-open it and decide from what it holds now.',
  needs_confirm: 'needs a confirmation before it is saved. Open the record and confirm it.',
  base_version: "was not saved — the record's version was missing or stale. Re-open it and try from what it holds now.",
  unresolved: 'has an earlier change that was never confirmed. Use Check outcome on the command dock, or open the record, before making a different change here.',
  in_flight: 'is still being sent. Wait for the server to answer before changing it again.',
});

const SLUG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function humanize(code) {
  if (code === null || code === undefined) return '';
  const value = String(code);
  if (!SLUG.test(value)) return value;
  return value.replace(/_/g, ' ');
}

/** Stable text for any value an argument can hold, so equality survives a re-render. */
export function stableText(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`;
}

/**
 * Is this the SAME intended command? The key is never part of the comparison:
 * two attempts at one intent differ only by the key the second one WOULD have
 * minted, and that is exactly what must not be minted.
 */
export function sameCommandIntent(a, b) {
  const strip = (args) => {
    const rest = { ...(args || {}) };
    delete rest.idempotency_key;
    return rest;
  };
  return stableText(strip(a)) === stableText(strip(b));
}

/** Per-operation write bookkeeping. Plain data so it stays comparable. */
export function createCommandState() {
  return {};
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) if (!Object.isFrozen(inner)) deepFreeze(inner);
  return value;
}

function nextSince(state) {
  return Object.values(state).reduce((high, entry) => Math.max(high, entry.since || 0), 0) + 1;
}

/**
 * Claim the single in-flight command for one operation, or take back the
 * request that was never answered.
 *
 * Three answers:
 *   started   — send `request`. Brand new, or, for a retry of an unresolved
 *               operation, the ORIGINAL frozen one: same key, same arguments.
 *   in_flight — a request for this operation is open. Nothing is sent.
 *   blocked   — an earlier command on this operation is unresolved and this is
 *               a DIFFERENT intent. Nothing is sent; `pending` names what has
 *               to be reconciled first.
 */
export function beginCommand(state, { operationKey, args = {}, newKey }) {
  const commands = state || {};
  const current = commands[operationKey] || null;
  if (current && current.status === 'pending') {
    return { state: commands, started: false, status: 'in_flight', reason: 'in_flight', request: null, pending: current, retry: false };
  }
  if (current && !sameCommandIntent(current.request, args)) {
    return { state: commands, started: false, status: 'blocked', reason: 'unresolved', request: null, pending: current, retry: false };
  }
  // The retained request is reused WHOLE. Rebuilding it from today's inputs
  // would change what the server hashed under this key, which is precisely how
  // a retry stops being a retry.
  const request = current ? current.request : deepFreeze({ ...args, idempotency_key: newKey() });
  const entry = {
    operationKey, status: 'pending', request,
    attempts: (current?.attempts || 0) + 1,
    since: current?.since || nextSince(commands),
    reason: null, code: null, hint: null, message: null,
  };
  return {
    state: { ...commands, [operationKey]: entry },
    started: true, status: 'sending', reason: null, request,
    pending: null, retry: Boolean(current),
  };
}

/**
 * Record what the server actually said. An unknown answer KEEPS the entry —
 * that is the whole point of it — and every settled answer, including a
 * conflict and including a refusal, drops it so the next intent starts clean.
 */
export function settleCommand(state, operationKey, outcome) {
  const commands = state || {};
  const current = commands[operationKey];
  if (!current) return commands;
  if (outcome?.status === 'unknown') {
    return { ...commands, [operationKey]: {
      ...current,
      status: 'unknown',
      reason: outcome.reason || null,
      code: outcome.code || null,
      hint: outcome.hint || null,
      message: commandMessage(outcome),
    } };
  }
  const next = { ...commands };
  delete next[operationKey];
  return next;
}

/**
 * Classify one answer. Four statuses, and the differences between them are the
 * whole reason this exists:
 *
 *   ok       — the server said so. A replayed answer is the recorded result of
 *              the SAME operation, so it counts exactly as much as the first.
 *   conflict — the version this request was built on is not the version there
 *              is: a partner's event landed first, a confirmation is required,
 *              or the base version was missing or stale. Server-authoritative
 *              and terminal for this request; the person re-reads and decides.
 *   refused  — a DECISION about this request: declined by the verb, a key
 *              already spent on different arguments, or a 401/403 at the door.
 *   unknown  — we do not know whether it landed. `no_answer` (nothing came
 *              back at all) and `server_error` (something came back and it was
 *              the server failing) are kept apart because they are different
 *              evidence. A fault must never be badged as a refusal: the write
 *              may well have committed.
 */
export function classifyCommandOutcome({ response = null, error = null } = {}) {
  if (error) {
    const code = error?.payload?.error || null;
    const hint = error?.payload?.hint || null;
    const httpStatus = Number(error?.status ?? error?.http_status ?? 0) || null;
    if (code === 'version_conflict') return { status: 'conflict', reason: 'version_conflict', code, hint, http_status: httpStatus };
    if (code === 'needs_confirm') return { status: 'conflict', reason: 'needs_confirm', code, hint, http_status: httpStatus };
    if (code && BASE_VERSION_CODES.has(code)) return { status: 'conflict', reason: 'base_version', code, hint, http_status: httpStatus };
    if (code === 'key_reuse') return { status: 'refused', reason: 'key_reuse', code, hint, http_status: httpStatus };
    if (code && SERVER_FAULT_CODES.has(code)) return { status: 'unknown', reason: 'server_error', code, hint: null, http_status: httpStatus };
    if (code) return { status: 'refused', reason: 'declined', code, hint, http_status: httpStatus };
    if (DEFINITIVE_HTTP.has(httpStatus)) {
      return { status: 'refused', reason: 'unauthorized', code: `http_${httpStatus}`, hint: null, http_status: httpStatus };
    }
    if (httpStatus) return { status: 'unknown', reason: 'server_error', code: null, hint: null, http_status: httpStatus };
    return { status: 'unknown', reason: 'no_answer', code: null, hint: null, http_status: null };
  }
  // The conflict shape first: it carries no `ok:true`, and reading it as a
  // success because nothing said `ok:false` would be the worst possible
  // misreading of an answer that exists to say "not saved".
  if (response && response.conflict && (response.ok === false || response.status === 'conflict')) {
    return { status: 'conflict', reason: 'version_conflict', code: null, hint: null, conflict: response.conflict };
  }
  if (response && response.ok !== false && (response.ok === true || response.status === 'ok')) {
    return {
      status: 'ok', reason: null, code: null, hint: null,
      replayed: response.replayed === true,
      // Taken from the answer verbatim, or null. Nothing here constructs one.
      event_id: response.event_id ?? null,
      event_recorded_at: response.event_recorded_at ?? null,
    };
  }
  return { status: 'unknown', reason: 'no_answer', code: null, hint: null, http_status: null };
}

/**
 * The sentence a person sees. The server's own hint comes FIRST and verbatim
 * for a decline — it is the only text that knows why this particular request
 * was declined — and the table above is the fallback for codes that travel
 * bare. An accepted answer says nothing unless the record moved under it.
 */
export function commandMessage(outcome, subject = 'This change') {
  if (!outcome) return null;
  if (outcome.status === 'ok') {
    return outcome.superseded === true ? `${subject} ${COMMAND_SENTENCE.superseded}` : null;
  }
  if (outcome.reason === 'declined') {
    return `${subject} was refused by the server: ${outcome.hint || `${humanize(outcome.code) || 'no reason given'}.`}`;
  }
  const tail = COMMAND_SENTENCE[outcome.reason] || COMMAND_SENTENCE.no_answer;
  // The status, when there is one, and never the body: a person reporting this
  // can name what came back, and a server stack is not something to show them.
  const status = outcome.http_status ? ` (HTTP ${outcome.http_status})` : '';
  return `${subject} ${tail}${status}`;
}

/**
 * Which feedback state the shared visual system shows for a kernel status. The
 * one non-obvious mapping is the retry of an unknown: that is not a fresh save,
 * it is the reconcile, and it reads as `checking`.
 */
export function feedbackStateFor({ status, retry = false } = {}) {
  const state = (() => {
    switch (status) {
      case 'sending': return retry === true ? 'checking' : 'pending';
      case 'in_flight': return 'pending';
      case 'ok': return 'confirmed';
      case 'refused':
      case 'conflict': return 'refused';
      case 'blocked':
      case 'unknown': return 'unknown';
      case 'undone': return 'undone';
      default: return 'idle';
    }
  })();
  if (!FEEDBACK_STATES.includes(state)) throw new TypeError(`${state} is not a feedback state`);
  return state;
}

/**
 * Every operation whose command is still unresolved — what a dock needs in
 * order to offer a reconcile of THAT operation rather than a fresh guess at it.
 * Newest last, by the order the operations were claimed in.
 */
export function unresolvedCommands(state) {
  return Object.values(state || {})
    .filter((entry) => entry.status === 'unknown')
    .sort((a, b) => (a.since || 0) - (b.since || 0))
    .map((entry) => ({
      operationKey: entry.operationKey,
      request: entry.request,
      idempotency_key: entry.request.idempotency_key,
      since: entry.since,
    }));
}

/** The retained entry for one operation, or null. Nothing here mutates state. */
export function pendingCommand(state, operationKey) {
  return (state || {})[operationKey] || null;
}

/**
 * Send one command end to end against an injected `call`.
 *
 * The claim is published through `setState` BEFORE the request is awaited, so a
 * second click during the round trip sees the pending entry and sends nothing.
 * The request is never rejected out of this function: a transport that throws
 * becomes an `unknown` outcome with a sentence attached.
 *
 * @param {Object} options
 * @param {string} options.operationKey the one operation this command belongs to
 * @param {Object} options.args every argument except the idempotency key
 * @param {() => Object} options.getState
 * @param {(state:Object) => void} options.setState
 * @param {() => string} options.newKey
 * @param {(request:Object) => Promise<any>} options.call receives the frozen request
 * @param {(request:Object, outcome:Object) => boolean} [options.supersededBy] the
 *   caller's own test for "something newer landed while this was out"; only a
 *   surface that tracks per-record versions supplies one
 */
export async function performCommand({ operationKey, args = {}, getState, setState, newKey, call, supersededBy = null }) {
  const claim = beginCommand(getState(), { operationKey, args, newKey });
  setState(claim.state);
  if (!claim.started) {
    return {
      operationKey, started: false, sent: false, status: claim.status, reason: claim.reason,
      code: null, hint: null, http_status: null, replayed: false, superseded: false, retry: false,
      event_id: null, event_recorded_at: null, conflict: null,
      request: claim.pending?.request || null, pending: claim.pending,
      message: commandMessage({ status: claim.status, reason: claim.reason }),
      response: null,
    };
  }
  let response = null;
  let error = null;
  try {
    response = await call(claim.request);
  } catch (caught) {
    error = caught;
  }
  const classified = classifyCommandOutcome({ response, error });
  const outcome = (classified.status === 'ok' && typeof supersededBy === 'function')
    ? { ...classified, superseded: supersededBy(claim.request, classified) === true }
    : classified;
  setState(settleCommand(getState(), operationKey, outcome));
  return {
    operationKey, started: true, sent: true, status: outcome.status,
    reason: outcome.reason || null, code: outcome.code || null, hint: outcome.hint || null,
    http_status: outcome.http_status || null,
    replayed: outcome.replayed === true, superseded: outcome.superseded === true,
    retry: claim.retry === true,
    event_id: outcome.event_id ?? null,
    event_recorded_at: outcome.event_recorded_at ?? null,
    conflict: outcome.conflict || null,
    request: claim.request,
    pending: pendingCommand(getState(), operationKey),
    message: commandMessage(outcome),
    response,
  };
}

// ------------------------------------------------------------------ the dock

/**
 * One receipt, as data. The caller owns the summary text and whether this
 * operation can be undone; everything else is read off the outcome.
 */
export function commandReceiptView(entry = {}) {
  const state = entry.state && FEEDBACK_STATES.includes(entry.state)
    ? entry.state
    : feedbackStateFor({ status: entry.status, retry: entry.retry });
  const detail = entry.reason || entry.message || (entry.request?.idempotency_key
    ? `safety key ${entry.request.idempotency_key}`
    : `operation ${entry.operationKey}`);
  return {
    operationKey: entry.operationKey,
    state,
    label: feedbackLabel({ state }),
    summary: entry.summary || '',
    detail,
    undo: entry.undo === true,
  };
}

/** The action a receipt in this state offers, or null. */
function receiptAction(view) {
  if (view.state === 'refused') return { event: 'dispatch', text: 'Try again', variant: 'btn-quiet' };
  if (view.state === 'unknown') return { event: 'reconcile', text: 'Check outcome', variant: 'btn-secondary' };
  if (view.state === 'confirmed' && view.undo === true) return { event: 'undo', text: 'Undo', variant: 'btn-quiet' };
  return null;
}

/** One receipt as HTML. Every value from a caller passes through escapeText. */
export function commandReceiptHtml(view) {
  const action = receiptAction(view);
  const button = action
    ? `<button type="button" class="btn ${action.variant}" data-op="${escapeText(view.operationKey)}" data-event="${action.event}">${action.text}</button>`
    : '';
  return `<div class="receipt" role="status" data-state="${escapeText(view.state)}" data-op="${escapeText(view.operationKey)}">`
    + `<span class="receipt-badge">${escapeText(view.label)}</span>`
    + `<div><b>${escapeText(view.summary)}</b><small>${escapeText(view.detail)}</small></div>`
    + `<div>${button}</div>`
    + '</div>';
}

/** The dock: the newest few receipts, oldest first, newest at the bottom. */
export function commandDockHtml(views = [], { limit = 4 } = {}) {
  return views.slice(-limit).map(commandReceiptHtml).join('');
}
