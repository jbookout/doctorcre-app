// V5-UX-C12 — the Model Room tab, decided without a DOM.
//
// Four reads answer this tab, all `write: false`, none of which takes an actor:
// `read-room-queue` and `read-room` (new here), plus `read-session-identity`
// and `read-dispatch-history` (shipped by V5-UX-S02 and NOT re-handled here).
// The session vocabulary is IMPORTED from ./sessions-model.js rather than
// restated, so a second copy of WORK_STATES cannot drift into existence.
//
// Six facts about those payloads are load-bearing, and every rule below exists
// because of one of them. They were observed against production on 2026-09-18
// and the captures are in test/fixtures/model-room-live-capture.json.
//
//   1. THE ASSIGNMENTS DO NOT LIVE IN THE ROOM THIS TAB IS NAMED AFTER.
//      `read-room-queue {}` answers room `partner-line` with four cards;
//      `read-room-queue {"room":"model-room"}` answers `model-room` with an
//      empty list and a null projection. Reading the queue from the tab's own
//      name would ship a blank page that is not wrong about anything, so the
//      room is a named constant (QUEUE_ROOM) and a test pins it.
//   2. `live` IS A TWO-MINUTE WINDOW, NOT AN OPINION. The producer sets
//      `live = freshest && now >= freshest && now - freshest <= 120_000`
//      (partner-room.js QUEUE_STALE_MS). Today's real answer is `live: false`
//      with a projection eighteen days old. That is this queue's ORDINARY
//      state: the age is printed plainly beside the board, never as an error
//      and never as zero assignments.
//   3. `projected_at: null` WITH AN EMPTY LIST IS A DIFFERENT TRUTH from a
//      stale projection. Nothing has ever been projected there. Two states,
//      two sentences, and no helper collapses them.
//   4. ONLY FULLY-VALIDATED RECEIPTS BECOME CARDS. The producer already
//      dropped every malformed turn, sorted by `card.updated_at` descending
//      and removed `archived`. So nothing here re-validates for taste,
//      re-sorts or re-filters — but an event that fails the shape check IS
//      counted and the count is rendered, because a silently dropped card is
//      a lie about the assignment list.
//   5. `seq` AND `latest_seq` ARRIVE AS STRINGS. The producer selects a bigint
//      column (`v_partner_room_turn.id`) and the driver serialises it as a
//      decimal string. Today's live answer is `latest_seq: "6475"` with
//      `turns[].seq` likewise strings. A validator demanding an integer would
//      refuse production, so both forms are accepted and neither is coerced
//      into arithmetic.
//   6. A TURN BODY IS UNTRUSTED PROSE, even when it is valid JSON. Several
//      live bodies are STATUS envelopes. The verb returns turns "exactly as
//      written"; this file never parses one, and the view renders it as text.
//
// This tab opens nothing and acknowledges nothing. See NO_OPEN_SENTENCE and
// NO_ACKNOWLEDGEMENT_SENTENCE below for why each refusal exists.
import {
  PROVABLE_STAGES, SURFACES, WORK_STATES, WORK_STATE_LABEL,
  countsLine, dispatchView, lineage, listState,
  refuseDispatchHistory, refuseSessionIdentity, sessionCards,
} from "./sessions-model.js";

export {
  PROVABLE_STAGES, SURFACES, WORK_STATES, WORK_STATE_LABEL,
  countsLine, dispatchView, lineage, listState,
  refuseDispatchHistory, refuseSessionIdentity, sessionCards,
};

/* ------------------------------------------------------- producer vocabulary */

/**
 * Fact 1. The assignments are projected into `partner-line`, board
 * `carr-build`; `model-room` carries the conversation and no queue at all, so
 * reading the queue from the tab's own name would render an empty board that
 * is not wrong about anything.
 */
export const QUEUE_ROOM = "partner-line";

/** The room whose turns are the conversation this tab shows. */
export const TURN_ROOM = "model-room";

/** The producer's only queue board (`partner-room.js` queue validation). */
export const QUEUE_BOARD = "carr-build";

/** The producer's staleness window, in milliseconds (QUEUE_STALE_MS). */
export const QUEUE_STALE_MS = 120000;

/** The exact key sets the producer validates before a turn becomes a card. */
export const QUEUE_EVENT_KEYS = Object.freeze(
  ["v", "board", "event_id", "event", "task_id", "card", "summary", "projected_at"]);
