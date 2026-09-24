// V5-UX-C12 Model Room — one named test per behaviour, one named mutation each.
//
// THE PROOF SPLIT, stated because it is a real limit on what these tests close:
//
//   * THE TWO NEW READS are proven against the CAPTURED PRODUCTION PAYLOADS in
//     test/fixtures/model-room-live-capture.json — three reads taken read-only
//     on 2026-09-18 against producer 0f6cb388. The stale projection, the
//     never-projected room, the bigint-as-string sequences and the JSON turn
//     bodies are production's own answers, not this repository's inventions.
//   * TWO BRANCHES THE LIVE CORPUS CANNOT REACH are proven against synthetic
//     payloads, each marked as synthetic where it is built: an `effective_model`
//     that is an OBJECT (every live card carries a string) and a queue event
//     that fails the projector's shape (the producer drops those upstream, so
//     the browser can only ever meet one through a fixture).
//
// Every payload below is the record layer's own shape, keyed as
// mcp-server/src/partner-room.js keys it: `projected_at`, `live`, `latest_seq`,
// `source_seq`, `origin_channel`. A test written against friendlier names would
// pass here and fail against CARR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ACK_UNAVAILABLE_SENTENCE, ACKNOWLEDGEMENT_SENTENCE,
  ANSWER_EVIDENCE_MAX, ANSWER_TEXT_MAX, ANSWER_VERSION_CONFLICT_SENTENCE, ANSWER_VERSION_UNAVAILABLE_SENTENCE,
  ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE, COMPOSER_BODY_MAX, DISPATCH_SEARCH_SENTENCE, DISPATCH_STAGES_SENTENCE,
  NO_OPEN_SENTENCE, QUEUE_BOARD, QUEUE_ROOM, TOPIC_HISTORY_SENTENCE, TURN_ROOM, WINDOW_SENTENCE,
  WORK_ITEM_HISTORY_SENTENCE, WORK_STATES, WORK_STATE_LABEL,
  answerBaseVersion, answerDraftAfterAttempt, answerWorkRequestRequest, assignmentBoard,
  assignmentMoveOutcome, composerDraftAfterAttempt, composerRequest, contextPanel, dispatchSearchRequest,
  dispatchView, effectiveModelText, historyTopics, historyWorkItems,
  listState, needsJoeCardFields, participants, parentLine, queueFreshness, queueRequest, refuseQueueEvent,
  refuseDispatchHistory, refuseRoomQueue, refuseRoomTurns, refuseWorkRequestCard, topicHistory, turnRequest,
  turnWindow, workItemLedger, workRequestCardRequest,
} from "../js/model-room-model.js";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const capture = JSON.parse(await read("test/fixtures/model-room-live-capture.json"));
const LIVE_QUEUE = capture.read_room_queue_default;
const NEVER_QUEUE = capture.read_room_queue_model_room;
const LIVE_TURNS = capture.read_room_model_room;

const html = await read("control-room.html");
const css = await read("css/control-room.css");
const modelSource = await read("js/model-room-model.js");
const viewSource = await read("js/model-room.js");
/**
 * What the browser actually SHIPS, with comments removed. A test that grepped
 * the raw source would be satisfied by a comment promising the control does not
 * exist, which is the opposite of proof.
 */
const stripJs = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  // The view's markup carries HTML comments inside template literals; those are
  // prose too, and a promise written in one is not proof of anything.
  .replace(/<!--[\s\S]*?-->/g, " ");
const stripHtml = (source) => source.replace(/<!--[\s\S]*?-->/g, " ");
const viewCode = stripJs(viewSource);
const modelCode = stripJs(modelSource);
const htmlMarkup = stripHtml(html);
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

/** A session row in the producer's exact shape, for the branches live rows miss. */
const sessionRow = (over = {}) => ({
  canonical_session_id: "11111111-1111-4111-8111-111111111111",
  surface: "claude",
  display_name: "reverent-bardeen-40dd80",
  alias_source: "derived",
  parent_session_id: null,
  parent_known: false,
  native_host_id: null,
  native_host_supported: false,
  work_state: "working",
  work_state_evidence: "harvest row observed at 2026-09-18T12:00:00Z; the harvest stamps its own run time and is "
    + "not scheduled, so liveness is not claimed",
  last_observed_at: "2026-09-18T12:00:00+00:00",
  observation_source: "harvest",
  project_affinity: null,
  latest_cwd: null,
  latest_model_id: null,
  attempt_count: 1,
  latest_attempt_ref: null,
  ...over,
});

const identityPayload = (rows) => ({
  ok: true, permission_filtered: false, total_seen: rows.length, total_returned: rows.length, sessions: rows,
});

/* ------------------------------------------------------- clause 1: the states */

// MUTATION: collapse complete_unacknowledged and idle into one label where
// WORK_STATE_LABEL is used.
test("C12-01 the work states render as distinct cards, each with its own label", () => {
  const rows = WORK_STATES.map((state, index) => sessionRow({
    canonical_session_id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    work_state: state,
    work_state_evidence: state === "unknown" ? null : `observed as ${state}`,
  }));
  const payload = identityPayload(rows);
  const labels = rows.map((row) => contextPanel(row, payload).workStateLabel);
  assert.equal(new Set(labels).size, WORK_STATES.length, "each work state has its own label");
  assert.equal(WORK_STATE_LABEL.complete_unacknowledged, "complete, unacknowledged");
  assert.notEqual(WORK_STATE_LABEL.complete_unacknowledged, WORK_STATE_LABEL.idle);
  assert.notEqual(WORK_STATE_LABEL.working, WORK_STATE_LABEL.idle);
  assert.notEqual(WORK_STATE_LABEL.disconnected, WORK_STATE_LABEL.unknown);
});

// MUTATION: make the evidence line fall back to the display name when evidence
// is absent.
test("C12-02 work_state_evidence is printed in full and never derived from the name", () => {
  const row = sessionRow();
  const panel = contextPanel(row, identityPayload([row]));
  assert.equal(panel.evidenceText, row.work_state_evidence, "the evidence is verbatim, not paraphrased");
  assert.ok(panel.evidenceText.includes("liveness is not claimed"), "the producer's refusal to claim liveness stays");
  const bare = sessionRow({ work_state: "unknown", work_state_evidence: null, display_name: "a friendly name" });
  const barePanel = contextPanel(bare, identityPayload([bare]));
  assert.equal(barePanel.evidence, null);
  assert.equal(barePanel.evidenceText, "No observation is recorded behind this state.");
  assert.equal(/a friendly name/.test(barePanel.evidenceText), false,
    "absent evidence never falls back to the display name: that would be liveness inferred from a name");
});

// MUTATION: make both branches of listState return the same string.
test("C12-03 filtered-empty and empty-system print different sentences", () => {
  const filtered = listState({ ok: true, permission_filtered: true, total_seen: 4, total_returned: 0, sessions: [] });
  const empty = listState({ ok: true, permission_filtered: false, total_seen: 0, total_returned: 0, sessions: [] });
  assert.equal(filtered.state, "empty_filtered");
  assert.equal(empty.state, "empty_plain");
  assert.notEqual(filtered.message, empty.message, "the same empty array is two different truths");
  assert.match(filtered.message, /none is yours to see/);
  assert.equal(/none is yours to see/.test(empty.message), false);
});

/* ------------------------------------------------- the four freshness states */

