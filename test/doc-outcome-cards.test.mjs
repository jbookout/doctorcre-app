// V5-UX-B09 — Doc outcome cards. This slice is scoped to:
//
//   * "Display persistent outcome/owner/phase/next-check/result cards with
//     qualified routing state."
//   * "Use shared session adapter for exact open; missing capability offers
//     concrete scoped solution." — the adapter itself (S02 clause 3) is
//     PARKED for a decision from Joe, so every test below asserts the
//     missing-capability branch, never an open control.
//   * "Proactive authorized follow-through distinguishes recommendation,
//     submission and outcome."
//
// checkable_done: "Queued/active/waiting/failed/unknown/verified shown
// truthfully.", "Local host loss uses qualified fallback or unavailable with
// same logical job.", "No auto-launch from opening/history or unsupported T3
// path." — each has its own test below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  NO_ADAPTER_SENTENCE, OUTCOME_CARDS_NO_OPEN_SENTENCE, ROUTING_STATES,
  outcomeCard, outcomeCards, outcomeCardsEmptyMessage, outcomeCardsPagingState,
  outcomeCardsRequest, refuseDocOutcomeCards, sessionEntryView,
} from "../js/doc-outcome-cards-model.js";
import { NO_OPEN_SENTENCE } from "../js/sessions-model.js";
import { createFixtureClient } from "../js/fixture-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("conversations.html");
const pageJs = await read("js/conversations.js");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async (options = {}) => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options });
};

const baseCard = (overrides = {}) => ({
  card_id: "card:doc-outcome:test", requested_outcome: "Do the thing", work_request_ref: "WR-000900",
  intent_kind: "recommendation", owner: "joe", controlled_phase: "claimed",
  source_freshness: { state: "fresh", observed_at: "2026-09-24T00:00:00+00:00", source_ref: "work-request:WR-000900" },
  routing_state: "queued", state_evidence: { observed_at: "2026-09-24T00:00:00+00:00", routing_source: "canonical_work_request" },
  job_id: { value: null, unavailable_reason: "no_authoritative_job_join" },
  attempt_id: { value: null, unavailable_reason: "no_authoritative_attempt_join" },
  canonical_session_id: { value: null, unavailable_reason: null },
  native_task_id: { value: null, unavailable_reason: "no_authoritative_native_task_join" },
  next_check: { available: false, value: null, unavailable_reason: "no_proved_next_check" },
  result: { available: false, value: null, unavailable_reason: "no_accepted_outcome" },
  session_entry: {
    available: false, target: null, capability: null,
    unavailable_reason: "session_relation_unavailable", fallback: null, auto_launch: false,
  },
  ...overrides,
});

const basePayload = (cards) => ({
  ok: true, schema_version: "doc-outcome-cards.v2", as_of: "2026-09-24T00:00:00+00:00",
  correlation_version: "sha256:test", more: false, next_cursor: null, cards,
});

/* --------------------------------------------------------------- refusal (server shape) */

test("refuseDocOutcomeCards accepts the producer's own doc-outcome-cards.v2 shape", () => {
  assert.equal(refuseDocOutcomeCards(basePayload([baseCard()])), null);
});

test("refuseDocOutcomeCards refuses a payload the server itself would refuse to answer", () => {
  assert.equal(refuseDocOutcomeCards(null), "doc_outcome_cards_unavailable");
  assert.equal(refuseDocOutcomeCards({ ok: false }), "doc_outcome_cards_unavailable");
  assert.equal(refuseDocOutcomeCards({ ok: true, schema_version: "doc-outcome-cards.v1", cards: [] }), "doc_outcome_cards_schema_mismatch");
  assert.equal(refuseDocOutcomeCards(basePayload("not-an-array")), "doc_outcome_cards_not_an_array");
});

test("refuseDocOutcomeCards refuses an unknown routing_state rather than rendering it", () => {
  const payload = basePayload([baseCard({ routing_state: "in_flight" })]);
  assert.equal(refuseDocOutcomeCards(payload), "doc_outcome_card_unknown_routing_state");
});