export const QUEUE_CARD_KEYS = Object.freeze(
  ["title", "target", "effective_model", "status", "priority", "cap", "updated_at", "source_seq"]);
export const TURN_KEYS = Object.freeze(
  ["seq", "room_id", "at", "sponsor", "seat", "kind", "body", "msg_id", "origin_channel", "origin_actor"]);

/** How many turns one visit reads. There is no timer anywhere in this slice. */
export const TURN_LIMIT = 25;

/* ----------------------------------------------------- the honesty sentences */

/**
 * In the context panel, exactly where an "Open session" control would sit.
 * No branch of this slice produces one, not even a disabled one: a disabled
 * control implies one could be enabled, and none could be.
 */
export const NO_OPEN_SENTENCE = "This page can identify the exact session but cannot open it. "
  + "Opening a native session is V5-UX-S02's third clause; no supported host adapter exists, every session "
  + "here answers native_host_supported: false, and a control that appeared here would imply otherwise. "
  + "Copy the canonical session ID instead.";

/** Under Participants: room turns and dispatch acknowledgements are different records. */
export const ACKNOWLEDGEMENT_SENTENCE = "Room participants come from conversation turns. Dispatch receipt and "
  + "acknowledgment come only from the selected session's dispatch history; this participant list never infers "
  + "either state from a message.";

/** Beside the dispatch lineage, always. */
export const DISPATCH_SEARCH_SENTENCE = "Search by a session's friendly name or canonical ID, including closed "
  + "sessions, then choose one result to read its evidence-bound dispatch trail. Search and history are read-only; "
  + "historical instructions are displayed as records and never executed.";

/** Beside the dispatch stages, always. */
export const DISPATCH_STAGES_SENTENCE = "Sent, received, acknowledged and acted remain separate evidence rows. "
  + "A missing stage stays unavailable: not_acknowledged means a linked dispatch has no receipt for that stage; "
  + "no_dispatch_spine marks pre-spine history matched only from its room-turn body.";

/** Beside the assignments board, stating where the cards actually come from. */
export const QUEUE_ROOM_SENTENCE = `Assignments are read from room ${QUEUE_ROOM}, board ${QUEUE_BOARD}, which is `
  + `where the projector writes them. The room ${TURN_ROOM} carries this tab's conversation and no queue at all.`;

/** Under the turn list whenever the read says there is more behind it. */
export const WINDOW_SENTENCE = "This is a window on the room, not the whole of it: the read answered more: true, "
  + "so the number of turns below is what this page asked for and not a count of what exists.";

/* --------------------------------------------------------------- validators */

const isText = (value) => typeof value === "string" && value.length > 0;
const isStamp = (value) => isText(value) && Number.isFinite(Date.parse(value));
/** Fact 5: a bigint arrives as a decimal string; an integer is accepted too. */
const isSeq = (value) => Number.isInteger(value) || /^[0-9]+$/.test(String(value ?? ""));

/**
 * Refuse a `read-room-queue` payload BY NAME, before any view sees it.
 * `null` means renderable; a string is the rule that refused it, surfaced to
 * the reader as itself. Nothing here is defaulted or coerced.
 */
export function refuseRoomQueue(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return "room_queue_unavailable";
  if (!isText(payload.room)) return "room_queue_without_a_room";
  // Never coerced to []. An absent list is a broken answer, not an empty one.
  if (!Array.isArray(payload.events)) return "queue_events_not_an_array";
  // Fact 2: a missing `live` is a refusal, because defaulting it to false would
  // make an unreadable projection indistinguishable from a stale one.
  if (typeof payload.live !== "boolean") return "queue_live_not_a_boolean";
  // Fact 3: null is a real answer; anything unparseable is not.
  if (payload.projected_at !== null && !isStamp(payload.projected_at)) return "queue_projected_at_not_a_stamp";
  if (payload.live === true && payload.projected_at === null) return "live_queue_without_a_projection";
  return null;
}

/**
 * Refuse a `read-room` payload BY NAME. `turns` arrive oldest-first and are
 * never re-ordered here.
 */
