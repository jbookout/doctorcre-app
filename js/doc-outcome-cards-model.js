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
// This slice explicitly EXCLUDES the shared session adapter for exact open
// (S02 clause 3): that adapter is parked for a decision from Joe. So every
// card here renders the honest missing-capability state instead, worded to
// match js/sessions-model.js's NO_OPEN_SENTENCE: no control here ever opens,
// resumes or launches a native session. The only offered next step is the
// session ref, already on the card, for a person to paste into Claude Code
// themselves.

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
 * The scoped solution the spec asks for in place of the exact-open adapter,
 * worded to match sessions-model.js's NO_OPEN_SENTENCE. Nothing on this card
 * ever launches, resumes or takes over a session — the session ref shown is
 * the only thing offered, for a person to resume by hand.
 */
export const NO_ADAPTER_SENTENCE = "Opening the exact session isn't available yet: no verified host adapter. "
  + "Use the session ref shown to resume it in Claude Code.";

/** Permanent, beside the outcome cards heading. Matches sessions.js's pattern. */
export const OUTCOME_CARDS_NO_OPEN_SENTENCE = "These cards find and show outcomes. They cannot open a session. "
  + NO_ADAPTER_SENTENCE;

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
 * What the card says about opening the exact session. `open` is always
 * false — there is no argument and no payload shape that turns it true in
 * this slice, because the shared session adapter (S02 clause 3) is parked.
 */
export function sessionEntryView(card) {
  const entry = card.session_entry;
  if (!entry || entry.available !== true) {
    const reason = entry?.unavailable_reason ?? null;
    const fallback = entry?.fallback;
    const sessionRef = fallback && fallback.kind === "copy_session_id" ? fallback.value : null;
    return {
      open: false,
      available: false,
      reasonSentence: SESSION_ENTRY_REASON_SENTENCE[reason] ?? "The exact session cannot be opened from here.",
      scopedSolution: NO_ADAPTER_SENTENCE,
      sessionRef,
    };
  }
  // Even when the producer marks a target/capability as available, this
  // slice does not consume the shared session adapter (parked). The state
  // stays honest about what IS recorded while still never opening anything.
  return {
    open: false,
    available: true,
    reasonSentence: "A session target is recorded, but this build has no adapter wired to open it.",
    scopedSolution: NO_ADAPTER_SENTENCE,
    sessionRef: isText(entry.target) ? entry.target : null,
  };
}

/** Everything one outcome card renders, carrying only what the read said. */
export function outcomeCard(card) {
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
    sessionEntry: sessionEntryView(card),
  };
}

/** The producer's order, preserved. Nothing here re-ranks or re-filters. */
export function outcomeCards(payload) {
  return (Array.isArray(payload?.cards) ? payload.cards : []).map(outcomeCard);
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