test("checkable_done: every routing state the producer can name is accepted, and only those six", () => {
  assert.deepEqual(ROUTING_STATES, ["queued", "active", "waiting", "failed", "unknown", "verified"]);
  for (const state of ROUTING_STATES) {
    const payload = basePayload([baseCard({ routing_state: state })]);
    assert.equal(refuseDocOutcomeCards(payload), null, `routing_state ${state} must be accepted`);
  }
});

test("checkable_done: no auto-launch — a card missing the field, or carrying auto_launch:true, is refused", () => {
  const missingField = baseCard();
  delete missingField.session_entry.auto_launch;
  assert.equal(refuseDocOutcomeCards(basePayload([missingField])), "doc_outcome_card_auto_launch_not_false");

  const launchTrue = baseCard({ session_entry: { ...baseCard().session_entry, auto_launch: true } });
  assert.equal(refuseDocOutcomeCards(basePayload([launchTrue])), "doc_outcome_card_auto_launch_not_false");

  const noEntry = baseCard({ session_entry: null });
  assert.equal(refuseDocOutcomeCards(basePayload([noEntry])), "doc_outcome_card_auto_launch_not_false");
});

test("refuseDocOutcomeCards refuses a card without native_task_id at all (T3 path must be named, never absent)", () => {
  const card = baseCard();
  delete card.native_task_id;
  assert.equal(refuseDocOutcomeCards(basePayload([card])), "doc_outcome_card_without_native_task_id");
});

test("refuseDocOutcomeCards refuses more:true without a cursor", () => {
  const payload = { ...basePayload([baseCard()]), more: true, next_cursor: null };
  assert.equal(refuseDocOutcomeCards(payload), "doc_outcome_cards_more_without_cursor");
});

test("refuseDocOutcomeCards refuses a proved field marked available with no value", () => {
  const nextCheck = baseCard({ next_check: { available: true, value: null, unavailable_reason: null } });
  assert.equal(refuseDocOutcomeCards(basePayload([nextCheck])), "doc_outcome_card_next_check_available_without_value");
  const result = baseCard({ result: { available: true, value: null, unavailable_reason: null } });
  assert.equal(refuseDocOutcomeCards(basePayload([result])), "doc_outcome_card_result_available_without_value");
});

/* --------------------------------------------------------------- the card view */

test("outcomeCard distinguishes recommendation, submission and outcome from the fields the server actually returned", () => {
  const recommendation = outcomeCard(baseCard({ intent_kind: "recommendation" }));
  assert.equal(recommendation.intentKind, "recommendation");
  assert.equal(recommendation.intentLabel, "Recommendation");

  const submission = outcomeCard(baseCard({ intent_kind: "submission" }));
  assert.equal(submission.intentKind, "submission");
  assert.equal(submission.intentLabel, "Submission");

  const noOutcomeYet = outcomeCard(baseCard({ result: { available: false, value: null, unavailable_reason: "no_accepted_outcome" } }));
  assert.equal(noOutcomeYet.result.available, false);
  assert.equal(noOutcomeYet.result.text, "No accepted outcome yet.");

  const withOutcome = outcomeCard(baseCard({ result: { available: true, value: "Closed out", unavailable_reason: null } }));
  assert.equal(withOutcome.result.available, true);
  assert.equal(withOutcome.result.value, "Closed out");
});

test("outcomeCard never fabricates owner, phase, next-check or result when the server left them absent", () => {
  const card = outcomeCard(baseCard({ owner: null, controlled_phase: null }));
  assert.equal(card.owner, null);
  assert.equal(card.phase, null);
  assert.equal(card.nextCheck.available, false);
  assert.equal(card.nextCheck.text, "No next check has been proved yet.");
});

