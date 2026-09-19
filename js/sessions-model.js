// V5-UX-S02 clauses 1-2 — the Sessions tab, decided without a DOM.
//
// Two reads answer this tab: `read-session-identity` and `read-dispatch-history`,
// both live at producer 0f6cb388. Neither takes an actor argument; the server
// derives the acting actor, and this file never supplies one.
//
// Four facts about those payloads are load-bearing, and every rule below exists
// because of one of them. They were observed against production on 2026-09-18
// and the captures are in test/fixtures/session-identity.json.
//
//   1. `total_returned` IS NOT THE PAGE SIZE. `{}` answers 603 seen / 124
//      returned / 25 rows, and `{"limit":3}` answers 603 / 124 / 3 — the
//      returned count is the post-permission-filter total BEFORE `limit`.
//      Printing it as "shown here" is a lie, so `countsLine` returns three
//      separate numbers and there is no helper that equates any two of them.
//   2. A FILTERED empty list and an EMPTY SYSTEM are different answers.
//      `{"query":"reverent"}` answers permission_filtered true, total_seen 4,
//      sessions []. `{"query":"zzzznope"}` answers permission_filtered false,
//      total_seen 0, sessions []. Same empty array, two different truths, and
//      telling them apart is the whole of clause 1's "with permission filtering".
//   3. The producer gives NO relation field. Retry, replacement and resume are
//      DERIVED here by a stated four-rule procedure so a reviewer can check the
//      derivation instead of trusting it. Every live row today lands on rule 4.
//   4. An unknown `session_id` answers ok:true with events []. The read cannot
//      tell "no such session" from "no events for this session", so no sentence
//      here ever claims a session HAS no dispatches.
//
// This tab opens nothing. Opening the exact native session is S02's third
// clause, no supported host adapter exists, and a DISABLED open control would
// imply one could be enabled — so no branch below produces an open control at
// all, not even a refused one.

/* ---------------------------------------------------------- producer vocabulary */

export const SURFACES = Object.freeze(["claude", "codex", "capability", "harvested"]);
export const ALIAS_SOURCES = Object.freeze(["human", "derived"]);
export const WORK_STATES = Object.freeze(["working", "idle", "complete_unacknowledged", "disconnected", "unknown"]);
export const OBSERVATION_SOURCES = Object.freeze(["continuity_event", "checkpoint", "server_session", "harvest"]);
/** `sent` and `acted` are the only stages this substrate can prove. */
export const PROVABLE_STAGES = Object.freeze(["sent", "acted"]);

export const WORK_STATE_LABEL = Object.freeze({
  working: "working", idle: "idle", complete_unacknowledged: "complete, unacknowledged",
  disconnected: "disconnected", unknown: "unknown",
});

/** The producer's default page size, stated so the tab never invents one. */
export const DEFAULT_LIMIT = 25;

/* ------------------------------------------------------ the honesty sentences */

/** Permanent, beside the tab heading. Nothing here launches, resumes or takes over. */
export const NO_OPEN_SENTENCE = "This tab finds sessions and shows their lineage. It cannot open one. "
  + "Opening the exact native session is V5-UX-S02's third clause and no supported host adapter exists yet, "
  + "so no control here launches, resumes or takes over anything.";

/** In the drawer, whenever `stage_unavailable_reason` is non-null. */
export const STAGE_UNAVAILABLE_SENTENCE = "Sent and acted are the only stages this record layer can prove. "
  + "Received and acknowledged are returned as unavailable, reason no_dispatch_spine, because the underlying "
  + "room-turn table carries no session id and no acknowledgement column. V5-UX-C13's first clause — "
  + "\"Sent/received/acknowledged/acted are not conflated\" — is therefore not closed by this slice, and this "
  + "tab does not claim it.";

/** In the drawer whenever `events` is empty. Never "this session has none". */
export const EMPTY_HISTORY_SENTENCE = "No dispatch events are recorded for this id. That is not the same as "
  + "this session having none — the read answers identically for an id that does not exist.";

/** On the lineage line whenever rule 4 fires. Unknown, never absent. */
export const LINEAGE_UNRECORDED_SENTENCE = "Lineage is not recorded for this session. Its parent is unknown "
  + "rather than absent.";

/* ----------------------------------------------------------------- validators */

