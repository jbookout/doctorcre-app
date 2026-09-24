// V5-UX-B04 — the Vendors and Clients record panel's "Recent activity".
//
// B04's scope names the full record's source communications. The only pinned
// read that returns a record's timeline is `find-and-catch-up`, which finds by
// NAME and proceeds only on exactly one live match. A name is not an identity,
// so the timeline is shown ONLY when the match's own ref is this record's ref.
// Anything else — no match, several matches, a different record, a failed
// read — is a named state and no row from another party is ever shown.
// (`catch-me-up`, which takes the exact ref, is not pinned; that is the gap
// the PR reports.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ACTIVITY_LIMIT, activityCopy, activityRequest, activityState } from "../js/record-activity-model.js";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const vendor = { id: "7d1c5b52-0000-4000-8000-000000000001", ref: "V-CPA-006", name: "Demo Gulf Coast CPA" };
const completed = (target, timeline = []) => ({
  state: "completed", query: vendor.name,
  match: { kind: "vendor", name: vendor.name, target },
  catch_up: { subject: { type: "vendor", id: "x" }, timeline },
});
const row = (overrides = {}) => ({
  entry_kind: "activity", occurred_at: "2026-09-18T15:30:00.000Z", actor: "joe", verb: "log-activity",
  summary: "Called about the Q3 referral", detail: { secret: "never shown" }, owed: null, ...overrides,
});

test("the request is the record's own name, bounded; a record with no name or no ref sends nothing", () => {
  assert.deepEqual(activityRequest(vendor), { query: "Demo Gulf Coast CPA", limit: ACTIVITY_LIMIT });
  assert.equal(activityRequest({ ...vendor, name: "  " }), null);
  assert.equal(activityRequest({ ...vendor, ref: null }), null, "without a ref the answer could never be verified");
  assert.equal(activityRequest({ ...vendor, name: "x".repeat(201) }), null);
  assert.ok(ACTIVITY_LIMIT >= 1 && ACTIVITY_LIMIT <= 50);
});

test("the timeline shows only when the single match IS this record, by ref", () => {
  const state = activityState(vendor, completed("V-CPA-006", [row(), row({ entry_kind: "event", verb: "update-vendor", summary: null })]));
  assert.equal(state.state, "ready");
  assert.equal(state.rows.length, 2);
  assert.deepEqual(state.rows[0], { when: "2026-09-18T15:30:00.000Z", actor: "joe", what: "Called about the Q3 referral", kind: "activity", owed: null });
  assert.equal(state.rows[1].what, "Update vendor", "a row with no summary is named by its verb, in words");
  assert.ok(!JSON.stringify(state).includes("never shown"), "the raw detail object is never carried to the page");
  assert.equal(activityState(vendor, completed("v-cpa-006", [row()])).state, "ready", "refs compare without case");
});

test("a unique match that is a DIFFERENT record is refused, never shown under this name", () => {
  assert.deepEqual(activityState(vendor, completed("C-127", [row()])), { state: "mismatch" });
  assert.deepEqual(activityState(vendor, completed(null, [row()])), { state: "mismatch" });
});

test("no match, several matches and a malformed answer are each their own state", () => {
  assert.deepEqual(activityState(vendor, { state: "not_found", candidates: [] }), { state: "not_found" });
  assert.deepEqual(activityState(vendor, { state: "needs_disambiguation", candidate_count: 3, candidates: [] }), { state: "ambiguous", count: 3 });
  assert.deepEqual(activityState(vendor, { state: "needs_disambiguation", candidates: [{}, {}] }), { state: "ambiguous", count: 2 });
  assert.deepEqual(activityState(vendor, completed("V-CPA-006", "soon")), { state: "unavailable" });
  assert.deepEqual(activityState(vendor, null), { state: "unavailable" });
  assert.deepEqual(activityState({ ...vendor, ref: "" }, completed("V-CPA-006", [row()])), { state: "no_ref" });
});

test("a verified record with no timeline rows is empty, which is not the same as unreadable", () => {
  assert.deepEqual(activityState(vendor, completed("V-CPA-006", [])), { state: "empty", rows: [] });
  assert.notEqual(activityCopy({ state: "empty" }), activityCopy({ state: "unavailable" }));
});

test("every state has plain copy, and the unverifiable ones say why nothing is shown", () => {
  for (const state of ["loading", "empty", "not_found", "ambiguous", "mismatch", "no_ref", "unavailable"]) {
    assert.ok(activityCopy({ state, count: 2 }).length > 10, state);
  }
  assert.match(activityCopy({ state: "ambiguous", count: 2 }), /2 records/);
  assert.match(activityCopy({ state: "mismatch" }), /different record/i);
});

test("the Vendors and Clients panel reads activity through the pinned verb and never guesses", async () => {
  const carr = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.ok(carr.mcp_operations.includes("find-and-catch-up"));
  const js = await read("js/workspace-business.js");
  assert.match(js, /findAndCatchUp\(/);
  assert.match(js, /activityState\(/);
  assert.match(js, /activityRequest\(/);
  assert.match(js, /id="recordActivity"/);
  // This page loads css/workspace.css, not the shared system sheet, so the
  // shared token names are used with the system sheet's own values as the
  // fallback — the same durations every other surface runs on.
  const css = await read("css/workspace-business.css");
  const system = await read("css/system.css");
  const enter = system.match(/--motion-enter: ([^;]+);/)[1];
  assert.ok(css.includes(`.activity-row{`) && css.includes(`animation:receipt-in var(--motion-enter,${enter})`), "rows enter on the shared keyframe and duration");
  assert.match(css, /\.activity-row\{[^}]*backwards/);
  assert.match(css, /@keyframes receipt-in\{from\{opacity:0;transform:translateY\(6px\)\}to\{opacity:1;transform:none\}\}/, "the same keyframe the system sheet defines");
  assert.match(css, /\.activity-row:hover\{transform:translateX/, "the full-motion hover, not the reduced-motion reset");
  assert.match(css, /prefers-reduced-motion:reduce[^{]*\{[^@]*\.activity-row:hover\{transform:none/);
});
