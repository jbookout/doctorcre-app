// V5-UX-S02 clauses 1-2 — one named test per clause, one named mutation each.
//
// THE PROOF SPLIT, stated because it is a real limit on what these tests close:
//
//   * CLAUSE 1 is proven against the CAPTURED PRODUCTION PAYLOADS in
//     test/fixtures/session-identity.json — six reads taken read-only as Joe on
//     2026-09-18 against producer 0f6cb388. The counts, the filtered-empty and
//     genuinely-empty answers and the no-spine dispatch answer are production's
//     own, not this repository's inventions.
//   * CLAUSE 2 is proven against FOUR SYNTHETIC ROWS, because the live corpus
//     cannot reach retry, replacement, resume or a host title mismatch: every
//     one of the 603 sessions the record layer holds today lands on rule 4.
//     Each synthetic row carries the producer's exact field set, passes the same
//     validator the live captures pass, and is marked `synthetic: true` with a
//     one-line reason in the fixture file. The page never renders that marker.
//
// Every payload below is the record layer's own shape, keyed as
// mcp-server/src/session-identity.js keys it at 0f6cb388: `canonical_session_id`,
// `work_state_evidence`, `parent_known`, `native_host_supported`,
// `latest_attempt_ref`, `stage_unavailable_reason`. A test written against
// friendlier names would pass here and fail against CARR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ALIAS_SOURCES, DEFAULT_LIMIT, EMPTY_HISTORY_SENTENCE, LINEAGE_UNRECORDED_SENTENCE,
  NO_OPEN_SENTENCE, PROVABLE_STAGES, STAGE_UNAVAILABLE_SENTENCE, countsLine, dispatchView,
  hostState, identityRequest, lineage, lineageSummary, listState, refuseDispatchHistory,
  refuseSessionIdentity, sessionCard, sessionCards,
} from "../js/sessions-model.js";
import { CONTROL_ROOM_TABS } from "../js/control-room-model.js";
import { createFixtureClient } from "../js/fixture-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("control-room.html");
const css = await read("css/control-room.css");
const sessionsJs = await read("js/sessions.js");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
const capture = JSON.parse(await read("test/fixtures/session-identity.json"));

const captured = (verb, args) => capture.captures
  .find((entry) => entry.verb === verb && JSON.stringify(entry.args) === JSON.stringify(args)).payload;

const DEFAULT_PAGE = captured("read-session-identity", {});
const LIMIT_THREE = captured("read-session-identity", { limit: 3 });
const FILTERED_EMPTY = captured("read-session-identity", { query: "reverent", limit: 5 });
const PLAIN_EMPTY = captured("read-session-identity", { query: "zzzznope" });
const NO_SPINE = captured("read-dispatch-history", { session_id: "zzzznope" });
const SYNTHETIC = Object.fromEntries(capture.synthetic_sessions.map((entry) => [entry.row.canonical_session_id, entry.row]));
const RETRY_ROW = SYNTHETIC["11111111-1111-4111-8111-111111111111"];
const REPLACEMENT_ROW = SYNTHETIC["22222222-2222-4222-8222-222222222222"];
const RESUME_ROW = SYNTHETIC["33333333-3333-4333-8333-333333333333"];
const MISMATCH_ROW = SYNTHETIC["44444444-4444-4444-8444-444444444444"];
const WITH_EVENTS = capture.synthetic_dispatch.payload;

