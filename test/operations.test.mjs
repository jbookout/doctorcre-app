// V5-UX-C14 — the Operations section's approvals and schedule cards.
//
// The approvals card is built from `governance-queue`, in the producer's OWN
// field names (mcp-server/src/tools.js "governance-queue" over
// ops.read_governance_queue(), migration 0345): three lanes —
// `pending_rule_approvals`, `pending_guidance_import_batches`,
// `pending_retrieval_proposals` — plus `counts`. A test written against
// friendlier names would pass here and fail against CARR.
//
// The schedule card reads the versioned CARR schedule board.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {GOVERNANCE_LANES, formatScheduleDateTime, validGovernanceQueuePayload, validScheduleBoardPayload} from "../js/operations-model.js";
import {STUCK_SILENCE_HOURS} from "../js/control-room-model.js";
import {createFixtureClient} from "../js/fixture-client.js";
import {createLiveClient} from "../js/live-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("control-room.html");
const css = await read("css/control-room.css");
const systemCss = await read("css/system.css");
const pageJs = await read("js/control-room.js");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const QUEUE = {
  ok: true,
  pending_rule_approvals: [{
    rule_id: "0f1e2d3c-0000-4000-8000-000000000001",
    statement: "CONSTRAINT: a demo rule statement, verbatim.",
    human_quote: "demo partner words",
    scope: "global",
    taught_at: "2026-09-20T10:00:00.000Z",
    enforcement_class: "hook",
    binding_moment: "before a demo write",
    admission_reason: "demo admission",
    enforcement_status: "checked",
    fixture_refs: [],
    admitted_at: "2026-09-21T10:00:00.000Z",
  }],
  pending_guidance_import_batches: [{
    batch_id: "0f1e2d3c-0000-4000-8000-000000000002",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    reason: "Demo guidance import",
    staging_key: "demo-staging",
    staged_at: "2026-09-19T08:00:00.000Z",
    entry_count: 4,
  }],
  pending_retrieval_proposals: [
    {
      proposal_id: "0f1e2d3c-0000-4000-8000-000000000003",
      proposal_type: "phrase",
      payload: { phrase: "demo" },
      reason: "Demo retrieval phrase",
      proposer_actor_id: "joe",
      version: 1,
      proposed_at: "2026-09-22T12:00:00.000Z",
    },
    {
      proposal_id: "0f1e2d3c-0000-4000-8000-000000000004",
      proposal_type: "concept",
      payload: {},
      reason: null,
      proposer_actor_id: "dell",
      version: 2,
      proposed_at: "2026-09-23T12:00:00.000Z",
    },
  ],
  counts: {
    pending_rule_approvals: 1,
    pending_guidance_import_batches: 1,
    pending_retrieval_proposals: 2,
    total: 4,
  },
};

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

/* ------------------------------------------------------------ the payload */

test("governance-queue is validated in its own lane and count names", () => {
  assert.equal(validGovernanceQueuePayload(QUEUE), true);
  assert.deepEqual(GOVERNANCE_LANES.map((lane) => lane.id),
    ["pending_rule_approvals", "pending_guidance_import_batches", "pending_retrieval_proposals"]);
  assert.deepEqual(GOVERNANCE_LANES.map((lane) => lane.verb),
    ["approve-rule", "decide-guidance-import-batch", "approve-retrieval-proposals"]);
  const broken = [
    null,
    { ...QUEUE, ok: false },
    { ...QUEUE, pending_rule_approvals: undefined },
    { ...QUEUE, counts: undefined },
    { ...QUEUE, counts: { ...QUEUE.counts, total: 5 } },
    { ...QUEUE, counts: { ...QUEUE.counts, pending_retrieval_proposals: 1 } },
    { ...QUEUE, pending_rule_approvals: [{ ...QUEUE.pending_rule_approvals[0], rule_id: "" }] },
    { ...QUEUE, pending_guidance_import_batches: [{ ...QUEUE.pending_guidance_import_batches[0], staged_at: "not a time" }] },
  ];
  for (const payload of broken) assert.equal(validGovernanceQueuePayload(payload), false, JSON.stringify(payload)?.slice(0, 80));
});

/* ---------------------------------------------------------- the approvals */






/* ------------------------------------------------------------ the schedule */