export function refuseRoomTurns(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return "room_turns_unavailable";
  if (!isText(payload.room)) return "room_turns_without_a_room";
  if (!Array.isArray(payload.turns)) return "turns_not_an_array";
  if (typeof payload.more !== "boolean") return "turns_more_not_a_boolean";
  if (!isSeq(payload.latest_seq)) return "latest_seq_not_a_sequence";
  for (const turn of payload.turns) {
    if (!turn || typeof turn !== "object") return "turn_not_an_object";
    if (!isSeq(turn.seq)) return "turn_without_a_sequence";
    if (!isStamp(turn.at)) return "turn_without_a_timestamp";
    // Fact 6: body must be present as a STRING. A parsed object arriving here
    // would mean somebody parsed it upstream, which this slice forbids.
    if (typeof turn.body !== "string") return "turn_body_not_text";
  }
  return null;
}

/**
 * Fact 4's shape check, applied to ONE event. `null` means the event renders;
 * a string names the rule that dropped it, and the caller counts it.
 */
export function refuseQueueEvent(event) {
  if (!event || typeof event !== "object") return "event_not_an_object";
  const keys = Object.keys(event);
  if (keys.length !== QUEUE_EVENT_KEYS.length || !QUEUE_EVENT_KEYS.every((key) => Object.hasOwn(event, key))) {
    return "event_key_set_is_not_the_projector_shape";
  }
  if (event.v !== 1) return "event_version_is_not_1";
  if (event.board !== QUEUE_BOARD) return "event_board_is_not_carr_build";
  if (!isText(event.task_id)) return "event_without_a_task_id";
  if (!isStamp(event.projected_at)) return "event_projected_at_not_a_stamp";
  if (typeof event.summary !== "string") return "event_summary_not_text";
  const card = event.card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return "event_without_a_card";
  if (!QUEUE_CARD_KEYS.every((key) => Object.hasOwn(card, key))) return "card_key_set_is_not_the_projector_shape";
  for (const key of ["title", "target", "status", "priority", "cap", "updated_at"]) {
    if (!isText(card[key])) return `card_${key}_not_text`;
  }
  if (!isStamp(card.updated_at)) return "card_updated_at_not_a_stamp";
  if (!(card.source_seq === null || (Number.isInteger(card.source_seq) && card.source_seq >= 0))) {
    return "card_source_seq_not_a_sequence_or_null";
  }
  // The producer itself checks `typeof` against both, so a card may legitimately
  // carry a structured model. Rendering it needs a branch, never interpolation.
  if (card.effective_model === null) return "card_effective_model_not_a_model";
  if (!["string", "object"].includes(typeof card.effective_model)) return "card_effective_model_not_a_model";
  return null;
}

/* ------------------------------------------------------------- the freshness */

/**
 * The four states of the line above the assignments board, from the producer's
 * two fields and the reader's clock — never from the clock alone.
 *
 *   F1 live            `live: true`
 *   F2 stale           `live: false` with a projection: TODAY'S REAL ANSWER
 *   F3 never projected `live: false` with `projected_at: null`
 *   F4 unavailable     the read did not answer, or was refused
 *
 * F2 and F3 are different sentences on purpose (fact 3), and F2 is not an
 * error: the board below it is the last projection and is still shown.
 */
export function queueFreshness(payload, { now = Date.now() } = {}) {
  if (payload === null || payload === undefined) {
    return { state: "unavailable", ageMs: null, projectedAt: null, text: "The queue could not be read." };
  }
  const projectedAt = payload.projected_at ?? null;
  if (payload.live === true) {
    return {
      state: "live",
      ageMs: projectedAt ? Math.max(0, now - Date.parse(projectedAt)) : null,
      projectedAt,
      text: `Projected ${projectedAt}, inside the projector's ${QUEUE_STALE_MS / 1000}-second window.`,
    };
  }
  if (projectedAt === null) {
    return {
      state: "never",
      ageMs: null,
      projectedAt: null,
      text: "Nothing has been projected into this queue. That is not a stale projection and not an empty board: "
        + "the projector has never written here.",
    };
  }
  const ageMs = Math.max(0, now - Date.parse(projectedAt));
  return {
    state: "stale",
    ageMs,
    projectedAt,
    text: `Projected ${projectedAt}, stale by ${humanAge(ageMs)}; the assignments below are the last projection.`,
  };
}

