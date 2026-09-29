// V5-UX-B09 (clause: "Display persistent outcome/owner/phase/next-check/result
// cards with qualified routing state") — the Doc outcome cards on the
// Conversations page: payload decisions only. No DOM here.
//
// The producer is `read-doc-outcome-cards` (mcp-server/src/tools.js,
// docOutcomeCardsProjection wrapping ops.read_doc_outcome_cards_successor,
// migration 0546). It is a bounded, actor- and tenant-scoped PROJECTION: it
// creates no writer, dispatcher, retry, task or native-session authority, and
// it never launches anything. Every card it returns already carries
// `session_entry.auto_launch === false`, and the server refuses to answer at
// all if that is not true — this file's validator checks the same invariant
// again on the client side rather than trusting the network.
//
// Exact open consumes only a producer-proved Codex Desktop target. A card
// without that binding keeps its recorded session-reference fallback.
import { outcomeOpenTarget } from './open-session-model.js';

/* ---------------------------------------------------------- producer vocabulary */

export const ROUTING_STATES = Object.freeze(["queued", "active", "waiting", "failed", "unknown", "verified"]);
export const INTENT_KINDS = Object.freeze(["recommendation", "submission"]);

export const ROUTING_STATE_LABEL = Object.freeze({
  queued: "queued", active: "active", waiting: "waiting",
  failed: "failed", unknown: "unknown", verified: "verified",
});

export const INTENT_LABEL = Object.freeze({
  recommendation: "Recommendation",
  submission: "Submission",
});

/* ------------------------------------------------------ the honesty sentences */

/**
 * Manual fallback for a card with a recorded session reference. It never
 * launches, messages, or takes over a session.
 */
export const NO_ADAPTER_SENTENCE = "Use the session ref shown to resume this session in its recorded host.";

/** Permanent, beside the outcome cards heading. Matches sessions.js's pattern. */
export const OUTCOME_CARDS_NO_OPEN_SENTENCE = "A card offers Open only when CARR records an exact Codex Desktop target. "
  + "Other cards keep their session-reference fallback.";

const SESSION_ENTRY_REASON_SENTENCE = Object.freeze({
  session_relation_unavailable: "No session is linked to this outcome yet.",
  native_open_unsupported: "This outcome's session is on a host Doc has no verified adapter for.",
  host_available_but_native_task_unbound: "A host is recorded for this session, but no native task is bound to open yet.",
  host_unavailable: "The recorded host for this session cannot be reached right now.",
});

const isText = (value) => typeof value === "string" && value.length > 0;
const isBool = (value) => typeof value === "boolean";

/* ----------------------------------------------------------------- validators */

/**
 * Refuse a `read-doc-outcome-cards` payload BY NAME, before any view sees it.
 * `null` means the payload is renderable; a string is the rule that refused
 * it. This mirrors `docOutcomeCardsProjection` (mcp-server/src/tools.js)
 * rather than trusting the network to have enforced it.
 */
export function refuseDocOutcomeCards(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return "doc_outcome_cards_unavailable";
  if (payload.schema_version !== "doc-outcome-cards.v2") return "doc_outcome_cards_schema_mismatch";
  if (!Array.isArray(payload.cards)) return "doc_outcome_cards_not_an_array";
  if (!isBool(payload.more)) return "doc_outcome_cards_more_not_a_boolean";
  if (payload.more === true && !isText(payload.next_cursor)) return "doc_outcome_cards_more_without_cursor";
  for (const card of payload.cards) {
    if (!card || typeof card !== "object") return "doc_outcome_card_not_an_object";
    if (!isText(card.card_id)) return "doc_outcome_card_without_id";
    if (!isText(card.work_request_ref)) return "doc_outcome_card_without_work_request_ref";
    if (!INTENT_KINDS.includes(card.intent_kind)) return "doc_outcome_card_unknown_intent_kind";
    if (!ROUTING_STATES.includes(card.routing_state)) return "doc_outcome_card_unknown_routing_state";
    if (!card.source_freshness || !["fresh", "stale"].includes(card.source_freshness.state)) {
      return "doc_outcome_card_freshness_malformed";
    }
    if (!card.next_check || typeof card.next_check.available !== "boolean") return "doc_outcome_card_next_check_malformed";
    if (card.next_check.available === true && card.next_check.value == null) return "doc_outcome_card_next_check_available_without_value";
    if (!card.result || typeof card.result.available !== "boolean") return "doc_outcome_card_result_malformed";
    if (card.result.available === true && card.result.value == null) return "doc_outcome_card_result_available_without_value";
    if (!Object.hasOwn(card, "native_task_id")) return "doc_outcome_card_without_native_task_id";
    // The load-bearing refusal: a card that could auto-launch, or that omits
    // the field entirely, is not renderable here. Checkable_done: "No
    // auto-launch from opening/history or unsupported T3 path."
    if (!card.session_entry || card.session_entry.auto_launch !== false) return "doc_outcome_card_auto_launch_not_false";
  }
  return null;
}