// MUTATION: make the F2 stale branch return the F4 unavailable state.
test("C12-04 a stale projection renders F2 with its age and still lists the events", () => {
  assert.equal(LIVE_QUEUE.live, false, "today's real answer is a stale projection");
  assert.notEqual(LIVE_QUEUE.projected_at, null);
  const now = Date.parse("2026-09-18T22:00:00Z");
  const fresh = queueFreshness(LIVE_QUEUE, { now });
  assert.equal(fresh.state, "stale");
  assert.notEqual(fresh.state, "unavailable", "a stale projection is the ordinary state, never an error");
  assert.match(fresh.text, /stale by \d+ days?/, "the age is stated in plain text, not only in colour");
  assert.match(fresh.text, /the assignments below are the last projection/);
  const board = assignmentBoard(LIVE_QUEUE);
  assert.equal(board.cards.length, LIVE_QUEUE.events.length, "the events are still listed under a stale projection");
  assert.ok(board.cards.length > 0);
});

// MUTATION: default projected_at to now when it is null.
test("C12-05 a null projection renders F3 never, and never F2 stale", () => {
  assert.equal(NEVER_QUEUE.projected_at, null);
  assert.deepEqual(NEVER_QUEUE.events, []);
  const fresh = queueFreshness(NEVER_QUEUE, { now: Date.parse("2026-09-18T22:00:00Z") });
  assert.equal(fresh.state, "never");
  assert.equal(fresh.ageMs, null, "a projection that never happened has no age");
  assert.match(fresh.text, /Nothing has been projected into this queue/);
  assert.equal(/stale by/.test(fresh.text), false, "never-projected carries no age and is not staleness");
  const stale = queueFreshness(LIVE_QUEUE, { now: Date.parse("2026-09-18T22:00:00Z") });
  assert.notEqual(fresh.text, stale.text, "two states, two sentences, no helper collapses them");
  assert.equal(queueFreshness(null).state, "unavailable");
  assert.notEqual(queueFreshness(null).text, fresh.text, "F4 and F3 are different sentences");
});

// MUTATION: change QUEUE_ROOM to "model-room".
test("C12-06 the queue is read from partner-line, not from the tab's own name", () => {
  assert.equal(QUEUE_ROOM, "partner-line");
  assert.equal(TURN_ROOM, "model-room");
  assert.notEqual(QUEUE_ROOM, TURN_ROOM, "the tab is named after the conversation, not after the queue");
  assert.deepEqual(queueRequest(), { room: "partner-line" });
  assert.equal(turnRequest().room, "model-room");
  // The captured proof that the constant is not a preference: the tab's own
  // room answers an empty queue, and the constant's room answers four cards.
  assert.equal(LIVE_QUEUE.room, "partner-line");
  assert.ok(LIVE_QUEUE.events.length > 0);
  assert.equal(NEVER_QUEUE.room, "model-room");
  assert.deepEqual(NEVER_QUEUE.events, []);
  assert.equal(QUEUE_BOARD, "carr-build");
});

/* ------------------------------------------------ clause 2: names and parents */

// MUTATION: hard-code the alias source to "human".
test("C12-07 the friendly name carries its source, which is never human on a live row", () => {
  const row = sessionRow();
  const panel = contextPanel(row, identityPayload([row]));
  assert.equal(panel.aliasSource, "derived");
  assert.equal(panel.aliasText, "friendly name is derived");
  assert.equal(/human/.test(panel.aliasText), false,
    "no relation stores a human-typed alias, so a derived name may never read as one Joe chose");
  const claimed = sessionRow({ alias_source: "human" });
  assert.equal(contextPanel(claimed, identityPayload([claimed])).aliasText, "friendly name is human",
    "the source is carried from the payload, never asserted by this page");
});