/** Whole units, largest first, so a still screenshot carries the age in text. */
export function humanAge(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** C13 clause 3: the name/ID lookup is explicit, bounded and includes history. */
export function dispatchSearchRequest(query) {
  const text = String(query ?? "").trim();
  if (text.length === 0) return null;
  return { query: text.slice(0, 200), include_closed: true, limit: 50 };
}

/* ---------------------------------------------------------- the assignments */

/** How a card's `effective_model` is shown. Fact: it may be an object. */
export function effectiveModelText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // A named model inside the object, else the object's own field list. Never
    // String(value), which is the `[object Object]` this branch exists to stop.
    const named = ["id", "model", "name", "slug"].find((key) => isText(value[key]));
    if (named) return String(value[named]);
    const keys = Object.keys(value);
    return keys.length === 0 ? "a model object with no fields" : `a model object: ${keys.join(", ")}`;
  }
  return "unknown";
}

/**
 * The board, in the SERVER'S ORDER. Fact 4: no sort, no filter, no re-rank —
 * and an event that fails the shape check is dropped AND counted, because a
 * silently dropped card is a lie about the assignment list.
 */
export function assignmentBoard(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const cards = [];
  const dropped = [];
  for (const event of events) {
    const refusal = refuseQueueEvent(event);
    if (refusal) { dropped.push(refusal); continue; }
    cards.push({
      eventId: event.event_id,
      event: event.event,
      taskId: event.task_id,
      title: event.card.title,
      target: event.card.target,
      effectiveModel: effectiveModelText(event.card.effective_model),
      effectiveModelIsObject: typeof event.card.effective_model === "object",
      status: event.card.status,
      priority: event.card.priority,
      cap: event.card.cap,
      updatedAt: event.card.updated_at,
      sourceSeq: event.card.source_seq,
      sourceSeqText: event.card.source_seq === null
        ? "no source sequence recorded" : `source sequence ${event.card.source_seq}`,
      summary: event.summary,
      projectedAt: event.projected_at,
    });
  }
  return {
    cards,
    droppedCount: dropped.length,
    droppedReasons: dropped,
    droppedText: dropped.length === 0 ? null
      : `${dropped.length} projected event${dropped.length === 1 ? " was" : "s were"} not in the projector's shape `
        + `and ${dropped.length === 1 ? "is" : "are"} not shown: ${[...new Set(dropped)].join(", ")}.`,
    // Never "there are no assignments": an empty board under a stale projection
    // is an old answer, not a claim about the board now.
    emptyText: cards.length > 0 ? null
      : "No assignment card is in this projection. That is what the projector last wrote, not a count of the work "
        + "that exists.",
  };
}

/* ---------------------------------------------------------- the participants */

/**
 * Distinct seat/sponsor pairs in the WINDOW that was read, each with the `at`
 * of its most recent turn. Deriving the set is not a sort of the turns: the
 * turns keep the producer's order and this is a separate roll-up whose own
 * order is first appearance.
 *
 * No participant carries an acknowledgment state, a pending count or a zero.
 * See NO_ACKNOWLEDGEMENT_SENTENCE.
 */
export function participants(payload) {
  const turns = Array.isArray(payload?.turns) ? payload.turns : [];
  const byKey = new Map();
  for (const turn of turns) {
    const seat = isText(turn.seat) ? turn.seat : "unknown";
    const sponsor = isText(turn.sponsor) ? turn.sponsor : "unknown";
    const key = `${seat} / ${sponsor}`;
    const channel = isText(turn.origin_channel) ? turn.origin_channel : "unknown";
    const actor = isText(turn.origin_actor) ? turn.origin_actor : "unknown";
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key, seat, sponsor, lastAt: turn.at ?? null, originChannel: channel, originActor: actor, turns: 1,
      });
      continue;
    }
    existing.turns += 1;
    if (existing.lastAt === null || Date.parse(turn.at) >= Date.parse(existing.lastAt)) {
      existing.lastAt = turn.at ?? null;
      existing.originChannel = channel;
      existing.originActor = actor;
    }
  }
  return [...byKey.values()];
}

/**
 * The turn window as it is rendered: the producer's order kept, every body
 * carried as TEXT, and the window stated whenever `more` is true (fact 6 and
 * the counts rule S02 already fixed).
 */