test("schedule timestamps retain their calendar date across multi-day runs", () => {
  assert.equal(formatScheduleDateTime("2026-09-26T07:00:00.000Z", { timeZone: "UTC" }), "Sep 26, 2026, 7:00 AM");
  assert.equal(formatScheduleDateTime("2026-09-29T19:30:00.000Z", { timeZone: "UTC" }), "Sep 29, 2026, 7:30 PM");
  assert.equal(formatScheduleDateTime(null), null);
});



const SCHEDULE = {
  ok: true, schema: "schedule-board/v1", observed_at: "2026-09-28T16:00:00.000Z",
  overall_state: "attention",
  sources: [
    { owner: "launchd", state: "read", count: 1 },
    { owner: "claude-code", state: "read", count: 1 },
    { owner: "control-plane", state: "unknown", count: null },
    { owner: "cron", state: "unknown", count: null },
  ],
  jobs: [
    {
      key: "nightly-record-layer", name: "Nightly record layer", owner: "launchd",
      state: "missed", freshness: "stale", schedule: "Every 24 hours",
      last_run: { state: "succeeded", at: "2026-09-26T07:00:00.000Z", receipt_ref: "run:nightly-26" },
      next_due_at: "2026-09-27T07:00:00.000Z", next_due_basis: "cadence_deadline",
      actions: { pause: false, run: false, stop: false },
    },
    {
      key: "paused-task", name: "Paused task", owner: "claude-code",
      state: "paused", freshness: "fresh", schedule: "Every 24 hours",
      last_run: { state: "succeeded", at: "2026-09-27T07:00:00.000Z", receipt_ref: "run:paused" },
      next_due_at: null, next_due_basis: null,
      actions: { pause: false, run: false, stop: false },
    },
  ],
};



/* ---------------------------------------------------------------- motion */






/* ------------------------------------------------------------- the page */

test("governance feeds board cards and schedules feed the calendar", () => {
  assert.match(pageJs, /take\('approvals',\(\)=>client\.governanceQueue\(\)\)/);
  assert.match(pageJs, /board\?\.setGovernance\(payloadOf\(id\),view\.reads\[id\]\)/);
  assert.match(pageJs, /automationMonth\(payloadOf\('schedule'\)/);
  assert.doesNotMatch(html, /id="operationsBlocks"/);
});

test("the approvals read is its own chip and never joins the four dashboard tiles' coverage", async () => {
  // One read failing makes exactly its own area unknown (CR-AC-02). The
  // approvals read settles on its own `take`, so an outage here leaves the
  // incident, work, request and census reads exactly as verified as they were.
  const seed = await read("data/board-seed.json");
  const outage = await createFixtureClient({
    seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, outage: "approvals",
  });
  await assert.rejects(() => outage.governanceQueue(), /fixture outage/);
  assert.equal((await outage.currentWorkItem()).ok, true);
  assert.equal((await outage.currentWorkRequests()).ok, true);
});

/* ------------------------------------------------------------- the clients */

test("the fixture serves governance-queue in the producer's own shape with visibly fictional rows", async () => {
  const seed = await read("data/board-seed.json");
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}` });
  const queue = await client.governanceQueue();
  assert.equal(validGovernanceQueuePayload(queue), true);
  assert.ok(queue.counts.total > 0, "the fixture exercises the populated card");
  for (const lane of GOVERNANCE_LANES) assert.ok(queue[lane.id].length > 0, `${lane.id} is exercised`);
  const text = JSON.stringify(queue);
  for (const row of queue.pending_rule_approvals) assert.match(row.statement, /^Demo /);
  for (const row of queue.pending_guidance_import_batches) assert.match(row.reason, /^Demo /);
  assert.doesNotMatch(text, /9293d609|14181e60/, "no real rule id is copied into the fixture");
});

test("live governance-queue is the pinned verb over /mcp with no arguments", async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify(QUEUE) }] } }) };
  } });
  const payload = await client.governanceQueue();
  assert.deepEqual(payload, QUEUE);
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].body.params.name, "governance-queue");
  assert.deepEqual(calls[0].body.params.arguments, {}, "the verb refuses any field, so none is sent");
  assert.ok(contract.mcp_operations.includes("governance-queue"), "governance-queue is pinned");
});

test("live schedule-board is pinned to the versioned read with no caller-selected audience", async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify(SCHEDULE) }] } }) };
  } });
  assert.deepEqual(await client.scheduleBoard(), SCHEDULE);
  assert.equal(calls[0].body.params.name, "schedule-board");
  assert.deepEqual(calls[0].body.params.arguments, {});
  assert.ok(contract.mcp_operations.includes("schedule-board"));
});
