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
  NO_ACKNOWLEDGEMENT_SENTENCE, NO_DISPATCH_SEARCH_SENTENCE, NO_OPEN_SENTENCE,
  QUEUE_BOARD, QUEUE_ROOM, TURN_ROOM, UNPROVABLE_STAGES_SENTENCE, WINDOW_SENTENCE,
  WORK_STATES, WORK_STATE_LABEL, assignmentBoard, contextPanel, effectiveModelText,
  listState, participants, parentLine, queueFreshness, queueRequest, refuseQueueEvent,
  refuseRoomQueue, refuseRoomTurns, turnRequest, turnWindow,
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
  assert.equal(/disabled/.test(viewCode), false, "no disabled control stands in for the one that cannot exist");
  assert.equal(/open[\s_-]?session/i.test(htmlMarkup), false, "control-room.html carries no open control either");
  assert.equal(/<button[^>]*>[^<]*[Oo]pen/.test(htmlMarkup), false, "no button on the page begins with Open");
});

// MUTATION: render a "0 pending" acknowledgment chip.
test("C12-10 nothing claims acknowledged or unacknowledged, and the sentence says why", () => {
  assert.match(NO_ACKNOWLEDGEMENT_SENTENCE, /Acknowledgment is not recorded in this substrate/);
  assert.match(NO_ACKNOWLEDGEMENT_SENTENCE, /no_dispatch_spine/);
  assert.match(NO_ACKNOWLEDGEMENT_SENTENCE, /both would be invented/);
  const people = participants(LIVE_TURNS);
  assert.ok(people.length > 0, "participants ARE derivable from turns and are shown");
  for (const person of people) {
    assert.equal(Object.hasOwn(person, "acknowledged"), false);
    assert.equal(Object.hasOwn(person, "pending"), false);
  }
  // Not zero, not unknown, not a dash: no element renders a pending count.
  assert.equal(/pending/i.test(viewCode.replace(NO_ACKNOWLEDGEMENT_SENTENCE, " ")), false,
    "the shipped code of js/model-room.js renders no pending-acknowledgment count of any kind");
  assert.equal(/unacknowledged/i.test(viewCode.replace(NO_ACKNOWLEDGEMENT_SENTENCE, " ")), false,
    "and it never labels anything unacknowledged either");
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
  assert.match(UNPROVABLE_STAGES_SENTENCE, /Queued, waiting and verified are not shown/);
  assert.match(NO_DISPATCH_SEARCH_SENTENCE, /V5-UX-C13 and is not in this release/);
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

/* ----------------------------------------------------------- the contract pin */

// MUTATION: remove read-room-queue from contracts/carr-interface.v1.json.
test("C12-18 the contract pins all four verbs, sorted, at 1.17.0 with 55 operations", () => {
  assert.equal(contract.version, "1.17.0", "two added operations are an additive, minor bump");
  assert.equal(contract.mcp_operations.length, 55);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].toSorted(), "mcp_operations stays sorted");
  for (const verb of ["read-room", "read-room-queue", "read-session-identity", "read-dispatch-history"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  const queue = contract.mcp_operations.indexOf("read-room-queue");
  assert.equal(contract.mcp_operations[queue - 1], "read-room");
  assert.equal(contract.mcp_operations[queue + 1], "read-session-identity");
  // No new producer commit is involved: S02 already pinned this release.
  assert.equal(contract.producer.source_commit, "0f6cb388424e83a75396a3e2d3bfc14839e81b35");
  // Nothing new is read over HTTP, so http_surfaces is pinned to the exact set
  // that shipped before this slice. It is a static pin, not a diff against
  // origin/main: once this branch IS origin/main a diff against it passes for
  // any value, and a "main has 53" count fails by construction after merge
  // (that is how PR 40 turned main red on 2026-09-19). `/api/room/*` was already
  // present for the Observatory, so its presence here is not this slice's doing.
  assert.deepEqual(contract.http_surfaces, [
    "/pipeline/changes", "/api/v1/business/*", "/api/v1/command-center", "/api/v1/atlas-graph",
    "/api/v1/work-inventory", "/api/room/*", "/api/system-work/*", "/api/share/*", "/api/tours/*",
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
  assert.match(css, /#modelRoomRetry, #modelRoomQueueRetry, #modelRoomCopyId \{ min-height: var\(--touch\); \}/);
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