const fixture = async () => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}` });
};

/* ------------------------------------------------------------------- clause 1 */

// MUTATION: drop `query` from the request args in identityRequest().
test("S02-01 name lookup passes query through and renders the producer's order", async () => {
  assert.deepEqual(identityRequest({ query: "Synthetic retry" }), { query: "Synthetic retry", limit: DEFAULT_LIMIT });
  assert.equal(identityRequest({ query: "   " }).query, undefined, "an empty lookup sends no query at all");
  const client = await fixture();
  const answer = await client.sessionIdentity(identityRequest({ query: "Synthetic" }));
  assert.equal(answer.sessions.length, 4, "the lookup reached the producer rather than being dropped");
  assert.deepEqual(
    sessionCards(answer).map((card) => card.id),
    answer.sessions.map((row) => row.canonical_session_id),
    "the producer's order is preserved and nothing is re-ranked in the browser",
  );
});

// MUTATION: match on `display_name` only in the fixture client's sessionIdentity.
test("S02-02 ID lookup finds a row by canonical_session_id", async () => {
  const client = await fixture();
  const answer = await client.sessionIdentity(identityRequest({ query: "kanban:t_0834239a" }));
  assert.equal(answer.sessions.length, 1);
  assert.equal(answer.sessions[0].canonical_session_id, "kanban:t_0834239a");
  assert.equal(
    answer.sessions[0].display_name.toLowerCase().includes("kanban:t_0834239a"), false,
    "the id matched on the id, not by accident through the name",
  );
});

// MUTATION: render `session_id` in the parent slot of lineage().
test("S02-03 parent lineage renders the parent id when present", () => {
  const line = lineage(REPLACEMENT_ROW);
  assert.equal(line.relation, "replacement");
  assert.equal(line.parent, REPLACEMENT_ROW.parent_session_id);
  assert.match(line.text, new RegExp(REPLACEMENT_ROW.parent_session_id));
  assert.equal(
    line.text.includes(REPLACEMENT_ROW.canonical_session_id), false,
    "the card's own id is not the parent id",
  );
});

// MUTATION: change "not recorded" to "no parent" in LINEAGE_UNRECORDED_SENTENCE.
test('S02-04 a null parent with parent_known false reads "not recorded", never "no parent"', () => {
  const live = DEFAULT_PAGE.sessions[0];
  assert.equal(live.parent_session_id, null);
  assert.equal(live.parent_known, false);
  const line = lineage(live);
  assert.equal(line.relation, "not_recorded");
  assert.equal(line.text, LINEAGE_UNRECORDED_SENTENCE);
  assert.match(line.text, /not recorded/);
  assert.match(line.text, /unknown rather than absent/);
  assert.equal(/no parent/i.test(line.text), false, "absence is a claim the record layer never made");
});

// MUTATION: hardcode `attempt_count` to 1 in sessionCard().
test("S02-05 attempt lineage renders attempt_count and latest_attempt_ref", () => {
  const card = sessionCard(RETRY_ROW);
  assert.equal(card.attemptCount, 3);
  assert.equal(card.attemptRef, "WR-000117#3");
  assert.match(card.attemptsText, /3 attempts recorded/);
  assert.match(card.attemptsText, /WR-000117#3/);
  const live = sessionCard(DEFAULT_PAGE.sessions[0]);
  assert.equal(live.attemptCount, 1);
  assert.match(live.attemptsText, /1 attempt recorded, no attempt reference/);
});

// MUTATION: render `total_returned` as the shown count in countsLine().
test("S02-06 the counts line prints three numbers and never equates total_returned with the page", () => {
  const counts = countsLine(DEFAULT_PAGE);
  assert.deepEqual([counts.seen, counts.visible, counts.shown], [603, 124, 25]);
  assert.equal(counts.text, "603 sessions exist, 124 you may see, 25 shown on this page");
  // The invariant in one assertion: `limit` moves the page and moves NEITHER total.
  const three = countsLine(LIMIT_THREE);
  assert.deepEqual([three.seen, three.visible, three.shown], [603, 124, 3]);
  assert.notEqual(three.visible, three.shown, "total_returned is not the page size");
});

// MUTATION: render the unfiltered empty message when `sessions` is empty.
test("S02-07 permission_filtered true with an empty list renders the filtered banner", () => {
  assert.equal(FILTERED_EMPTY.permission_filtered, true);
  assert.equal(FILTERED_EMPTY.total_seen, 4);
  assert.equal(FILTERED_EMPTY.sessions.length, 0);
  const state = listState(FILTERED_EMPTY);
  assert.equal(state.state, "empty_filtered");
  assert.equal(state.message, "4 sessions match and none is yours to see.");
  assert.ok(state.banner, "the banner renders even though the list is empty");
  assert.match(state.banner.text, /Permission filtering is on/);
});

// MUTATION: always render the filtered banner in listState().
test("S02-08 permission_filtered false with total_seen 0 renders the plain empty message", () => {
  assert.equal(PLAIN_EMPTY.permission_filtered, false);
  assert.equal(PLAIN_EMPTY.total_seen, 0);
  const state = listState(PLAIN_EMPTY);
  assert.equal(state.state, "empty_plain");
  assert.equal(state.message, "No session matches that.");
  assert.equal(state.banner, null, "an empty system is not a filtered answer");
});

/* ------------------------------------------------------------------- clause 2 */

// MUTATION: collapse resume and retry to one label in lineage().
test("S02-09 retry, replacement, resume and not-recorded are four distinct labels", () => {
  const labels = [RETRY_ROW, REPLACEMENT_ROW, RESUME_ROW, DEFAULT_PAGE.sessions[0]].map((row) => lineage(row).relation);
  assert.deepEqual(labels, ["retry", "replacement", "resume", "not_recorded"]);
  assert.equal(new Set(labels).size, 4, "the four outcomes of the stated procedure stay four");
  assert.deepEqual([RETRY_ROW, REPLACEMENT_ROW, RESUME_ROW].map((row) => lineage(row).rule), [1, 2, 3]);
});

// MUTATION: let rule 3 fire for `parent_known: false`.
test("S02-10 the live corpus lands on not-recorded and the tab says so", () => {
  const relations = new Set(DEFAULT_PAGE.sessions.map((row) => lineage(row).relation));
  assert.deepEqual([...relations], ["not_recorded"], "all 25 captured rows land on rule 4");
  const summary = lineageSummary(DEFAULT_PAGE.sessions);
  assert.equal(summary.allUnrecorded, true);
  assert.equal(summary.count, 25);
  assert.match(summary.text, /No session on this page has recorded lineage/);
  assert.match(summary.text, /parent_known false/);
  assert.equal(lineageSummary([RETRY_ROW, ...DEFAULT_PAGE.sessions]).allUnrecorded, false);
});

// MUTATION: render a disabled open button in hostState() / js/sessions.js.
test('S02-11 native_host_supported false renders "cannot be opened here" and NO open control', () => {
  const state = hostState(DEFAULT_PAGE.sessions[0]);
  assert.equal(state.state, "unsupported");
  assert.equal(state.open, false);
  assert.match(state.text, /cannot be opened here/);
  assert.match(state.text, /no supported native host is recorded/);
  // Every branch, not just this one: nothing in the model can produce an open.
  for (const row of [RETRY_ROW, REPLACEMENT_ROW, RESUME_ROW, MISMATCH_ROW, ...DEFAULT_PAGE.sessions]) {
    assert.equal(hostState(row).open, false, `${row.canonical_session_id} produced an open control`);
  }
  // And the view renders none, disabled or otherwise. A disabled button would
  // imply one could be enabled, which is the claim clause 3 has not earned.
  assert.equal(/disabled/i.test(sessionsJs), false, "the Sessions view renders no disabled control");
  assert.equal(/data-open=|>Open |Resume<|Take over/i.test(sessionsJs), false, "the Sessions view renders no open control");
});

// MUTATION: show only `display_name` in the title-mismatch branch.
test("S02-12 a display_name differing from native_host_id renders host title mismatch with both strings", () => {
  const state = hostState(MISMATCH_ROW);
  assert.equal(state.state, "title_mismatch");
  assert.equal(state.open, false);
  assert.match(state.text, /Host title mismatch/);
  assert.match(state.text, new RegExp(MISMATCH_ROW.display_name));
  assert.match(state.text, new RegExp(MISMATCH_ROW.native_host_id));
});

// MUTATION: treat a null `native_host_id` as openable in hostState().
test("S02-13 supported host with a null host id renders the mismatch, not an openable card", () => {
  const state = hostState({ ...MISMATCH_ROW, native_host_id: null });
  assert.equal(state.state, "mismatch_no_host_id");
  assert.equal(state.open, false);
  assert.equal(state.hostId, null);
  assert.match(state.text, /supported but no host id/);
  assert.match(state.text, /does not\s+say which one/);
});

/* --------------------------------------------------------- honesty and stages */

// MUTATION: delete the sentence from control-room.html / sessions-model.js.
test("S02-14 the no-open honesty sentence is present on the tab", () => {
  assert.match(NO_OPEN_SENTENCE, /It cannot open one/);
  assert.match(NO_OPEN_SENTENCE, /V5-UX-S02's third clause/);
  assert.match(NO_OPEN_SENTENCE, /no control here launches, resumes or takes over anything/);
  assert.match(html, /id="sessionsNoOpen"/, "the tab carries the element the sentence is written into");
  assert.match(sessionsJs, /sentence\.textContent = NO_OPEN_SENTENCE/, "the page writes it from the model");
});

// MUTATION: render "acknowledged: no" instead of unavailable in dispatchView().
test("S02-15 pre-spine null stages stay unavailable and name their reason", () => {
  const drawer = dispatchView(NO_SPINE);
  assert.equal(drawer.stagesUnavailable, true);
  assert.equal(drawer.stageUnavailableReason, "no_dispatch_spine");
  assert.equal(drawer.receivedState, "unavailable");
  assert.equal(drawer.acknowledgedState, "unavailable");
  assert.equal(drawer.stageSentence, STAGE_UNAVAILABLE_SENTENCE);
  assert.match(drawer.stageSentence, /A missing stage is not a failed stage/);
  assert.match(drawer.stageSentence, /pre-spine history/);
  // The historic capture predates the spine, while the current contract can
  // also carry received and acknowledged evidence.
  const withEvents = dispatchView(WITH_EVENTS);
  assert.equal(withEvents.receivedState, "unavailable");
  assert.equal(withEvents.acknowledgedState, "unavailable");
  assert.deepEqual([...new Set(withEvents.events.map((event) => event.stage))].sort(), ["acted", "sent"]);
  assert.deepEqual([...PROVABLE_STAGES].sort(), ["acknowledged", "acted", "received", "sent"]);
});

// MUTATION: change "for this id" to "this session has none".
test('S02-16 an empty events list says "for this id", not "this session has none"', () => {
  const drawer = dispatchView(NO_SPINE);
  assert.equal(drawer.emptySentence, EMPTY_HISTORY_SENTENCE);
  assert.match(drawer.emptySentence, /No dispatch events are recorded for this id/);
  assert.match(drawer.emptySentence, /answers identically for an id that does not exist/);
  assert.equal(/this session has none\./.test(drawer.emptySentence), false);
  assert.equal(dispatchView(WITH_EVENTS).emptySentence, null);
});

/* -------------------------------------------------------------------- validator */

// MUTATION: make the `page_exceeds_total_returned` rule return true.
test("S02-17 the validator refuses sessions.length > total_returned by name", () => {
  assert.equal(refuseSessionIdentity(DEFAULT_PAGE), null, "production's own answer is refused");
  const broken = { ...DEFAULT_PAGE, total_returned: 3 };
  assert.equal(refuseSessionIdentity(broken), "page_exceeds_total_returned");
  assert.equal(refuseSessionIdentity({ ...DEFAULT_PAGE, total_seen: 1, total_returned: 124 }), "total_returned_exceeds_total_seen");
  assert.equal(refuseSessionIdentity({ ...DEFAULT_PAGE, sessions: null }), "sessions_not_an_array");
  assert.equal(refuseSessionIdentity({ ok: false }), "session_identity_unavailable");
  assert.equal(
    refuseSessionIdentity({ ok: true, permission_filtered: false, total_seen: 4, total_returned: 0, sessions: [] }),
    "unexplained_empty_list",
  );
});

// MUTATION: drop the `unprovable_stage_carries_a_value` rule.
test("S02-18 the validator refuses a non-null received beside no_dispatch_spine by name", () => {
  assert.equal(refuseDispatchHistory(NO_SPINE), null);
  assert.equal(refuseDispatchHistory(WITH_EVENTS), null);
  assert.equal(refuseDispatchHistory({ ...NO_SPINE, received: "2026-09-18T12:00:00Z" }), "unprovable_stage_carries_a_value");
  assert.equal(refuseDispatchHistory({ ...NO_SPINE, acknowledged: true }), "unprovable_stage_carries_a_value");
  assert.equal(refuseDispatchHistory({ ...NO_SPINE, more: true }), "more_without_a_cursor");
  assert.equal(
    refuseDispatchHistory({ ...WITH_EVENTS, events: [{ ...WITH_EVENTS.events[0], stage: "received" }] }),
    "acknowledgement_without_proved_dispatch",
  );
  assert.equal(refuseDispatchHistory({ ...WITH_EVENTS, events: [{ ...WITH_EVENTS.events[0],
    stage: "received", link_source: "proved", dispatch_ref: "dispatch-1", stage_unavailable_reason: null,
  }] }), null);
});

// MUTATION: allow empty evidence in the `work_state_without_evidence` rule.
test("S02-19 the validator refuses a work_state without work_state_evidence", () => {
  const rows = [{ ...RETRY_ROW, work_state_evidence: "" }];
  assert.equal(
    refuseSessionIdentity({ ok: true, permission_filtered: false, total_seen: 1, total_returned: 1, sessions: rows }),
    "work_state_without_evidence",
  );
  // `unknown` is the one state that needs no observation: it claims nothing.
  const unknown = [{ ...RETRY_ROW, work_state: "unknown", work_state_evidence: null }];
  assert.equal(
    refuseSessionIdentity({ ok: true, permission_filtered: false, total_seen: 1, total_returned: 1, sessions: unknown }),
    null,
  );
  assert.equal(
    refuseSessionIdentity({ ok: true, permission_filtered: false, total_seen: 1, total_returned: 1,
      sessions: [{ ...RETRY_ROW, alias_source: "typed" }] }),
    "unknown_alias_source",
  );
  assert.deepEqual([...ALIAS_SOURCES], ["human", "derived"]);
});

// MUTATION: edit one captured fixture field in test/fixtures/session-identity.json.
test("S02-20 every fixture payload passes the validator and matches the captured shape", async () => {
  for (const entry of capture.captures) {
    const refusal = entry.verb === "read-session-identity"
      ? refuseSessionIdentity(entry.payload)
      : refuseDispatchHistory(entry.payload);
    assert.equal(refusal, null, `the captured ${entry.verb} answer was refused: ${refusal}`);
  }
  for (const entry of capture.synthetic_sessions) {
    assert.equal(entry.synthetic, true, "a synthetic row must say so");
    assert.ok(entry.reason.length > 0, "a synthetic row must carry its reason");
    // The SAME validator the live captures pass, so a synthetic row cannot
    // carry a field set the producer would never emit.
    assert.equal(
      refuseSessionIdentity({ ok: true, permission_filtered: false, total_seen: 1, total_returned: 1, sessions: [entry.row] }),
      null,
    );
    assert.deepEqual(Object.keys(entry.row).sort(), Object.keys(DEFAULT_PAGE.sessions[0]).sort(),
      "a synthetic row carries the producer's exact field set");
  }
  assert.equal(refuseDispatchHistory(capture.synthetic_dispatch.payload), null);
  assert.equal(capture.synthetic_dispatch.payload.stage_unavailable_reason, "no_dispatch_spine");
  assert.equal(capture.synthetic_sessions.length, 4, "four synthetic rows and no more");
  // The fixture CLIENT serves the capture, byte for byte, so "verbatim" is
  // checked rather than asserted.
  const client = await fixture();
  assert.deepEqual(await client.sessionIdentity({}), DEFAULT_PAGE);
  // `work_state_evidence` embeds an age computed at READ time, so the two live
  // captures of the same rows differ in that clause and nowhere else. The page
  // is compared structurally rather than byte-for-byte: a byte comparison here
  // would be asserting a clock.
  const three = await client.sessionIdentity({ limit: 3 });
  assert.equal(three.total_seen, LIMIT_THREE.total_seen);
  assert.equal(three.total_returned, LIMIT_THREE.total_returned);
  assert.equal(three.permission_filtered, LIMIT_THREE.permission_filtered);
  assert.deepEqual(three.sessions.map((row) => row.canonical_session_id),
    LIMIT_THREE.sessions.map((row) => row.canonical_session_id));
  for (const [index, row] of three.sessions.entries()) {
    const { work_state_evidence: mine, ...rest } = row;
    const { work_state_evidence: theirs, ...captured } = LIMIT_THREE.sessions[index];
    assert.deepEqual(rest, captured);
    assert.equal(mine.split("; ")[1], theirs.split("; ")[1], "only the computed age differs");
  }
  assert.match(capture.note_on_volatility, /computed at READ time/);
  assert.deepEqual(await client.sessionIdentity({ query: "reverent", limit: 5 }), FILTERED_EMPTY);
  assert.deepEqual(await client.sessionIdentity({ query: "zzzznope" }), PLAIN_EMPTY);
  const emptyDispatch = await client.dispatchHistory({ session_id: "zzzznope" });
  assert.equal(refuseDispatchHistory(emptyDispatch), null);
  assert.deepEqual(emptyDispatch.events, []);
  assert.equal(emptyDispatch.stage_unavailable_reason, null,
    "the v35 producer no longer assigns a no-spine reason to an empty answer");
  // Every nullable field is null somewhere and non-null somewhere.
  const all = [...DEFAULT_PAGE.sessions, ...capture.synthetic_sessions.map((entry) => entry.row)];
  for (const field of ["parent_session_id", "native_host_id", "project_affinity", "latest_cwd", "latest_model_id", "latest_attempt_ref"]) {
    assert.ok(all.some((row) => row[field] === null), `${field} is never null in the corpus`);
    assert.ok(all.some((row) => row[field] !== null), `${field} is never non-null in the corpus`);
  }
  // The synthetic marker is data about the fixture, never part of a payload.
  assert.equal(/synthetic/i.test(sessionsJs), false, "the page can render the synthetic marker");
  assert.equal(capture.synthetic_sessions.every((entry) => entry.row.synthetic === undefined), true);
});

/* --------------------------------------------------------------- the contract */

// MUTATION: append the two verbs out of order in contracts/carr-interface.v1.json.
test("S02-21 the contract pins both verbs alphabetically at 1.19.0 with 57 operations", () => {
  assert.equal(contract.version, "1.19.0", "two added operations are an additive, minor bump");
  assert.equal(contract.mcp_operations.length, 57);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].toSorted(), "mcp_operations stays sorted");
  for (const verb of ["read-session-identity", "read-dispatch-history"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  const dispatch = contract.mcp_operations.indexOf("read-dispatch-history");
  assert.equal(contract.mcp_operations[dispatch - 1], "presence-lease");
  assert.equal(contract.mcp_operations[dispatch + 1], "read-doc-conversation");
  const identity = contract.mcp_operations.indexOf("read-session-identity");
  // V5-UX-C12 inserted read-room and read-room-queue between read-portfolio and
  // this verb. The neighbour moved; the sorted invariant above did not.
  assert.equal(contract.mcp_operations[identity - 1], "read-room-queue");
  assert.equal(contract.mcp_operations[identity + 1], "record-dispatch-link");
  // No route moves: /control-room was admitted at 04139737 and this is a tab.
  assert.equal(/session/i.test(JSON.stringify(contract.http_surfaces)), false, "no new HTTP surface");
});

// MUTATION: leave `3c8f619d` in place as producer.source_commit.
test("S02-22 producer.source_commit is the v35 dispatch-spine release", () => {
  assert.equal(contract.producer.source_commit, "0337947af37025e778e8a14efebee28e951f372e",
    "C13 repins the producer to the release that adds the dispatch spine");
  assert.match(contract.producer.source_commit, /^[0-9a-f]{40}$/);
  assert.match(capture.source, /0f6cb388424e83a75396a3e2d3bfc14839e81b35/, "the capture names the producer it came from");
});

/* -------------------------------------------------------------------- scope */

// MUTATION: absorb the Model Room panel into the Sessions panel.
// V5-UX-C12 replaced the Model Room placeholder this test once pinned. What S02
// owns here is unchanged: Sessions is its OWN fifth panel and never reuses the
// Model Room's, whatever the Model Room now holds.
test("S02-23 Sessions is its own panel beside the Model Room's", () => {
  assert.equal(/id="panelModelRoom"[\s\S]*?not in this release/.test(html), false,
    "V5-UX-C12 shipped the Model Room tab, so its placeholder is gone");
  assert.match(html, /<section class="tabpanel" id="panelModelRoom"/, "Model Room keeps its own panel");
  assert.match(html, /<section class="tabpanel" id="panelSessions"/, "Sessions is a fifth panel, not an absorption");
  assert.equal(
    /id="panelSessions"[\s\S]*?not in this release/.test(html), false,
    "the Sessions tab does not reuse the placeholder",
  );
  assert.deepEqual(CONTROL_ROOM_TABS.map((tab) => tab.id),
    ["tabDashboard", "tabAttention", "tabModelRoom", "tabAtlas", "tabSessions"]);
  assert.equal(CONTROL_ROOM_TABS.length, 5, "Sessions is the fifth tab beside the four that shipped");
  // 360px: one column, and every control this tab adds at the 44px floor.
  assert.match(css, /#sessionsLookup \{ min-height: var\(--touch\); \}/);
  assert.match(css, /@media \(max-width: 640px\) \{\s*\n  \.session-head/);
});