// MUTATION: link the parent id unconditionally.
test("C12-08 a parent outside the answer is stated, not linked", () => {
  const child = sessionRow({
    canonical_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    parent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    parent_known: true,
  });
  const alone = parentLine(child, identityPayload([child]));
  assert.equal(alone.state, "outside");
  assert.equal(alone.linkable, false, "a parent not in this answer is never a dead link");
  assert.match(alone.text, /outside what you may see/);
  const parent = sessionRow({ canonical_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  const together = parentLine(child, identityPayload([child, parent]));
  assert.equal(together.state, "present");
  assert.equal(together.linkable, true, "a parent in the same answer is linkable");
  const orphan = parentLine(sessionRow(), identityPayload([sessionRow()]));
  assert.equal(orphan.state, "unrecorded");
  assert.equal(orphan.text, "Initiator not recorded.");
});

/* ------------------------------------- clause 3: the two things this refuses */

// MUTATION: add a disabled "Open session" button to the context panel.
test("C12-09 no open control exists in any branch, and the honesty sentence is present", () => {
  for (const supported of [true, false]) {
    for (const hostId of [null, "host-window-7"]) {
      const row = sessionRow({ native_host_supported: supported, native_host_id: supported ? hostId : null });
      const panel = contextPanel(row, identityPayload([row]));
      assert.equal(panel.open, false, "no payload turns the open flag true, because turning it true is S02 clause 3");
      assert.equal(panel.noOpenText, NO_OPEN_SENTENCE);
    }
  }
  assert.match(NO_OPEN_SENTENCE, /cannot open it/);
  assert.match(NO_OPEN_SENTENCE, /V5-UX-S02's third clause/);
  assert.match(NO_OPEN_SENTENCE, /Copy the canonical session ID instead/);
  // Not even a refused one: a disabled control implies one could be enabled.
  assert.equal(/open[\s_-]?session/i.test(viewCode.replace(NO_OPEN_SENTENCE, " ")), false,
    "the shipped code of js/model-room.js contains no open control, disabled or otherwise");
  // V5-UX-C13c added ONE real, legitimately-disabled control — the answer
  // form's own Submit, disabled until the scope checkbox is ticked and there
  // is answer text (a real write behind it, unlike Open session). Strip that
  // one named block out before re-asserting no OTHER disabled control has
  // crept in anywhere else in this file.
  const withoutAnswerForm = viewCode.replace(
    /function currentAnswerBaseVersion\(\)[\s\S]*?(?=function render\(\) \{)/,
    " ",
  );
  assert.notEqual(withoutAnswerForm, viewCode, "the answer-form block must be found and stripped before this check means anything");
  assert.equal(/disabled/.test(withoutAnswerForm), false,
    "no disabled control outside the answer form's own Submit stands in for one that cannot exist");
  assert.equal(/open[\s_-]?session/i.test(htmlMarkup), false, "control-room.html carries no open control either");
  assert.equal(/<button[^>]*>[^<]*[Oo]pen/.test(htmlMarkup), false, "no button on the page begins with Open");
});

// MUTATION: infer dispatch acknowledgement from a participant's room turn.
test("C12-10 room participants never stand in for dispatch acknowledgment", () => {
  assert.match(ACKNOWLEDGEMENT_SENTENCE, /Room participants come from conversation turns/);
  assert.match(ACKNOWLEDGEMENT_SENTENCE, /Dispatch receipt and acknowledgment come only/);
  assert.match(ACKNOWLEDGEMENT_SENTENCE, /never infers/);
  const people = participants(LIVE_TURNS);
  assert.ok(people.length > 0, "participants ARE derivable from turns and are shown");
  for (const person of people) {
    assert.equal(Object.hasOwn(person, "acknowledged"), false);
    assert.equal(Object.hasOwn(person, "pending"), false);
  }
  // The participant list never renders a pending count. Dispatch history owns
  // its own evidence-bound received/acknowledged labels elsewhere.
  assert.equal(/pending/i.test(htmlMarkup), false, "the participant markup carries no pending count");
  assert.equal(/pending/i.test(htmlMarkup), false, "control-room.html renders no pending-acknowledgment count either");
  // Structural, not a grep: no OUTPUT of the model carries an acknowledgment
  // field, in any branch — not a zero, not an unknown, not a dash.
  const row = sessionRow();
  const surfaces = [
    ...participants(LIVE_TURNS),
    ...assignmentBoard(LIVE_QUEUE).cards,
    ...turnWindow(LIVE_TURNS).turns,
    contextPanel(row, identityPayload([row])),
    queueFreshness(LIVE_QUEUE),
  ];
  for (const surface of surfaces) {
    for (const key of Object.keys(surface)) {
      assert.equal(/ack/i.test(key), false, `${key} is an acknowledgment field the substrate cannot fill`);
      assert.equal(/pending/i.test(key), false, `${key} is a pending count the substrate cannot fill`);
    }
  }
  assert.match(DISPATCH_STAGES_SENTENCE, /Sent, received, acknowledged and acted remain separate/);
  assert.match(DISPATCH_SEARCH_SENTENCE, /Search by a session's friendly name or canonical ID/);
});

test("C13-01 dispatch search is bounded, includes closed sessions and never names an actor", () => {
  assert.deepEqual(dispatchSearchRequest("  reverent-bardeen  "), {
    query: "reverent-bardeen", include_closed: true, limit: 50,
  });
  assert.equal(dispatchSearchRequest("   "), null);
  assert.equal(dispatchSearchRequest("x".repeat(250)).query.length, 200);
  assert.equal(Object.hasOwn(dispatchSearchRequest("session-id"), "actor"), false);
  assert.match(htmlMarkup, /id="modelRoomDispatchSearch" role="search"/);
  assert.match(htmlMarkup, /Find dispatch history by session name or canonical ID/);
});

test("C13-02 all four dispatch stages stay distinct and carry their own evidence", () => {
  const payload = {
    ok: true, session_id: "session-1", parent_session_id: "parent-1",
    permission_filtered: false, total_seen: 4, total_returned: 4,
    more: false, next_cursor: null,
    received: "2026-09-20T12:01:00Z", acknowledged: "2026-09-20T12:02:00Z",
    stage_unavailable_reason: null,
    events: ["sent", "received", "acknowledged", "acted"].map((stage, index) => ({
      event_id: `event-${index}`, at: `2026-09-20T12:0${index}:00Z`, stage,
      stage_evidence: `evidence-${stage}`, rationale: `why-${stage}`,
      session_id: "session-1", parent_session_id: "parent-1",
      attempt_ref: "attempt-7", work_request_ref: "WR-000119", superseded_by: null,
      link_source: ["sent", "received", "acknowledged"].includes(stage) ? "proved" : null,
      dispatch_ref: ["sent", "received", "acknowledged"].includes(stage) ? "dispatch-1" : null,
      stage_unavailable_reason: null,
    })),
  };
  assert.equal(refuseDispatchHistory(payload), null);
  const drawer = dispatchView(payload);
  assert.deepEqual(drawer.events.map((event) => event.stage), ["sent", "received", "acknowledged", "acted"]);
  assert.equal(new Set(drawer.events.map((event) => event.evidence)).size, 4);
  assert.equal(drawer.receivedState, "recorded");
  assert.equal(drawer.acknowledgedState, "recorded");
  assert.equal(refuseDispatchHistory({ ...payload, received: "bogus" }), "received_not_a_timestamp");
  assert.equal(refuseDispatchHistory({ ...payload, received: "2026-09-20T12:09:00Z" }),
    "received_without_matching_event");
  assert.equal(refuseDispatchHistory({ ...payload, acknowledged: "2026-09-20T12:09:00Z" }),
    "acknowledged_without_matching_event");
});

test("C13-03 history exposes parent, attempt, rationale and supersession without an execute path", () => {
  assert.match(viewCode, /event\.parentSessionId/);
  assert.match(viewCode, /event\.attemptRef/);
  assert.match(viewCode, /event\.rationale/);
  assert.match(viewCode, /event\.supersededBy/);
  assert.match(DISPATCH_SEARCH_SENTENCE, /never executed/);
  assert.equal(/execute|rerun|retry instruction/i.test(viewCode.replace(DISPATCH_SEARCH_SENTENCE, " ")), false);
});

/* ------------------------------------------------ the producer's own branches */

// MUTATION: drop the object branch of effectiveModelText.
test("C12-11 an effective_model object renders through its branch, not as [object Object]", () => {
  // SYNTHETIC: every live card carries a string, so only a fixture reaches this
  // branch — and the producer explicitly accepts `typeof` string OR object.
  assert.equal(effectiveModelText({ id: "claude-opus-5-high", host: "desktop" }), "claude-opus-5-high");
  assert.equal(effectiveModelText({ host: "desktop", tier: "high" }), "a model object: host, tier");
  assert.equal(effectiveModelText({}), "a model object with no fields");
  for (const value of [{ id: "x" }, { host: "desktop" }, {}]) {
    assert.equal(/\[object Object\]/.test(effectiveModelText(value)), false);
  }
  // The strings live cards do carry pass through untouched.
  for (const event of LIVE_QUEUE.events) {
    assert.equal(effectiveModelText(event.card.effective_model), event.card.effective_model);
  }
});

// MUTATION: drop an invalid event silently instead of counting it.
test("C12-12 an event failing the projector shape is dropped AND counted", () => {
  // SYNTHETIC: the producer drops malformed turns upstream, so the browser can
  // only meet one through a fixture — and a silently dropped card would be a
  // lie about the assignment list.
  const good = structuredClone(LIVE_QUEUE.events[0]);
  const wrongBoard = structuredClone(LIVE_QUEUE.events[1]);
  wrongBoard.board = "some-other-board";
  const wrongVersion = structuredClone(LIVE_QUEUE.events[0]);
  wrongVersion.v = 2;
  const board = assignmentBoard({ ...LIVE_QUEUE, events: [good, wrongBoard, wrongVersion] });
  assert.equal(board.cards.length, 1);
  assert.equal(board.droppedCount, 2);
  assert.deepEqual(board.droppedReasons, ["event_board_is_not_carr_build", "event_version_is_not_1"]);
  assert.match(board.droppedText, /2 projected events were not in the projector's shape/);
  assert.match(board.droppedText, /event_board_is_not_carr_build/);
  assert.equal(assignmentBoard(LIVE_QUEUE).droppedCount, 0, "no live event is dropped");
  assert.equal(assignmentBoard(LIVE_QUEUE).droppedText, null);
  assert.equal(refuseQueueEvent(good), null);
});

// MUTATION: parse a JSON body and render its fields.
test("C12-13 a turn body is carried as text, never parsed and never markup", () => {
  const jsonBody = LIVE_TURNS.turns.find((turn) => turn.body.trim().startsWith("{"));
  assert.ok(jsonBody, "the live window contains at least one JSON-shaped body");
  const window_ = turnWindow(LIVE_TURNS);
  const rendered = window_.turns.find((turn) => turn.seq === String(jsonBody.seq));
  assert.equal(typeof rendered.body, "string");
  assert.equal(rendered.body, jsonBody.body, "the body is the producer's bytes, unchanged");
  assert.equal(Object.hasOwn(rendered, "event"), false, "no field of the body became a field of the turn");
  assert.equal(Object.hasOwn(rendered, "task_id"), false);
  assert.equal(/JSON\.parse/.test(modelSource), false, "the model parses no turn body");
  assert.equal(/JSON\.parse/.test(viewSource), false, "the view parses no turn body either");
  // Markup in a body is escaped, not injected.
  const hostile = turnWindow({ ok: true, room: "model-room", more: false, latest_seq: "1",
    turns: [{ ...LIVE_TURNS.turns[0], seq: "1", body: "<script>alert(1)</script>" }] });
  assert.equal(hostile.turns[0].body, "<script>alert(1)</script>");
  assert.match(viewSource, /escapeHtml\(turn\.body\)/, "the view escapes every body it prints");
});

// MUTATION: print the window length as the total.
test("C12-14 more:true is stated and the window is never presented as a total", () => {
  assert.equal(LIVE_TURNS.more, true);
  const window_ = turnWindow(LIVE_TURNS);
  assert.equal(window_.more, true);
  assert.equal(window_.shown, LIVE_TURNS.turns.length);
  assert.equal(window_.windowText, WINDOW_SENTENCE);
  assert.match(WINDOW_SENTENCE, /not a count of what exists/);
  assert.equal(window_.latestSeq, String(LIVE_TURNS.latest_seq));
  const whole = turnWindow({ ...LIVE_TURNS, more: false });
  assert.equal(whole.windowText, null, "a complete answer says nothing about a window");
  const quiet = turnWindow({ ok: true, room: "model-room", turns: [], latest_seq: "0", more: false });
  assert.equal(quiet.shown, 0);
  assert.match(quiet.quietText, /A quiet room is an honest answer and not an outage/);
});

/* -------------------------------------------------------- structural honesty */

// MUTATION: add a local WORK_STATES array to js/model-room-model.js.
test("C12-15 the session vocabulary is imported from sessions-model.js, never copied", () => {
  assert.match(modelSource, /from "\.\/sessions-model\.js"/, "the vocabulary is imported");
  assert.equal(/export const WORK_STATES\s*=/.test(modelSource), false, "no second WORK_STATES is defined here");
  assert.equal(/export const SURFACES\s*=/.test(modelSource), false, "no second SURFACES is defined here");
  assert.equal(/export const WORK_STATE_LABEL\s*=/.test(modelSource), false, "no second label map is defined here");
  assert.equal(/export const PROVABLE_STAGES\s*=/.test(modelSource), false, "no second stage list is defined here");
  assert.equal(/"working", "idle"/.test(modelSource), false, "the state list is not restated as a literal");
  assert.deepEqual([...WORK_STATES], ["working", "idle", "complete_unacknowledged", "disconnected", "unknown"]);
});

// MUTATION: add a .sort() over events in js/model-room-model.js.
test("C12-16 the browser does not sort, filter or re-rank the server's arrays", () => {
  for (const [name, source] of [["model-room-model.js", modelSource], ["model-room.js", viewSource]]) {
    assert.equal(/\.sort\(/.test(source), false, `${name} sorts nothing the server already ordered`);
    assert.equal(/\.(?:events|turns|sessions)\.filter\(/.test(source), false, `${name} filters none of the arrays`);
    assert.equal(/\.reverse\(/.test(source), false, `${name} reverses nothing`);
    assert.equal(/toSorted|localeCompare/.test(source), false, `${name} re-ranks nothing`);
  }
  // The server's order, preserved event for event.
  const board = assignmentBoard(LIVE_QUEUE);
  assert.deepEqual(board.cards.map((card) => card.taskId), LIVE_QUEUE.events.map((event) => event.task_id));
  const window_ = turnWindow(LIVE_TURNS);
  assert.deepEqual(window_.turns.map((turn) => turn.seq), LIVE_TURNS.turns.map((turn) => String(turn.seq)));
});

// MUTATION: touch one line of js/room.js.
test("C12-17 the Observatory is untouched by this slice", async () => {
  // Pinned by content digest, not by `git show origin/main`: the hosted runner
  // checks out a single commit with no origin/main ref, so a trunk diff fails
  // there with "invalid object name" (that is why PR 40's check went red).
  const { createHash } = await import("node:crypto");
  const pinned = {
    "room.html": "354f74c7546dbd583504015674426a7afe964170b027268d2fe459d16b79c2f5",
    "js/room.js": "711e143b4872169e4039aa85b6763126fcce459d5824748f122b8b236c1d9880",
  };
  for (const [path, digest] of Object.entries(pinned)) {
    const actual = createHash("sha256").update(await read(path)).digest("hex");
    assert.equal(actual, digest, `${path} is byte-identical to the Observatory that shipped before this slice`);
  }
  // Not modified, not retired, not redirected: nothing in this slice links to it
  // as a replacement, and retiring it is Joe's decision, not this build's.
  assert.equal(/room\.html/.test(viewSource), false, "the Model Room tab does not redirect to the Observatory");
});

/* ----------------------------------------------- V5-UX-C13a: topic/work-item history */

test("C13a-01 the topic picker reuses the assignments board's own cards, never a second list", () => {
  const topics = historyTopics(LIVE_QUEUE);
  assert.deepEqual(topics.map((topic) => topic.id), LIVE_QUEUE.events.map((event) => event.task_id));
  const one = topicHistory(topics[0].id, LIVE_QUEUE);
  assert.equal(one.found, true);
  assert.equal(one.card.taskId, topics[0].id);
  assert.equal(one.sentence, TOPIC_HISTORY_SENTENCE);
  assert.match(TOPIC_HISTORY_SENTENCE, /no ticket-level event history/);
  const missing = topicHistory("t_does_not_exist", LIVE_QUEUE);
  assert.equal(missing.found, false);
  assert.equal(missing.card, null);
});

test("C13a-02 the work-item picker keeps current-work-requests' own order", () => {
  const payload = { ok: true, items: [
    { human_ref: "WR-000907", title: "Second", state: "needs_joe", source: {}, next_human_action: null },
    { human_ref: "WR-000906", title: "First", state: "needs_joe", source: {}, next_human_action: null },
  ] };
  assert.deepEqual(historyWorkItems(payload).map((item) => item.id), ["WR-000907", "WR-000906"]);
  assert.deepEqual(historyWorkItems(null), []);
  assert.deepEqual(historyWorkItems({ ok: true }), []);
});

test("C13a-03 the work-request-card request is bounded to the WR- ref shape", () => {
  assert.deepEqual(workRequestCardRequest("WR-000906"), { work_request: "WR-000906" });
  assert.equal(workRequestCardRequest("not-a-ref"), null);
  assert.equal(workRequestCardRequest(""), null);
  assert.equal(workRequestCardRequest(null), null);
});

test("C13a-04 the ledger keeps acting-identity and outcome-feedback as two separately server-ordered lists", () => {
  const card = {
    ok: true, human_ref: "WR-000906", title: "Demo", state: "needs_joe",
    acting_identity: [
      { act: "review-and-triage", hand: "human", authorization_class: null, acted_at: "2026-09-19T14:00:00Z" },
      { act: "accept-ready-plan", hand: "agent", authorization_class: "sponsored_agent", acted_at: "2026-09-20T09:15:00Z" },
    ],
    outcome_feedback_history: [
      { outcome: "won", accepted_at: "2026-09-18T00:00:00Z" },
    ],
  };
  const ledger = workItemLedger(card);
  assert.equal(ledger.humanRef, "WR-000906");
  assert.equal(ledger.actingEvents.length, 2);
  assert.equal(ledger.feedbackEvents.length, 1);
  // Two independently-ordered server arrays, never interleaved into one list.
  assert.equal(Object.hasOwn(ledger, "events"), false, "no merged list is produced");
  assert.equal(refuseWorkRequestCard(card), null);
  assert.equal(workItemLedger({ ok: false }), null);
  assert.match(WORK_ITEM_HISTORY_SENTENCE, /Nothing here is re-sorted, merged or inferred/);
});

test("C13a-05 the enriched Waiting-for-Joe fields never synthesize an absent one", () => {
  const full = {
    ok: true, human_ref: "WR-000906", desired_outcome: "Reconcile the demo vendor names.",
    incident_evidence: [{ kind: "incident", ref: "INC-1" }],
  };
  const fields = needsJoeCardFields(full);
  assert.equal(fields.originalRequest.present, true);
  assert.equal(fields.originalRequest.value, "Reconcile the demo vendor names.");
  assert.equal(fields.recommendedAnswer.present, false);
  assert.equal(fields.businessImpact.present, false);
  assert.equal(fields.evidence.present, true);
  assert.equal(fields.evidence.items.length, 1);

  const sparse = { ok: true, human_ref: "WR-000907" };
  const sparseFields = needsJoeCardFields(sparse);
  assert.equal(sparseFields.originalRequest.present, false);
  assert.equal(sparseFields.evidence.present, false);
  assert.match(sparseFields.evidence.reason, /carried no incident_evidence field/);
  assert.equal(needsJoeCardFields(null).available, false);
});

test("C13a-06 the history view opens no execute path", () => {
  assert.equal(/take\("historyCard"/.test(viewCode), true, "the work-item card is read, not executed");
  // V5-UX-C13c: both real writes on this tab (add-room-turn and
  // answer-work-request-for-joe) mint a fresh idempotency key per attempt via
  // uuidv4() — so idempotency_key now appears, twice, and this file still
  // opens no execute path for anything else.
  assert.equal((viewCode.match(/idempotency_key: uuidv4\(\)/g) ?? []).length, 2,
    "exactly the composer's and the answer form's own writes mint a fresh key");
  assert.match(htmlMarkup, /id="modelRoomHistoryTopic"/);
  assert.match(htmlMarkup, /id="modelRoomHistoryWorkItem"/);
  assert.equal(/open[\s_-]?session/i.test(viewCode.replace(NO_OPEN_SENTENCE, " ")), false);
});

/* ----------------------------------------------------- V5-UX-C13b: the composer */

test("C13b-01 the composer's request is add-room-turn's own shape: model-room, human, and nothing invented", () => {
  assert.deepEqual(composerRequest({ text: "Please review the demo lease abstract." }), {
    body: "Please review the demo lease abstract.", seat: "human", room: "model-room", kind: "turn",
  });
  assert.equal(composerRequest({ text: "  " }), null, "an empty draft refuses before anything is sent");
  assert.equal(composerRequest({ text: "" }), null);
  assert.equal(composerRequest({}), null);
  assert.equal(composerRequest({ text: "x".repeat(COMPOSER_BODY_MAX + 1) }), null,
    "over the verb's own ROOM_BODY_MAX (20000) is refused client-side too");
  assert.equal(composerRequest({ text: "x".repeat(COMPOSER_BODY_MAX) }).body.length, COMPOSER_BODY_MAX);
  // No target field: add-room-turn's inputSchema has none, and this file
  // invents no structure the record layer does not carry.
  assert.equal(Object.hasOwn(composerRequest({ text: "hi" }), "target"), false);
});

test("C13b-02 a failed or refused composer attempt keeps the draft exactly as typed", () => {
  const draft = { text: "Please review the demo lease abstract." };
  assert.deepEqual(composerDraftAfterAttempt(draft), draft);
  assert.deepEqual(composerDraftAfterAttempt(null), { text: "" });
  assert.deepEqual(composerDraftAfterAttempt({}), { text: "" });
});

test("C13b-03 every assignment move is refused by name, never silently and never as a fake success", () => {
  const card = { taskId: "t_demo_1" };
  const outcome = assignmentMoveOutcome(card);
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.taskId, "t_demo_1");
  assert.equal(outcome.text, ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE);
  assert.match(ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE, /no pinned verb changes/);
  assert.match(ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE, /never by dragging/);
  assert.equal(assignmentMoveOutcome(null).taskId, null, "a card-less drop still answers, never throws");
  assert.equal(assignmentMoveOutcome(undefined).allowed, false);
});

test("C13b-04 acknowledging a dispatch is not offered, and the sentence says why in first-hand terms", () => {
  assert.match(ACK_UNAVAILABLE_SENTENCE, /first-hand/i);
  assert.match(ACK_UNAVAILABLE_SENTENCE, /agent seat, not whoever is browsing/);
  // Removed for real: no request-builder, no stage vocabulary and no client
  // method for acknowledge-dispatch remain anywhere in this slice's files.
  assert.equal(/acknowledgeDispatchRequest|ackStageAvailable|ACK_STAGES/.test(modelSource), false);
  assert.equal(/acknowledgeDispatchRequest|ackStageAvailable|client\.acknowledgeDispatch/.test(viewCode), false);
});

test("C13b-05 the composer and the drop zone are wired in the view, honestly", () => {
  assert.match(htmlMarkup, /id="modelRoomComposerForm"/);
  assert.match(htmlMarkup, /id="modelRoomComposerText"/);
  assert.match(htmlMarkup, /id="modelRoomMoveTarget"/);
  assert.match(htmlMarkup, /id="modelRoomMoveResult"/);
  assert.match(htmlMarkup, /id="modelRoomAnswerUnavailable"/);
  assert.equal(/id="modelRoomComposerTarget"/.test(htmlMarkup), false, "add-room-turn has no target field to collect");
  // The submit path calls composerRequest() with the typed draft and, on a
  // built request, actually reaches the client — a fake success could not
  // slip in without touching this exact call.
  assert.match(viewCode, /composerRequest\(\{\s*text: view\.composer\.text\s*\}\)/);
  assert.match(viewCode, /composerDraftAfterAttempt\(/);
  assert.match(viewCode, /assignmentMoveOutcome\(/);
  // V5-UX-C13c: a fresh idempotency key is minted per attempt, so the call is
  // no longer the bare request object.
  assert.match(viewCode, /client\.addRoomTurn\(\{\s*\.\.\.request,\s*idempotency_key: uuidv4\(\)\s*\}\)/);
  // The two writes this file issues. No other client.<verb> write is added
  // for the Kanban move, because it has no admitted one, and none at all for
  // acknowledging a dispatch (removed; see C13b-04).
  assert.equal(/client\.(moveAssignment|updateQueueCard|acknowledgeDispatch)/.test(viewCode), false);
  assert.match(viewSource, /draggable="true"/);
  assert.match(viewSource, /dragstart|dataTransfer/);
});

test("C13b-06 the composer's failure path shows the record layer's refusal verbatim, never a paraphrase", () => {
  // The exact error the record layer returns — never a rewritten sentence —
  // is read straight off the thrown error, the same way every other write on
  // this app surfaces a server refusal.
  assert.match(viewCode, /error\?\.payload\?\.error \|\| error\?\.message/);
  assert.match(viewCode, /Not sent: \$\{/);
  assert.equal(/Sending a targeted Model Room request is not available/.test(viewCode), false,
    "the old, permanent unavailability message is gone: a send is genuinely attempted now");
});

test("C13b-07 the composer write is add-room-turn, pinned as a pure app-side contract addition", async () => {
  const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.ok(contract.mcp_operations.includes("acknowledge-dispatch"), "still pinned; simply not called from here");
  assert.ok(contract.mcp_operations.includes("add-room-turn"), "the composer's write must be pinned");
  const liveSource = await read("js/live-client.js");
  assert.match(liveSource, /addRoomTurn\(args\)\s*\{\s*return write\('add-room-turn', args\)/);
  assert.equal(/acknowledgeDispatch/.test(liveSource), false, "the removed write leaves no trace in the live client");
  const fixtureSource = await read("js/fixture-client.js");
  assert.match(fixtureSource, /async addRoomTurn\(/);
  assert.equal(/acknowledgeDispatch/.test(fixtureSource), false);
});

/* ------------------------------------------------- V5-UX-C13c: the answer form */

test("C13c-01 answerBaseVersion carries work-request-card's own version, never a default", () => {
  const ledgerCard = { ok: true, human_ref: "WR-000906", title: "x", state: "needs_joe", version: 3 };
  assert.equal(answerBaseVersion(ledgerCard), 3);
  assert.equal(answerBaseVersion({ ok: true, human_ref: "WR-000907", title: "x", state: "needs_joe" }), null,
    "a card with no integer version offers no base_version to guess with");
  assert.equal(answerBaseVersion({ ok: true, human_ref: "WR-000908", title: "x", state: "needs_joe", version: "3" }), null,
    "a non-integer version (e.g. a string) is not silently coerced");
  assert.equal(answerBaseVersion({ human_ref: "WR-000909", title: "x", state: "needs_joe", version: 3 }), null,
    "a payload work-request-card itself refused (no ok: true) carries no version either");
  assert.equal(answerBaseVersion(null), null);
});

test("C13c-02 answerWorkRequestRequest validates every field answer-work-request-for-joe declares", () => {
  const valid = { humanRef: "WR-000906", baseVersion: 3, answerText: "Confirmed.", scopeConfirmed: true };
  assert.deepEqual(answerWorkRequestRequest(valid), {
    human_ref: "WR-000906", base_version: 3, answer_text: "Confirmed.", scope_confirmed: true,
  });
  assert.deepEqual(answerWorkRequestRequest({ ...valid, evidenceRef: "https://example.invalid/e" }), {
    human_ref: "WR-000906", base_version: 3, answer_text: "Confirmed.", scope_confirmed: true,
    evidence_ref: "https://example.invalid/e",
  });
  assert.equal(answerWorkRequestRequest({ ...valid, humanRef: "not-a-ref" }), null);
  assert.equal(answerWorkRequestRequest({ ...valid, baseVersion: null }), null);
  assert.equal(answerWorkRequestRequest({ ...valid, baseVersion: 0 }), null, "version 0 is never valid: versions start at 1");
  assert.equal(answerWorkRequestRequest({ ...valid, baseVersion: 1.5 }), null, "a non-integer version is refused");
  assert.equal(answerWorkRequestRequest({ ...valid, answerText: "" }), null, "empty answer text is refused");
  assert.equal(answerWorkRequestRequest({ ...valid, answerText: "   " }), null, "whitespace-only answer text is refused");
  assert.equal(answerWorkRequestRequest({ ...valid, answerText: "x".repeat(ANSWER_TEXT_MAX + 1) }), null,
    "over the verb's own 500-character max is refused client-side too");
  assert.equal(answerWorkRequestRequest({ ...valid, answerText: "x".repeat(ANSWER_TEXT_MAX) }).answer_text.length, ANSWER_TEXT_MAX);
  assert.equal(answerWorkRequestRequest({ ...valid, scopeConfirmed: false }), null,
    "scope_confirmed must be the literal true, not merely truthy");
  assert.equal(answerWorkRequestRequest({ ...valid, scopeConfirmed: "true" }), null, "a string 'true' is not the literal true");
  assert.equal(answerWorkRequestRequest({ ...valid, evidenceRef: "x".repeat(ANSWER_EVIDENCE_MAX + 1) }), null,
    "an over-long evidence_ref is refused client-side too");
  assert.equal(Object.hasOwn(answerWorkRequestRequest(valid), "evidence_ref"), false,
    "an omitted evidence_ref is left off the request entirely, never sent as an empty string");
  assert.equal(answerWorkRequestRequest({}), null);
});

test("C13c-03 a failed or refused answer attempt keeps the draft exactly as typed", () => {
  const draft = { answerText: "Confirmed.", evidenceRef: "https://example.invalid/e", scopeConfirmed: true };
  assert.deepEqual(answerDraftAfterAttempt(draft), draft);
  assert.deepEqual(answerDraftAfterAttempt(null), { answerText: "", evidenceRef: "", scopeConfirmed: false });
  assert.deepEqual(answerDraftAfterAttempt({}), { answerText: "", evidenceRef: "", scopeConfirmed: false });
});

test("C13c-04 the honest unavailable and version-conflict sentences name the real cause", () => {
  assert.match(ANSWER_VERSION_UNAVAILABLE_SENTENCE, /work-request-card/);
  assert.match(ANSWER_VERSION_UNAVAILABLE_SENTENCE, /needs_joe/);
  assert.match(ANSWER_VERSION_UNAVAILABLE_SENTENCE, /compare-and-swap/);
  assert.equal(ANSWER_VERSION_CONFLICT_SENTENCE,
    "This request changed since you opened it; reload to see the current version.");
});

test("C13c-05 the answer form is wired in the view, honestly, gated on a real base_version", () => {
  assert.match(htmlMarkup, /id="modelRoomAnswerForm"/);
  assert.match(htmlMarkup, /id="modelRoomAnswerText"/);
  assert.match(htmlMarkup, /id="modelRoomAnswerEvidence"/);
  assert.match(htmlMarkup, /id="modelRoomAnswerScopeConfirmed"/);
  assert.match(htmlMarkup, /id="modelRoomAnswerSubmit"/);
  assert.match(htmlMarkup, /I've re-checked the scope and acceptance criteria shown above/);
  assert.match(htmlMarkup, /maxlength="500"[^>]*>|maxlength="500"/, "the textarea carries the same 500-char cap client-side");
  // The gate is answerBaseVersion(card), read from the currently loaded
  // history card — never a guessed or hardcoded version.
  assert.match(viewCode, /answerBaseVersion\(view\.historyCard\.payload\)/);
  assert.match(viewCode, /answerWorkRequestRequest\(\{/);
  assert.match(viewCode, /answerDraftAfterAttempt\(/);
  assert.match(viewCode, /client\.answerWorkRequestForJoe\(/);
  // Submit is a REAL disabled control, unlike the removed Open session
  // button: it is gated on the checkbox AND non-empty answer text.
  assert.match(viewCode, /view\.answer\.scopeConfirmed && view\.answer\.answerText\.trim\(\)\.length > 0/);
});

test("C13c-06 a version_conflict reads as the reload sentence; any other refusal is shown verbatim", () => {
  assert.match(viewCode, /code === "version_conflict" \? ANSWER_VERSION_CONFLICT_SENTENCE : `Not sent: \$\{code\}\.`/);
  assert.match(viewCode, /error\?\.payload\?\.error \|\| error\?\.message \|\| "the write did not answer"/);
});

test("C13c-07 a successful answer re-reads the card and the queue, never fabricating the new state", () => {
  // take() re-reads historyCard (the card) and workItems (the queue) after a
  // successful send — the same pattern the composer already uses for turns.
  const submitAnswerBody = viewSource.slice(viewSource.indexOf("async function submitAnswer"), viewSource.indexOf("async function searchSessions"));
  assert.match(submitAnswerBody, /take\("historyCard", \(\) => client\.workRequestCard\(args\), refuseWorkRequestCard\)/);
  assert.match(submitAnswerBody, /take\("workItems", \(\) => client\.currentWorkRequests\(\)/);
});

test("C13c-08 choosing a different work item clears the answer draft and send state", () => {
  const selectBody = viewSource.slice(viewSource.indexOf("async function selectHistoryWorkItem"), viewSource.indexOf("async function searchSessions"));
  assert.match(selectBody, /view\.answer = \{ answerText: "", evidenceRef: "", scopeConfirmed: false \}/);
  assert.match(selectBody, /view\.answerSend = \{ state: "idle", message: null \}/);
});

test("C13c-09 the answer write is pinned and implemented in both clients", async () => {
  const liveSource = await read("js/live-client.js");
  assert.match(liveSource, /answerWorkRequestForJoe\(args\)\s*\{\s*return write\('answer-work-request-for-joe', args\)/);
  const fixtureSource = await read("js/fixture-client.js");
  assert.match(fixtureSource, /async answerWorkRequestForJoe\(/);
  assert.match(fixtureSource, /version_conflict/);
});

/* ----------------------------------------------------------- the contract pin */

// MUTATION: remove read-room-queue from contracts/carr-interface.v1.json.
test("C13-04 the contract pins the v35 producer, its two dispatch writes, and V5-UX-C13b's composer write", () => {
  assert.equal(contract.version, "1.23.0", "one added operation (add-room-turn) is an additive, minor bump");
  assert.equal(contract.mcp_operations.length, 60);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].toSorted(), "mcp_operations stays sorted");
  for (const verb of ["read-room", "read-room-queue", "read-session-identity", "read-dispatch-history"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  for (const verb of ["record-dispatch-link", "acknowledge-dispatch"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  // V5-UX-C13b: add-room-turn is the composer's one write. It is pinned
  // purely as an app-side contract addition — carr-system's dispatch has no
  // separate allowlist gating which verb names a browser session may call
  // (verified against mcp-server/src/index.js and dealroom-web.js); a
  // human's own authenticated session is a valid caller
  // (mcp-server/src/identity.js personalScopeForActor, and partner-room.js's
  // add-room-turn handler derives origin_channel/origin_actor server-side).
  assert.ok(contract.mcp_operations.includes("add-room-turn"), "add-room-turn is not pinned");
  const queue = contract.mcp_operations.indexOf("read-room-queue");
  assert.equal(contract.mcp_operations[queue - 1], "read-room");
  assert.equal(contract.mcp_operations[queue + 1], "read-session-identity");
  // V5-UX-C13c: answer-work-request-for-joe (carr PR #1190) is the answer
  // form's one write, pinned the same way add-room-turn was — an app-side
  // contract addition, sorted immediately after add-room-turn.
  assert.ok(contract.mcp_operations.includes("answer-work-request-for-joe"), "answer-work-request-for-joe is not pinned");
  const answerAt = contract.mcp_operations.indexOf("answer-work-request-for-joe");
  assert.equal(contract.mcp_operations[answerAt - 1], "add-room-turn");
  assert.equal(contract.mcp_operations[answerAt + 1], "capture-queue");
  assert.equal(contract.producer.source_commit, "35009e9dedab3a603836c662d0f7f12dfeb1a284");
  // The on-demand Jev Deal Room read adds one HTTP surface. Keep the complete
  // set pinned here. It is a static pin, not a diff against
  // origin/main: once this branch IS origin/main a diff against it passes for
  // any value, and a "main has 53" count fails by construction after merge
  // (that is how PR 40 turned main red on 2026-09-19). `/api/room/*` was already
  // present for the Observatory, so its presence here is not this slice's doing.
  assert.deepEqual(contract.http_surfaces, [
    "/pipeline/changes", "/api/v1/business/*", "/api/v1/command-center", "/api/v1/atlas-graph",
    "/api/v1/work-inventory", "/api/v1/jev-deal-reading", "/api/room/*", "/api/system-work/*", "/api/share/*", "/api/tours/*",
  ], "http_surfaces does not move");
});

/* ------------------------------------------- the validators, on real payloads */

// MUTATION: replace a captured field with an invented one in the capture file.
test("C12-19 the validators run against the real captured payloads", () => {
  assert.match(capture.source, /0f6cb388424e83a75396a3e2d3bfc14839e81b35/, "the capture names the producer");
  assert.equal(refuseRoomQueue(LIVE_QUEUE), null, "the live queue answer is renderable");
  assert.equal(refuseRoomQueue(NEVER_QUEUE), null, "the never-projected answer is renderable");
  assert.equal(refuseRoomTurns(LIVE_TURNS), null, "the live room answer is renderable");
  for (const event of LIVE_QUEUE.events) assert.equal(refuseQueueEvent(event), null);
  // The bigint-as-string fact, pinned: production returns sequences as strings,
  // and a validator demanding an integer would refuse production outright.
  assert.equal(typeof LIVE_TURNS.latest_seq, "string");
  assert.equal(typeof LIVE_TURNS.turns[0].seq, "string");
  assert.equal(refuseRoomTurns({ ...LIVE_TURNS, latest_seq: 6475 }), null, "an integer sequence is accepted too");
  // Each refusal is BY NAME, and nothing is coerced into a default.
  assert.equal(refuseRoomQueue({ ...LIVE_QUEUE, live: undefined }), "queue_live_not_a_boolean");
  assert.equal(refuseRoomQueue({ ...LIVE_QUEUE, projected_at: "not a time" }), "queue_projected_at_not_a_stamp");
  assert.equal(refuseRoomQueue({ ...LIVE_QUEUE, events: undefined }), "queue_events_not_an_array");
  assert.equal(refuseRoomQueue({ ...NEVER_QUEUE, live: true }), "live_queue_without_a_projection");
  assert.equal(refuseRoomTurns({ ...LIVE_TURNS, more: "yes" }), "turns_more_not_a_boolean");
  assert.equal(refuseRoomTurns({ ...LIVE_TURNS, latest_seq: null }), "latest_seq_not_a_sequence");
  assert.equal(refuseRoomTurns({
    ...LIVE_TURNS, turns: [{ ...LIVE_TURNS.turns[0], body: { parsed: true } }],
  }), "turn_body_not_text");
  const cardless = structuredClone(LIVE_QUEUE.events[0]);
  cardless.card.source_seq = -1;
  assert.equal(refuseQueueEvent(cardless), "card_source_seq_not_a_sequence_or_null");
  // `source_seq: null` is a real answer the producer permits, and one live card
  // carries it, so it must not be refused.
  assert.ok(LIVE_QUEUE.events.some((event) => event.card.source_seq === null));
});

/* ----------------------------------------------------------- the page and tab */

// MUTATION: restore the not_in_release placeholder block.
test("C12-20 the Model Room placeholder is gone and the tab wiring is unchanged", () => {
  const panel = html.match(/<section class="tabpanel" id="panelModelRoom"[\s\S]*?\n    <\/section>/);
  assert.ok(panel, "the Model Room panel is still one tabpanel section");
  assert.equal(/not_in_release/.test(panel[0]), false, "the placeholder is gone");
  assert.equal(/Model Room: not in this release/.test(html), false);
  assert.equal(/The ticket board and its history ship in V5-UX-C12/.test(html), false);
  // The four panels, in the spec's order.
  for (const section of ["model_room_assignments", "model_room_sessions", "model_room_context",
    "model_room_participants"]) {
    assert.ok(panel[0].includes(`data-section="${section}"`), `${section} is missing`);
  }
  // The tab button, its aria wiring and the tab order are untouched.
  assert.match(html, /<button class="tab" type="button" role="tab" id="tabModelRoom" aria-controls="panelModelRoom" aria-selected="false">Model Room<\/button>/);
  assert.match(html, /id="panelModelRoom" role="tabpanel" aria-labelledby="tabModelRoom" tabindex="0" hidden/);
  // 360px: one column, and every control this tab adds at the 44px floor.
  assert.match(css, /#modelRoomRetry, #modelRoomQueueRetry, #modelRoomCopyId,\s*\n#modelRoomDispatchSearch \.btn, #modelRoomDispatchQuery \{ min-height: var\(--touch\); \}/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\n  \.assignment-rail \{ grid-template-columns: 1fr; \}/);
  // Every freshness state is carried by colour AND shape AND text.
  for (const state of ["stale", "never", "live", "unavailable"]) {
    assert.match(css, new RegExp(`\\.model-room-freshness\\[data-state="${state}"\\]`),
      `the ${state} freshness state has no rule of its own`);
  }
  assert.match(css, /\.model-room-freshness\[data-state="stale"\] \{ border-left-style: dashed;/,
    "stale is drawn by border STYLE as well as colour, so a still screenshot reads correctly");
  // No colour literal: the page layer uses system.css tokens only.
  const added = css.slice(css.indexOf("V5-UX-C12 Model Room tab"));
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(added), false, "no literal colour is introduced");
});

/* ---------------------------------------------------------------- motion pass */
// Joe's standing surface rule (9293d609), applied to C13b's composer/Kanban and
// C13c's answer form. Same grep-the-shipped-CSS pattern as
// test/queue-panel-model.test.mjs and test/atlas-incidents.test.mjs: system.css's
// universal `animation: none !important; transition: none !important;` floor is
// what actually disables all of this under prefers-reduced-motion (proven once,
// in test/visual-system.test.mjs), so these tests prove the new rules live where
// that floor reaches, and that nothing here is hidden as part of its animated
// state — only `hidden`/`disabled`, both plain JS-driven attributes untouched by
// any animation below, ever control visibility.

const systemCss = await read("css/system.css");

test("the Kanban card has a real lift on drag, and a refused drop shakes the ORIGINAL card back to its origin", () => {
  assert.match(css, /@keyframes kanban-lift/);
  assert.match(css, /@keyframes kanban-refused-shake/);
  assert.match(css, /\.assignment-card\[data-lifted="true"\] \{ animation: kanban-lift var\(--motion-move\)/);
  assert.match(css, /\.assignment-card\[data-refused="true"\] \{ animation: kanban-refused-shake var\(--motion-move\)/);
  assert.match(viewSource, /article\.dataset\.lifted = "true"/, "dragstart lifts the dragged card");
  assert.match(viewSource, /delete article\.dataset\.lifted/, "dragend releases it");
  // Native HTML5 drag-and-drop drags a browser-owned ghost, never the DOM
  // node itself, so the card never actually leaves the board: the shake is
  // real feedback on the SAME card the refusal names, not a fabricated move.
  assert.match(viewSource, /source\.dataset\.refused = "true"/);
  assert.doesNotMatch(stripJs(viewSource), /assignmentMoveOutcome\([^)]*\)\.approved|status\s*=\s*["'`]moved/i,
    "the drop stays honestly refused — this is a presentation pass, not a new write");
});

test("the composer animates from sending to sent or failed, and only on a real state change", () => {
  assert.match(css, /\.model-room-composer-result\[data-state="sending"\]/);
  assert.match(css, /\.model-room-composer-result\.motion-pulse \{ animation: receipt-in var\(--motion-enter\)/);
  assert.match(viewSource, /const changed = result\.dataset\.state !== view\.composerSend\.state;/);
  assert.match(viewSource, /if \(changed && !result\.hidden\) \{/);
  assert.match(viewSource, /void result\.offsetWidth; \/\/ force a reflow/);
});

test("a newly arrived room turn enters with motion", () => {
  assert.match(css, /\.room-turn \{[^}]*animation: receipt-in var\(--motion-enter\) var\(--ease\) both; \}/);
});

test("the answer form's submit enables with motion, the counter animates near the limit, and success animates the ledger's move", () => {
  assert.match(css, /#modelRoomAnswerCounter\[data-state="near-limit"\] \{ color: var\(--amber-text\); animation: breathe var\(--motion-urgent\)/);
  assert.match(viewSource, /counter\.dataset\.state = view\.answer\.answerText\.length >= ANSWER_TEXT_MAX \* 0\.9 \? "near-limit" : "normal";/);
  assert.match(css, /#modelRoomAnswerSubmit:not\(\[disabled\]\)\.motion-pulse \{ animation: receipt-in var\(--motion-enter\)/);
  assert.match(viewSource, /const wasReady = !submit\.hasAttribute\("disabled"\);/);
  assert.match(viewSource, /if \(ready && !wasReady\) \{/, "the pop plays only on disabled->enabled, never every keystroke");
  assert.match(css, /\.model-room-answer-result\.motion-pulse \{ animation: receipt-in var\(--motion-enter\)/);
  assert.match(css, /\.context-head p\.small\.mono \{ animation: receipt-in var\(--motion-enter\)/);
});

test("prefers-reduced-motion leaves every C13b/C13c motion addition fully visible with a static fallback", () => {
  assert.match(systemCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  for (const selector of [
    '.assignment-card[data-lifted="true"]',
    '.assignment-card[data-refused="true"]',
    '.assignment-move-target[data-hover="true"]',
    '.model-room-composer-result.motion-pulse',
    '.room-turn',
    '#modelRoomAnswerCounter[data-state="near-limit"]',
    '#modelRoomAnswerSubmit:not([disabled]).motion-pulse',
    '.model-room-answer-result.motion-pulse',
    '.model-room-move-result.motion-pulse',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`${escaped} \\{([^}]*)\\}`);
    const match = css.match(rule);
    assert.ok(match, `${selector} rule not found`);
    assert.doesNotMatch(match[1], /display:\s*none|visibility:\s*hidden/, `${selector} must not hide content as part of its animated state`);
  }
});