/* ------------------------------------------------------------------- the card */

/** Owner, honestly absent rather than defaulted to a placeholder actor. */
function ownerView(card) {
  return isText(card.owner) ? card.owner : null;
}

/** `controlled_phase` renamed only for readability; the value is unedited. */
function phaseView(card) {
  return isText(card.controlled_phase) ? card.controlled_phase : null;
}

function freshnessView(card) {
  const freshness = card.source_freshness;
  if (!freshness) return { state: "unknown", observedAt: null, sourceRef: null, text: "Freshness unknown." };
  return {
    state: freshness.state,
    observedAt: freshness.observed_at ?? null,
    sourceRef: freshness.source_ref ?? null,
    text: freshness.state === "fresh" ? "Fresh as of the last observed change." : "Stale: no change observed in the last 24 hours.",
  };
}

/** Honest absent state for a field the server itself marks unavailable. */
function unavailableFieldView(field, availableLabel, absentLabel) {
  if (!field) return { available: false, value: null, text: absentLabel };
  if (field.available === true) return { available: true, value: field.value, text: `${availableLabel}: ${field.value}` };
  return { available: false, value: null, text: absentLabel };
}

function nextCheckView(card) {
  return unavailableFieldView(card.next_check, "Next check", "No next check has been proved yet.");
}

function resultView(card) {
  return unavailableFieldView(card.result, "Result", "No accepted outcome yet.");
}

/**
 * What the card says about opening the exact session. The server must emit an
 * explicit canonical/native binding before this view offers Open.
 */
export function sessionEntryView(card, options = {}) {
  const entry = card.session_entry;
  const target = outcomeOpenTarget(card, options);
  if (target.open) return {
    open: true, available: true, href: target.href, target,
    reasonSentence: 'Return to this exact Codex Desktop thread.',
    scopedSolution: null, sessionRef: target.copyId,
  };
  if (!entry || entry.available !== true) {
    const reason = entry?.unavailable_reason ?? null;
    const fallback = entry?.fallback;
    const sessionRef = fallback && fallback.kind === "copy_session_id" ? fallback.value
      : card?.canonical_session_id?.value ?? null;
    return {
      open: false,
      available: false,
      reasonSentence: SESSION_ENTRY_REASON_SENTENCE[reason] ?? "The exact session cannot be opened from here.",
      scopedSolution: sessionRef ? NO_ADAPTER_SENTENCE : null,
      sessionRef,
    };
  }
  // Even when the producer marks a target/capability as available, this
  // host may be unreachable from this browser. The canonical ID remains the
  // fallback; an unconfirmed native target is never treated as a launch hint.
  return {
    open: false,
    available: true,
    reasonSentence: entry.capability === 'codex_desktop_open_v1'
      ? 'The recorded Codex Desktop host is unavailable from this device.'
      : 'A session target is recorded, but its host has no supported open adapter here.',
    scopedSolution: card?.canonical_session_id?.value ? NO_ADAPTER_SENTENCE : null,
    sessionRef: card?.canonical_session_id?.value ?? null,
  };
}

