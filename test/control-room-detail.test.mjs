import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFixtureClient } from "../js/fixture-client.js";
import { createQueue, addPage } from "../js/control-room-queue-model.js";
import { detailRequest, payloadRefusal, timelineEvents, groupEvents, visibleTimeline, nextHumanAction, properties, detailHtml, TIMELINE_LIMIT } from "../js/control-room-detail.js";

const root = new URL("../", import.meta.url);
const fixture = async () => createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL("data/board-seed.json", root))).toString("base64")}` });
const item = (kind, id, extra = {}) => ({ id: `${kind}:${id}`, kind, kindLabel: kind, ref: id, title: `Demo ${id}`, state: "open",
  statusGroup: "backlog", owner: "joe", holder: null, age: 4, version: "2", lastActivityAt: "2026-10-15T00:00:00Z", loopKind: null, ...extra });

test("each kind opens through its own read, and kinds without one say so", () => {
  assert.deepEqual(detailRequest(item("work_request", "WR-1")), { method: "workRequestCard", args: { work_request: "WR-1" }, verb: "work-request-card" });
  assert.deepEqual(detailRequest(item("incident", "INC-1")), { method: "getIncident", args: { ref: "INC-1", fact_limit: 50 }, verb: "get-incident" });
  assert.deepEqual(detailRequest(item("loop", "abc", { loopKind: "open_loop" })).args, { loop_id: "abc", kind: "open_loop" });
  assert.equal(detailRequest(item("defect", "d-1")), null);
  const html = detailHtml(item("defect", "DEF-1"), { state: "none" });
  assert.match(html, /no detail read for this kind yet, so there is no timeline/);
  assert.match(html, /data-detail-ref>DEF-1</);
});

test("work-request-card history is its recorded acts, oldest first; none means none", () => {
  const events = timelineEvents("work_request", { acting_identity: [
    { act: "accept-ready-plan", recorded_as: "joe", performed_by: "claude", hand: "agent", acted_at: "2026-10-11T10:00:00Z" },
    { act: "review-and-triage", recorded_as: "joe", performed_by: "joe", hand: "human", acted_at: "2026-10-09T10:00:00Z" },
  ], outcome_feedback_history: [] });
  assert.deepEqual(events.map((e) => e.label), ["Review and triage", "Accept ready plan"]);
  assert.equal(events[1].detail, "Recorded as joe, performed by claude");
  assert.deepEqual(timelineEvents("work_request", { acting_identity: [], outcome_feedback_history: [] }), []);
  assert.equal(timelineEvents("work_request", { ok: true, human_ref: "WR-1" }), null, "the sparse card keeps no history list");
  assert.match(detailHtml(item("work_request", "WR-1"), { state: "read", payload: { acting_identity: [] } }), /no recorded acts or outcome feedback yet/);
});

test("incident history merges trace and facts in time order; loops show amendments only", () => {
  const events = timelineEvents("incident", {
    trace: [{ kind: "check", state: "failed", detail: "34 checks passed", occurred_at: "2026-08-24T13:22:15Z" },
      { kind: "deployment", state: "verifying", ref: "bcd", occurred_at: "2026-08-24T13:18:22Z" }],
    facts: [{ text: "deployment ended failed", recorded_at: "2026-10-03T22:53:26Z" }],
  });
  assert.deepEqual(events.map((e) => e.label), ["Deployment verifying", "Check failed", "Fact recorded"]);
  assert.equal(timelineEvents("loop", { loop: {} }), null);
  assert.deepEqual(timelineEvents("loop", { loop: {}, amendments: [] }), []);
  assert.match(detailHtml(item("loop", "l-1"), { state: "read", payload: { loop: {}, amendments: [] } }), /never been amended/);
  assert.equal(timelineEvents("defect", {}), null);
});

test("consecutive same-kind events group; the timeline shows the last 30 with a control for older", () => {
  const event = (type, i) => ({ type, label: type, at: i, atText: null, detail: "" });
  const groups = groupEvents([event("a", 1), event("a", 2), event("b", 3), event("a", 4)]);
  assert.deepEqual(groups.map((g) => [g.type, g.events.length]), [["a", 2], ["b", 1], ["a", 1]]);
  const many = Array.from({ length: 45 }, (_, i) => event(i % 2 ? "x" : "y", i));
  assert.equal(visibleTimeline(many).hidden, 45 - TIMELINE_LIMIT);
  assert.equal(visibleTimeline(many, { showAll: true }).hidden, 0);
  const html = detailHtml(item("incident", "INC-1"), { state: "read", payload: { incident: {}, trace: many.map((e, i) => ({ kind: e.type, state: "seen", occurred_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })) } });
  assert.match(html, /data-show-older>Show 15 older events</);
});

test("the pane reads header, next human action, properties, then activity", () => {
  const payload = { incident: { next_action: "Read the export log", blocked_by: "no recovery evidence", severity: "SEV-1", environment: "production", occurrences: 6 }, trace: [], facts: [] };
  const html = detailHtml(item("incident", "INC-9", { state: "investigating" }), { state: "read", payload });
  const order = ["data-detail-ref", "Next human action", "cr-props", "Activity"].map((needle) => html.indexOf(needle));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.match(html, /Read the export log/);
  assert.match(html, /Blocked by no recovery evidence/);
  assert.deepEqual(nextHumanAction("work_request", { next_human_action: { label: "Prepare scope" } }), { label: "Prepare scope", note: null });
  assert.equal(nextHumanAction("work_request", {}), null);
  const rows = Object.fromEntries(properties(item("incident", "INC-9"), payload));
  assert.equal(rows.Severity, "SEV-1");
  assert.equal(rows["Open for"], "4 days");
});

test("loading reserves the timeline height; a refusal shows the reason with a retry", () => {
  assert.match(detailHtml(item("loop", "l-1"), { state: "loading" }), /cr-timeline-skeleton/);
  const error = detailHtml(item("loop", "l-1"), { state: "error", reason: "Not found" });
  assert.match(error, /The record could not be read/);
  assert.match(error, /data-detail-retry/);
  assert.equal(payloadRefusal("loop", { error: "not_found" }), "Not found");
  assert.equal(payloadRefusal("incident", { ok: true }), "The incident was not found");
  assert.equal(payloadRefusal("work_request", { ok: true, human_ref: "WR-1" }), null);
});

test("unavailable detail reads announce availability before any derived content", () => {
  for (const read of [{ state: "error", reason: "Not found" }, { state: "none" }]) {
    const html = detailHtml(item("defect", "DEF-1"), read);
    assert.ok(html.indexOf('data-detail-unavailable') < html.indexOf('class="cr-next"'));
    assert.ok(html.indexOf('data-detail-unavailable') >= 0);
    assert.match(html, /Next human action<\/h3><p[^>]*>Unavailable/);
    assert.doesNotMatch(html, /None recorded|properties below/);
    assert.doesNotMatch(html, /<dt>Kind<|<dt>State</);
  }
  assert.match(detailHtml(item("work_request", "WR-1"), { state: "read", payload: {} }), /None recorded in this read/);
});

test("detail shows full titles without an expand control and one copy of metadata", () => {
  const html = detailHtml(item("defect", "DEF-1", { title: "A long synthetic title ".repeat(20) }), { state: "none" });
  assert.match(html, /A long synthetic title /);
  assert.doesNotMatch(html, /cr-detail-heading|Show full title|Show less/);
  assert.doesNotMatch(html, /<dt>Kind<|<dt>State</);
});

test("every Queue row the fixture lists for a readable kind opens through the fixture client", async () => {
  const client = await fixture();
  const queue = addPage(createQueue(), await client.unfinishedWork({ limit: 100 }));
  const readable = queue.items.filter((entry) => detailRequest(entry));
  assert.ok(readable.some((entry) => entry.kind === "loop") && readable.some((entry) => entry.kind === "incident"));
  for (const entry of readable.filter((e) => !["captured", "detected"].includes(e.state))) {
    const request = detailRequest(entry);
    const payload = await client[request.method](request.args);
    assert.equal(payloadRefusal(entry.kind, payload), null, `${entry.ref} reads`);
  }
  const card = await client.workRequestCard({ work_request: "WR-000910" });
  const groups = groupEvents(timelineEvents("work_request", card));
  assert.equal(groups.at(-1).events.length, 3, "three consecutive slice-progress acts group into one line");
});