const isText = (value) => typeof value === "string" && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Refuse a `read-session-identity` payload BY NAME, before any view sees it.
 * `null` means the payload is renderable; a string is the rule that refused it
 * and is surfaced to the reader as itself.
 */
export function refuseSessionIdentity(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return "session_identity_unavailable";
  // Never coerced to []. An absent list is a broken answer, not an empty one.
  if (!Array.isArray(payload.sessions)) return "sessions_not_an_array";
  if (!isCount(payload.total_seen)) return "total_seen_not_a_count";
  if (!isCount(payload.total_returned)) return "total_returned_not_a_count";
  if (typeof payload.permission_filtered !== "boolean") return "permission_filtered_not_a_boolean";
  // Invariant 1's guard rail: a page can be smaller than the filtered set, never larger.
  if (payload.sessions.length > payload.total_returned) return "page_exceeds_total_returned";
  if (payload.total_returned > payload.total_seen) return "total_returned_exceeds_total_seen";
  // Invariant 2's guard rail: rows exist, none came back, and nothing explains it.
  if (payload.sessions.length === 0 && payload.permission_filtered === false && payload.total_seen > 0) {
    return "unexplained_empty_list";
  }
  for (const row of payload.sessions) {
    if (!row || typeof row !== "object") return "session_row_not_an_object";
    if (!isText(row.canonical_session_id)) return "session_row_without_canonical_id";
    if (!SURFACES.includes(row.surface)) return "unknown_surface";
    if (!ALIAS_SOURCES.includes(row.alias_source)) return "unknown_alias_source";
    if (!WORK_STATES.includes(row.work_state)) return "unknown_work_state";
    if (!OBSERVATION_SOURCES.includes(row.observation_source)) return "unknown_observation_source";
    // A state without the observation behind it is the inference C12 clause 2
    // forbids: it would be this app asserting liveness nobody measured.
    if (row.work_state !== "unknown" && !isText(row.work_state_evidence)) return "work_state_without_evidence";
    if (typeof row.parent_known !== "boolean") return "parent_known_not_a_boolean";
    if (typeof row.native_host_supported !== "boolean") return "native_host_supported_not_a_boolean";
    if (row.native_host_supported === false && row.native_host_id != null) return "unsupported_host_with_a_host_id";
    if (!isCount(row.attempt_count)) return "attempt_count_not_a_count";
  }
  return null;
}

/** Refuse a `read-dispatch-history` payload BY NAME. */
export function refuseDispatchHistory(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return "session_dispatch_history_unavailable";
  if (!Array.isArray(payload.events)) return "events_not_an_array";
  if (!isText(payload.session_id)) return "dispatch_without_session_id";
  if (!isCount(payload.total_seen) || !isCount(payload.total_returned)) return "dispatch_counts_not_counts";
  if (payload.events.length > payload.total_returned) return "dispatch_page_exceeds_total_returned";
  // The conflation C13 clause 1 forbids, caught before it can be painted: a
  // stage the substrate says it cannot prove must not arrive carrying a value.
  if (payload.stage_unavailable_reason === "no_dispatch_spine"
    && (payload.received != null || payload.acknowledged != null)) {
    return "unprovable_stage_carries_a_value";
  }
  if (payload.more === true && payload.next_cursor == null) return "more_without_a_cursor";
  for (const event of payload.events) {
    if (!event || typeof event !== "object") return "dispatch_event_not_an_object";
    if (!isText(event.event_id)) return "dispatch_event_without_an_id";
    if (!PROVABLE_STAGES.includes(event.stage)) return "unprovable_stage";
  }
  return null;
}

/* ------------------------------------------------------------- the counts line */

/**
 * Three numbers, never two of them equated. `shown` is the length of the array
 * that arrived; `visible` is the producer's post-filter total BEFORE `limit`;
 * `seen` is everything the query matched. The sentence names all three.
 */
export function countsLine(payload) {
  const seen = isCount(payload?.total_seen) ? payload.total_seen : null;
  const visible = isCount(payload?.total_returned) ? payload.total_returned : null;
  const shown = Array.isArray(payload?.sessions) ? payload.sessions.length : null;
  if (seen === null || visible === null || shown === null) {
    return { seen: null, visible: null, shown: null, text: "unknown" };
  }
  return {
    seen, visible, shown,
    text: `${seen} sessions exist, ${visible} you may see, ${shown} shown on this page`,
  };
}