/** Everything one outcome card renders, carrying only what the read said. */
export function outcomeCard(card, options = {}) {
  return {
    id: card.card_id,
    requestedOutcome: isText(card.requested_outcome) ? card.requested_outcome : null,
    workRequestRef: card.work_request_ref,
    intentKind: card.intent_kind,
    intentLabel: INTENT_LABEL[card.intent_kind] ?? card.intent_kind,
    owner: ownerView(card),
    phase: phaseView(card),
    routingState: card.routing_state,
    routingStateLabel: ROUTING_STATE_LABEL[card.routing_state] ?? card.routing_state,
    freshness: freshnessView(card),
    nextCheck: nextCheckView(card),
    result: resultView(card),
    sessionEntry: sessionEntryView(card, options),
  };
}

/** The producer's order, preserved. Nothing here re-ranks or re-filters. */
export function outcomeCards(payload, options = {}) {
  return (Array.isArray(payload?.cards) ? payload.cards : []).map(card => outcomeCard(card, options));
}

/* ---------------------------------------------------- empty and paging state */

export function outcomeCardsEmptyMessage(payload) {
  const rows = Array.isArray(payload?.cards) ? payload.cards.length : 0;
  return rows > 0 ? null : "No outcome cards are recorded for you.";
}

export function outcomeCardsPagingState(payload) {
  return { more: payload?.more === true, cursor: payload?.next_cursor ?? null };
}

/* ------------------------------------------------------- motion (rule 9293d609) */

/**
 * The recommendation → submission → outcome distinction, made drawable. Only
 * the stages the server actually reports are marked reached — this is a
 * READ of `intentKind`/`result.available`, never a guess or a timer. A card
 * is always at least a recommendation; `intent_kind === "submission"` means
 * the producer's own join found a job, and `result.available` means an
 * accepted outcome is recorded. The line never draws a stage the server did
 * not report.
 */
export function flowStages(card) {
  const submissionReached = card.intentKind === "submission";
  const outcomeReached = card.result.available === true;
  return [
    { id: "recommendation", label: "Recommendation", reached: true },
    { id: "submission", label: "Submission", reached: submissionReached },
    { id: "outcome", label: "Outcome", reached: outcomeReached },
  ];
}

/**
 * Whether the card's live indicator may pulse. Tied to the SAME
 * `source_freshness.state` the server computed from the real `as_of`
 * comparison (mcp-server migration 0546: `observed_at >= as_of - 24h`) —
 * never a client-side clock or a decorative timer. A stale card never
 * pulses: that would be faking activity the record layer does not report.
 */
export function isLive(card) {
  return card.freshness?.state === "fresh";
}

/**
 * Which of a card's displayed fields changed since the previous read, by
 * comparing the OUTCOME CARD VIEW (not the raw payload) so a field that
 * merely reformats the same underlying value never flashes as "changed".
 * `previous` is the prior render's `outcomeCard()` output for the same
 * `card_id`, or `null` on a card's first render (which is never flashed —
 * the entrance animation already says "this just appeared").
 */
export function changedFields(previous, current) {
  if (!previous) return { phase: false, nextCheck: false, result: false, routingState: false };
  return {
    phase: previous.phase !== current.phase,
    nextCheck: previous.nextCheck.value !== current.nextCheck.value || previous.nextCheck.available !== current.nextCheck.available,
    result: previous.result.value !== current.result.value || previous.result.available !== current.result.available,
    routingState: previous.routingState !== current.routingState,
  };
}

/* ---------------------------------------------------- request building */

/** The arguments sent to `read-doc-outcome-cards`. No actor is ever named. */
export function outcomeCardsRequest({ cursor = null, limit = null } = {}) {
  const args = {};
  if (isText(cursor)) args.cursor = cursor;
  if (Number.isInteger(limit) && limit >= 1 && limit <= 50) args.limit = limit;
  return args;
}