export function turnWindow(payload) {
  const turns = Array.isArray(payload?.turns) ? payload.turns : [];
  return {
    room: payload?.room ?? null,
    latestSeq: payload?.latest_seq == null ? null : String(payload.latest_seq),
    more: payload?.more === true,
    shown: turns.length,
    windowText: payload?.more === true ? WINDOW_SENTENCE : null,
    quietText: turns.length === 0
      ? "No turn is in this window. A quiet room is an honest answer and not an outage." : null,
    turns: turns.map((turn) => ({
      seq: String(turn.seq),
      at: turn.at ?? null,
      seat: isText(turn.seat) ? turn.seat : "unknown",
      sponsor: isText(turn.sponsor) ? turn.sponsor : "unknown",
      kind: isText(turn.kind) ? turn.kind : "unknown",
      originChannel: isText(turn.origin_channel) ? turn.origin_channel : "unknown",
      originActor: isText(turn.origin_actor) ? turn.origin_actor : "unknown",
      msgId: isText(turn.msg_id) ? turn.msg_id : null,
      // TEXT. Never parsed, never trusted, never rendered as structure, even
      // when it is valid JSON — which several live bodies are.
      body: String(turn.body ?? ""),
    })),
  };
}

/* --------------------------------------------------------- the context panel */

/**
 * The parent line, clause 2's half the Sessions tab could not draw: a parent
 * named but NOT RETURNED in the same answer is a real state, because permission
 * filtering makes it one. It is never a dead link.
 */
export function parentLine(row, payload) {
  const ids = new Set((Array.isArray(payload?.sessions) ? payload.sessions : [])
    .map((session) => session.canonical_session_id));
  const parent = row?.parent_session_id ?? null;
  if (parent === null) {
    return row?.parent_known === true
      ? {
        state: "known_root", parent: null, linkable: false,
        text: "Initiator is a known root: no session is recorded above it.",
      }
      : { state: "unrecorded", parent: null, linkable: false, text: "Initiator not recorded." };
  }
  if (ids.has(parent)) {
    return { state: "present", parent, linkable: true, text: `Initiator ${parent}, on this page.` };
  }
  return {
    state: "outside",
    parent,
    linkable: false,
    text: `Initiator ${parent} is outside what you may see: it is named by this session and is not in this answer, `
      + "so it is not linked.",
  };
}

/**
 * Everything the context panel renders for one selected session. Work state and
 * parent contact are TWO independent lines and are never merged (clause 2), and
 * the evidence is carried verbatim — never derived from the display name.
 */
export function contextPanel(row, payload) {
  if (!row) return null;
  return {
    id: row.canonical_session_id,
    name: row.display_name ?? row.canonical_session_id,
    aliasSource: row.alias_source,
    aliasText: `friendly name is ${row.alias_source}`,
    surface: row.surface,
    workState: row.work_state,
    workStateLabel: WORK_STATE_LABEL[row.work_state] ?? row.work_state,
    // Verbatim, in full, never truncated and never paraphrased. Absent evidence
    // is stated as absent; it never falls back to any other field.
    evidence: isText(row.work_state_evidence) ? row.work_state_evidence : null,
    evidenceText: isText(row.work_state_evidence)
      ? row.work_state_evidence
      : "No observation is recorded behind this state.",
    parent: parentLine(row, payload),
    lineage: lineage(row),
    projectAffinity: row.project_affinity ?? null,
    cwd: row.latest_cwd ?? null,
    modelId: row.latest_model_id ?? null,
    attemptCount: row.attempt_count,
    attemptRef: row.latest_attempt_ref ?? null,
    // Always false, in every branch. There is no argument and no payload that
    // turns it true, because turning it true is V5-UX-S02 clause 3.
    open: false,
    noOpenText: NO_OPEN_SENTENCE,
  };
}

/* ---------------------------------------------------------- request building */

/** The queue read's arguments. The room is the constant, never the tab name. */
export function queueRequest() {
  return { room: QUEUE_ROOM };
}

/** The turn read's arguments. No actor, no sponsor, no tenant, in any branch. */
export function turnRequest({ afterSeq = null, limit = TURN_LIMIT } = {}) {
  const args = { room: TURN_ROOM };
  if (Number.isInteger(afterSeq) && afterSeq > 0) args.after_seq = afterSeq;
  if (Number.isInteger(limit) && limit >= 1 && limit <= 200) args.limit = limit;
  return args;
}