/* ---------------------------------------------------- empty and filtered states */

/**
 * What the reader is told when the list is empty, and the banner that renders
 * whether or not it is. Invariant 2 lives here: an empty list is never one
 * message.
 */
export function listState(payload) {
  const filtered = payload?.permission_filtered === true;
  const seen = isCount(payload?.total_seen) ? payload.total_seen : 0;
  const rows = Array.isArray(payload?.sessions) ? payload.sessions.length : 0;
  const banner = filtered
    ? {
      state: "filtered",
      text: "Permission filtering is on for this answer: the record layer removed sessions you may not see "
        + "before it counted them.",
    }
    : null;
  if (rows > 0) return { state: "rows", banner, message: null };
  if (filtered) {
    return {
      state: "empty_filtered",
      banner,
      message: seen === 1
        ? "1 session matches and none is yours to see."
        : `${seen} sessions match and none is yours to see.`,
    };
  }
  return { state: "empty_plain", banner, message: "No session matches that." };
}

/* ------------------------------------------------------------- clause 2 lineage */

/**
 * The stated four-rule procedure, FIRST MATCH WINS. The producer carries no
 * relation field; this is the derivation, written out so it can be checked.
 *
 *   1. attempt_count > 1 AND latest_attempt_ref non-null -> retry
 *   2. parent_session_id non-null                        -> replacement
 *   3. attempt_count === 1 AND parent_known AND no parent -> resume
 *   4. otherwise                                         -> not recorded
 */
export function lineage(row) {
  if (row?.attempt_count > 1 && row?.latest_attempt_ref != null) {
    return {
      relation: "retry",
      label: "retry",
      text: `Retry: attempt ${row.attempt_count}, latest attempt ${row.latest_attempt_ref}.`,
      parent: row.parent_session_id ?? null,
      rule: 1,
    };
  }
  if (row?.parent_session_id != null) {
    return {
      relation: "replacement",
      label: "replacement",
      text: `Replacement of ${row.parent_session_id}.`,
      parent: row.parent_session_id,
      rule: 2,
    };
  }
  if (row?.attempt_count === 1 && row?.parent_known === true && (row?.parent_session_id ?? null) === null) {
    return {
      relation: "resume",
      label: "resume",
      text: "Resume: a known root, observed again. No parent session is recorded above it.",
      parent: null,
      rule: 3,
    };
  }
  return {
    relation: "not_recorded",
    label: "lineage not recorded",
    // "not recorded", never "no parent". parent_known false means the record
    // layer does not know, and absence is a claim it never made.
    text: LINEAGE_UNRECORDED_SENTENCE,
    parent: null,
    rule: 4,
  };
}

/**
 * Whether the whole page landed on rule 4, so the tab can say so plainly
 * instead of drawing three empty buckets.
 */
export function lineageSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { allUnrecorded: false, count: 0, text: null };
  const relations = list.map((row) => lineage(row).relation);
  const unrecorded = relations.filter((relation) => relation === "not_recorded").length;
  if (unrecorded !== list.length) return { allUnrecorded: false, count: unrecorded, text: null };
  return {
    allUnrecorded: true,
    count: unrecorded,
    text: `No session on this page has recorded lineage: all ${list.length} carry parent_known false, so retry, `
      + "replacement and resume cannot be told apart for any of them. That is the record layer's state today, "
      + "not a filter on this page.",
  };
}

/* ------------------------------------------------- clause 2 host and opening */

/**
 * What the card says about the native host, and — in every branch — that no
 * open control exists. `open` is always false here; there is no argument and
 * no payload that turns it true, because turning it true is clause 3.
 */
export function hostState(row) {
  if (row?.native_host_supported !== true) {
    return {
      state: "unsupported",
      open: false,
      text: "This session cannot be opened here: no supported native host is recorded for it.",
      hostId: null,
    };
  }
  if (row?.native_host_id == null) {
    return {
      state: "mismatch_no_host_id",
      open: false,
      text: "Host recorded as supported but no host id: the record layer says a native host exists and does not "
        + "say which one, so nothing here can name a window to open.",
      hostId: null,
    };
  }
  if (row.display_name !== row.native_host_id) {
    return {
      state: "title_mismatch",
      open: false,
      text: `Host title mismatch: this session is named "${row.display_name}" and its native host is recorded as `
        + `"${row.native_host_id}".`,
      hostId: row.native_host_id,
    };
  }
  return {
    state: "host_matches",
    open: false,
    text: `The session name matches its native host id, "${row.native_host_id}". Opening it is still not possible `
      + "from here.",
    hostId: row.native_host_id,
  };
}