test("outcomeCard shows routing state truthfully for every value the producer can send", () => {
  for (const state of ROUTING_STATES) {
    const card = outcomeCard(baseCard({ routing_state: state }));
    assert.equal(card.routingState, state);
    assert.equal(card.routingStateLabel, state);
  }
});

/* ----------------------------------------------------- missing capability (S02 clause 3) */

test("sessionEntryView never opens — the adapter is parked, not merely unconfigured", () => {
  for (const reason of ["session_relation_unavailable", "native_open_unsupported", "host_available_but_native_task_unbound", "host_unavailable", null]) {
    const card = baseCard({ session_entry: { available: false, target: null, capability: null, unavailable_reason: reason, fallback: null, auto_launch: false } });
    const entry = sessionEntryView(card);
    assert.equal(entry.open, false, `reason ${reason} must never open`);
  }
  const available = baseCard({ session_entry: { available: true, target: "some-target", capability: "some-cap", unavailable_reason: null, fallback: null, auto_launch: false } });
  assert.equal(sessionEntryView(available).open, false, "even an 'available' target does not open in this slice");
});

test("sessionEntryView offers the concrete scoped solution the spec asks for", () => {
  const card = baseCard();
  const entry = sessionEntryView(card);
  assert.equal(entry.scopedSolution, NO_ADAPTER_SENTENCE);
  assert.match(entry.scopedSolution, /session ref shown/);
  assert.match(entry.scopedSolution, /Claude Code/);
});

test("checkable_done: local host loss offers a qualified fallback naming the SAME logical job", () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const card = baseCard({
    canonical_session_id: { value: sessionId, unavailable_reason: null },
    session_entry: {
      available: false, target: null, capability: null, unavailable_reason: "host_unavailable",
      fallback: { kind: "copy_session_id", value: sessionId }, auto_launch: false,
    },
  });
  const entry = sessionEntryView(card);
  assert.equal(entry.open, false);
  assert.equal(entry.sessionRef, sessionId, "the fallback must name the same session, not a new one");
});

test("sessionEntryView with no fallback at all still refuses to open, and names no session ref", () => {
  const card = baseCard({ session_entry: { available: false, target: null, capability: null, unavailable_reason: "session_relation_unavailable", fallback: null, auto_launch: false } });
  const entry = sessionEntryView(card);
  assert.equal(entry.open, false);
  assert.equal(entry.sessionRef, null);
});

test("OUTCOME_CARDS_NO_OPEN_SENTENCE matches sessions-model's NO_OPEN_SENTENCE wording pattern for S02 clause 3", () => {
  // Same shape of sentence — "this surface cannot open a session, here is why,
  // here is the scoped alternative" — without literally duplicating it, since
  // it is a different surface (cards, not the Sessions tab).
  assert.match(NO_OPEN_SENTENCE, /cannot open one/);
  assert.match(NO_OPEN_SENTENCE, /no supported host adapter exists/);
  assert.match(OUTCOME_CARDS_NO_OPEN_SENTENCE, /cannot open a session/);
  assert.match(OUTCOME_CARDS_NO_OPEN_SENTENCE, /no verified host adapter/);
});

/* ----------------------------------------------------------------- list helpers */

test("outcomeCards preserves the producer's order and outcomeCardsEmptyMessage is honest about zero rows", () => {
  const payload = basePayload([baseCard({ card_id: "a" }), baseCard({ card_id: "b" })]);
  assert.deepEqual(outcomeCards(payload).map((card) => card.id), ["a", "b"]);
  assert.equal(outcomeCardsEmptyMessage(basePayload([])), "No outcome cards are recorded for you.");
  assert.equal(outcomeCardsEmptyMessage(payload), null);
});

test("outcomeCardsPagingState and outcomeCardsRequest round-trip a cursor without inventing one", () => {
  const payload = { ...basePayload([baseCard()]), more: true, next_cursor: "opaque-cursor" };
  const paging = outcomeCardsPagingState(payload);
  assert.equal(paging.more, true);
  assert.equal(paging.cursor, "opaque-cursor");
  assert.deepEqual(outcomeCardsRequest({ cursor: paging.cursor }), { cursor: "opaque-cursor" });
  assert.deepEqual(outcomeCardsRequest(), {});
});