/* ------------------------------------------------------------------- the card */

/** Everything one card renders, carrying only what the read said. */
export function sessionCard(row) {
  return {
    id: row.canonical_session_id,
    name: row.display_name ?? row.canonical_session_id,
    surface: row.surface,
    workState: row.work_state,
    workStateLabel: WORK_STATE_LABEL[row.work_state] ?? row.work_state,
    // Verbatim and always visible. It is the reason the state is believable,
    // so it is never folded behind a tooltip.
    evidence: isText(row.work_state_evidence) ? row.work_state_evidence : null,
    observedAt: row.last_observed_at ?? null,
    observationSource: row.observation_source,
    // A derived name is marked as derived. `alias_source` is "derived" on every
    // live row, and a human-typed alias has no store anywhere.
    derivedName: row.alias_source === "derived",
    projectAffinity: row.project_affinity ?? null,
    cwd: row.latest_cwd ?? null,
    modelId: row.latest_model_id ?? null,
    attemptCount: row.attempt_count,
    attemptRef: row.latest_attempt_ref ?? null,
    attemptsText: row.latest_attempt_ref == null
      ? `${row.attempt_count} attempt${row.attempt_count === 1 ? "" : "s"} recorded, no attempt reference`
      : `${row.attempt_count} attempt${row.attempt_count === 1 ? "" : "s"} recorded, latest ${row.latest_attempt_ref}`,
    lineage: lineage(row),
    host: hostState(row),
  };
}

/** The producer's order, preserved. Nothing here re-ranks or re-filters. */
export function sessionCards(payload) {
  return (Array.isArray(payload?.sessions) ? payload.sessions : []).map(sessionCard);
}

/* ----------------------------------------------------------- the history drawer */

/** One drawer's worth of dispatch, newest-first exactly as the producer sent it. */
export function dispatchView(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return {
    sessionId: payload?.session_id ?? null,
    parentSessionId: payload?.parent_session_id ?? null,
    // Not "no", not false, not zero: the stage is UNAVAILABLE and the reason is
    // named. Rendering "acknowledged: no" would assert an absence nobody proved.
    stagesUnavailable: payload?.stage_unavailable_reason != null,
    stageUnavailableReason: payload?.stage_unavailable_reason ?? null,
    receivedState: payload?.received == null ? "unavailable" : "recorded",
    acknowledgedState: payload?.acknowledged == null ? "unavailable" : "recorded",
    stageSentence: payload?.stage_unavailable_reason != null ? STAGE_UNAVAILABLE_SENTENCE : null,
    emptySentence: events.length === 0 ? EMPTY_HISTORY_SENTENCE : null,
    more: payload?.more === true,
    nextCursor: payload?.next_cursor ?? null,
    counts: {
      seen: isCount(payload?.total_seen) ? payload.total_seen : null,
      visible: isCount(payload?.total_returned) ? payload.total_returned : null,
      shown: events.length,
    },
    events: events.map((event) => ({
      id: event.event_id,
      at: event.at ?? null,
      stage: event.stage,
      evidence: event.stage_evidence ?? null,
      rationale: event.rationale ?? null,
      fromSeat: event.from_seat ?? null,
      toSeat: event.to_seat ?? null,
      sponsor: event.sponsor ?? null,
      roomId: event.room_id ?? null,
      attemptRef: event.attempt_ref ?? null,
      supersededBy: event.superseded_by ?? null,
      workRequestRef: event.work_request_ref ?? null,
    })),
  };
}

/* ------------------------------------------------------------- request building */

/**
 * The arguments sent to `read-session-identity`. An empty lookup sends NO
 * `query` rather than an empty one, because the verb's minLength is 1 — and no
 * actor is ever named, in any branch.
 */
export function identityRequest({ query = "", includeClosed = false, limit = DEFAULT_LIMIT } = {}) {
  const args = {};
  const text = String(query ?? "").trim();
  if (text.length > 0) args.query = text.slice(0, 200);
  if (includeClosed === true) args.include_closed = true;
  if (Number.isInteger(limit) && limit >= 1 && limit <= 50) args.limit = limit;
  return args;
}