/* ---------------------------------------------------------- fixture client (B09) */

test("the fixture client's docOutcomeCards answers a renderable doc-outcome-cards.v2 page", async () => {
  const client = await fixture();
  const payload = await client.docOutcomeCards({});
  assert.equal(refuseDocOutcomeCards(payload), null);
  assert.ok(payload.cards.length > 0);
});

test("the fixture client exercises the local-host-loss branch with a qualified same-job fallback", async () => {
  const client = await fixture();
  const payload = await client.docOutcomeCards({});
  const lostHost = payload.cards.find((card) => card.session_entry.unavailable_reason === "host_unavailable");
  assert.ok(lostHost, "the fixture must exercise the host_unavailable branch");
  assert.equal(lostHost.session_entry.fallback.kind, "copy_session_id");
  assert.equal(lostHost.session_entry.fallback.value, lostHost.canonical_session_id.value);
});

test("the fixture client refuses every card with auto_launch:true — none exists to begin with", async () => {
  const client = await fixture();
  const payload = await client.docOutcomeCards({});
  assert.ok(payload.cards.every((card) => card.session_entry.auto_launch === false));
});

test("the fixture client pages docOutcomeCards with an opaque cursor, same ordering as list-doc-conversations", async () => {
  const client = await fixture();
  const first = await client.docOutcomeCards({ limit: 2 });
  assert.equal(first.cards.length, 2);
  assert.equal(first.more, true);
  const second = await client.docOutcomeCards({ cursor: first.next_cursor, limit: 2 });
  assert.equal(refuseDocOutcomeCards(second), null);
  const ids = [...first.cards, ...second.cards].map((card) => card.card_id);
  assert.equal(new Set(ids).size, ids.length, "paging must not repeat a card");
});

test("the fixture client refuses an invalid cursor with the record-layer's own code", async () => {
  const client = await fixture();
  let code = null;
  try {
    await client.docOutcomeCards({ cursor: "not-base64-json" });
  } catch (error) {
    code = error?.payload?.error ?? null;
  }
  assert.equal(code, "doc_outcome_cursor_invalid");
});

test("the fixture client answers a 503 outage for read-doc-outcome-cards like every other read", async () => {
  const client = await fixture({ outage: "doc_outcome_cards" });
  await assert.rejects(() => client.docOutcomeCards({}), (error) => error.status === 503);
});

/* ------------------------------------------------------------------------- contract */

test("read-doc-outcome-cards is pinned in the CARR interface contract", () => {
  assert.ok(contract.mcp_operations.includes("read-doc-outcome-cards"));
});

/* ----------------------------------------------------------------------- the page */

test("conversations.html carries the outcome cards section and its permanent missing-capability sentence element", () => {
  assert.match(html, /id="outcomeCardsList"/);
  assert.match(html, /id="outcomeCardsNoOpen"/);
  assert.match(html, /id="outcomeCardsState"/);
});

test("conversations.js never wires an open/launch control for an outcome card session ref", () => {
  // The whole point of this slice's exclusion: no control here opens, resumes
  // or launches a native session. Search for the absence, the way
  // sessions.js's own header comment does for its tab.
  assert.doesNotMatch(pageJs, /data-launch-session/);
  assert.doesNotMatch(pageJs, /data-open-session/);
  assert.doesNotMatch(pageJs, /\.open\(\s*entry\.sessionRef/);
  assert.match(pageJs, /OUTCOME_CARDS_NO_OPEN_SENTENCE/);
});

test("conversations.js reads doc outcome cards independently of the open conversation's sequence guard", () => {
  assert.match(pageJs, /view\.outcomeCards\.sequence/);
  assert.match(pageJs, /takeOutcomeCards/);
});
