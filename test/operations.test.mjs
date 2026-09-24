// V5-UX-C14 — the Operations section's approvals and schedule cards.
//
// The approvals card is built from `governance-queue`, in the producer's OWN
// field names (mcp-server/src/tools.js "governance-queue" over
// ops.read_governance_queue(), migration 0345): three lanes —
// `pending_rule_approvals`, `pending_guidance_import_batches`,
// `pending_retrieval_proposals` — plus `counts`. A test written against
// friendlier names would pass here and fail against CARR.
//
// The schedule card has NO read behind it: no CARR verb reads scheduled jobs,
// launchd agents or routine state, so it states that and renders no number.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  APPROVALS_OUT_OF_SCOPE, ENTRANCE_STEP_MS, ENTRANCE_MAX_STEPS, GOVERNANCE_LANES,
  approvalsCard, countUpFrames, entranceDelay, prefersReducedMotion, scheduleCard,
  validGovernanceQueuePayload, waitingAge,
} from "../js/operations-model.js";
import { STUCK_SILENCE_HOURS } from "../js/control-room-model.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";

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

test("an answered queue becomes a verified count, three lanes and verbatim rows", () => {
  const card = approvalsCard({ state: "read", payload: QUEUE }, { now: NOW });
  assert.equal(card.state, "read");
  assert.equal(card.value, 4);
  assert.equal(card.word, "4");
  assert.equal(card.sentence, "4 governance decisions are waiting on a partner.");
  assert.deepEqual(card.lanes.map((lane) => [lane.id, lane.count]),
    [["pending_rule_approvals", 1], ["pending_guidance_import_batches", 1], ["pending_retrieval_proposals", 2]]);
  const [rule] = card.lanes[0].items;
  assert.equal(rule.key, QUEUE.pending_rule_approvals[0].rule_id);
  assert.equal(rule.title, "CONSTRAINT: a demo rule statement, verbatim.", "the statement is shown verbatim");
  assert.equal(rule.since, "2026-09-21T10:00:00.000Z", "a rule waits from its admission, not its teaching");
  assert.ok(rule.detail.some((row) => row.label === "partner words" && row.value === "demo partner words"));
  const [batch] = card.lanes[1].items;
  assert.equal(batch.title, "Demo guidance import");
  assert.ok(batch.detail.some((row) => row.label === "entries" && row.value === "4"));
  const unnamed = card.lanes[2].items[1];
  assert.equal(unnamed.title, "concept proposal (no reason recorded)", "a missing reason is said, not invented");
});

test("the oldest waiting decision drives the ambient clock, and its tempo follows the real age", () => {
  const card = approvalsCard({ state: "read", payload: QUEUE }, { now: NOW });
  assert.deepEqual(card.oldest, {
    at: "2026-09-19T08:00:00.000Z", lane: "pending_guidance_import_batches",
    key: QUEUE.pending_guidance_import_batches[0].batch_id,
  });
  assert.equal(waitingAge(card.oldest.at, NOW).text, "waiting 5d 4h 0m 00s");
  assert.equal(waitingAge(card.oldest.at, NOW).tempo, "urgent");
  assert.equal(waitingAge("2026-09-24T11:59:51.000Z", NOW).text, "waiting 0d 0h 0m 09s");
  assert.equal(waitingAge("2026-09-24T02:00:00.000Z", NOW).tempo, "calm");
  assert.equal(waitingAge(new Date(NOW - 30 * 3600 * 1000).toISOString(), NOW).tempo, "attention");
  assert.equal(waitingAge(new Date(NOW - STUCK_SILENCE_HOURS * 3600 * 1000).toISOString(), NOW).tempo, "urgent",
    "the urgent tempo starts at the approved silence cadence, not a number made up here");
  assert.equal(waitingAge("2026-09-19T08:00:00.000Z", NOW, { seconds: false }).text, "waiting 5d 4h 0m",
    "the reduced-motion clock drops the ticking seconds");
  assert.deepEqual(waitingAge("garbage", NOW), { known: false, ms: null, text: "unknown", tempo: null });
  assert.equal(waitingAge("2026-09-25T00:00:00.000Z", NOW).text, "waiting 0d 0h 0m 00s", "clock skew never goes negative");
});

test("an empty queue is a real zero with no ambient clock", () => {
  const empty = {
    ok: true, pending_rule_approvals: [], pending_guidance_import_batches: [], pending_retrieval_proposals: [],
    counts: { pending_rule_approvals: 0, pending_guidance_import_batches: 0, pending_retrieval_proposals: 0, total: 0 },
  };
  const card = approvalsCard({ state: "read", payload: empty }, { now: NOW });
  assert.equal(card.state, "read");
  assert.equal(card.value, 0);
  assert.equal(card.word, "0");
  assert.equal(card.sentence, "Nothing is waiting on a partner's governance decision.");
  assert.equal(card.oldest, null);
});

test("an unanswered or malformed queue is unknown, never zero", () => {
  for (const input of [
    { state: "unknown", reason: "the governance queue refused or could not be reached" },
    { state: "read", payload: { ...QUEUE, counts: { ...QUEUE.counts, total: 9 } } },
    undefined,
  ]) {
    const card = approvalsCard(input, { now: NOW });
    assert.equal(card.state, "unknown");
    assert.equal(card.value, null);
    assert.equal(card.word, "unknown");
    assert.deepEqual(card.lanes, []);
    assert.equal(card.oldest, null);
    assert.match(card.sentence, /^This is unknown: /);
  }
});

test("the approvals card says what it is NOT: production-effect approvals still have no pending read", () => {
  for (const verb of ["accept-ready-plan", "accept-workflow", "issue-execution-envelope"]) {
    assert.ok(APPROVALS_OUT_OF_SCOPE.includes(verb), `${verb} is not named`);
  }
  assert.match(APPROVALS_OUT_OF_SCOPE, /no read lists what is pending/);
  const card = approvalsCard({ state: "read", payload: QUEUE }, { now: NOW });
  assert.equal(card.scope, APPROVALS_OUT_OF_SCOPE);
  assert.match(card.authority, /grants no authority/);
  assert.match(card.rule, /^Reconcile before retry is already how every command on this app behaves/);
});

/* ------------------------------------------------------------ the schedule */

test("the schedule card is an honest no-read state and renders no number", () => {
  const card = scheduleCard();
  assert.equal(card.id, "automation");
  assert.equal(card.title, "Scheduled automation");
  assert.equal(card.state, "no_read");
  assert.equal(card.word, "no schedule read yet");
  assert.match(card.body, /^No schedule read yet\./);
  assert.match(card.body, /No CARR verb reads scheduled jobs, launchd agents or routine state/);
  assert.match(card.body, /disable-legacy-schedule is a partner-only write, not a read/);
  assert.doesNotMatch(`${card.title} ${card.word} ${card.body}`, /\d/, "a schedule card with no read carries no number");
  assert.equal(card.countdown, null, "no countdown is drawn without a next run to count down to");
});

/* ---------------------------------------------------------------- motion */

test("the entrance is staggered and always finishes inside a second", () => {
  assert.equal(entranceDelay(0), 0);
  assert.equal(entranceDelay(1), ENTRANCE_STEP_MS);
  assert.equal(entranceDelay(500), ENTRANCE_STEP_MS * ENTRANCE_MAX_STEPS, "a long list never delays its tail");
  const enterMs = Number(/--motion-enter: (\d+)ms;/.exec(systemCss)?.[1]);
  assert.ok(enterMs > 0, "the shared entrance token is read, not assumed");
  assert.ok(entranceDelay(500) + enterMs < 1000, "no entrance sequence runs beyond a second");
});

test("a count climbs to the value that landed, and lands exactly on it", () => {
  const frames = countUpFrames(0, 4, { reduced: false });
  assert.ok(frames.length > 1);
  assert.equal(frames.at(-1), 4);
  assert.ok(frames.every((value, index) => index === 0 || value >= frames[index - 1]), "monotonic");
  assert.ok(frames.every(Number.isInteger));
  assert.deepEqual(countUpFrames(4, 4, { reduced: false }), [4], "an unchanged value does not animate");
  const down = countUpFrames(9, 2, { reduced: false });
  assert.equal(down.at(-1), 2);
});

test("reduced motion: the count lands in one frame and the preference is honoured from both sources", () => {
  assert.deepEqual(countUpFrames(0, 12, { reduced: true }), [12]);
  const media = (matches) => ({ matchMedia: (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" && matches }) });
  assert.equal(prefersReducedMotion(media(true)), true, "the operating-system setting is honoured");
  assert.equal(prefersReducedMotion(media(false)), false);
  assert.equal(prefersReducedMotion({ ...media(false), document: { documentElement: { dataset: { motion: "reduced" } } } }), true,
    "the in-app motion preference is honoured too");
  assert.equal(prefersReducedMotion({}), false, "no matchMedia (node, old browsers) is full motion, not a crash");
});

test("reduced motion: every C14 motion rule sits under the static floor and none hides content", () => {
  assert.match(systemCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  for (const selector of [
    ".ops-card",
    ".ops-lane",
    ".ops-item",
    ".ops-value.motion-pulse",
    '.ops-orb[data-tempo="calm"]',
    '.ops-orb[data-tempo="attention"]',
    '.ops-orb[data-tempo="urgent"]',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped} \\{([^}]*)\\}`));
    assert.ok(match, `${selector} rule not found`);
    assert.doesNotMatch(match[1], /display:\s*none|visibility:\s*hidden/, `${selector} hides content as part of its motion`);
  }
  // The hover lift is a transform, which the universal floor does not undo; the
  // page's own reduced-motion block pins it flat so nothing jumps.
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf("V5-UX-C14")))?.[1] || "";
  assert.match(reduced, /\.ops-lane:hover, \.ops-lane:active, \.ops-item summary:hover, \.ops-item summary:active \{ transform: none; \}/);
  assert.match(reduced, /\.ops-card, \.ops-lane, \.ops-item \{ opacity: 1; transform: none; \}/);
  assert.match(css, /:root\[data-motion="reduced"\] \.ops-lane:hover/, "the in-app preference gets the same fallback");
});

test("the motion reuses the shared tokens and keyframes rather than inventing new ones", () => {
  const block = css.slice(css.indexOf("V5-UX-C14"));
  assert.match(block, /\.ops-card \{[^}]*animation: receipt-in var\(--motion-enter\) var\(--ease\) both;[^}]*animation-delay: var\(--ops-delay, 0ms\);/);
  assert.match(block, /\.ops-orb\[data-tempo="calm"\] \{[^}]*animation: breathe var\(--motion-calm\)/);
  assert.match(block, /\.ops-orb\[data-tempo="attention"\] \{[^}]*animation: breathe var\(--motion-attention\)/);
  assert.match(block, /\.ops-orb\[data-tempo="urgent"\] \{[^}]*animation: breathe var\(--motion-urgent\)/);
  assert.match(block, /\.ops-lane \{[^}]*transition: transform var\(--motion-enter\) var\(--ease\)/);
  assert.match(block, /\.ops-lane:active \{[^}]*transform: scale\(0\.98\)/, "press feedback");
  assert.doesNotMatch(block, /@keyframes/, "no new keyframes: the shared ones cover it");
});

/* ------------------------------------------------------------- the page */

test("the page takes governance-queue as its own read, paints both cards and ticks only with real data", () => {
  assert.match(pageJs, /take\("approvals", \(\) => client\.governanceQueue\(\), "the governance queue refused or could not be reached"\)/);
  assert.match(pageJs, /approvalsCard\(/);
  assert.match(pageJs, /scheduleCard\(\)/);
  assert.match(pageJs, /prefersReducedMotion\(\)/);
  assert.match(pageJs, /countUpFrames\(/);
  assert.match(pageJs, /entranceDelay\(/);
  // The Worker's CSP is `style-src 'self'` with no 'unsafe-inline', which
  // refuses a style ATTRIBUTE written into markup. The stagger goes through
  // CSSOM, which that policy allows.
  assert.match(pageJs, /style\.setProperty\("--ops-delay", `\$\{entranceDelay\(/);
  assert.doesNotMatch(pageJs, /style="--ops-delay/);
  assert.doesNotMatch(pageJs, /operationsBlocks\(/, "the placeholder blocks are gone");
  // The ambient clock runs only while a real oldest timestamp exists, and is
  // stopped before every repaint so two clocks never race.
  assert.match(pageJs, /if \(card\.oldest\) startWaitingClock\(card\.oldest\.at\)/);
  assert.match(pageJs, /stopWaitingClock\(\);/);
  const dashboard = /<section class="tabpanel" id="panelDashboard"[\s\S]*?<\/section>\s*<section class="tabpanel" id="panelAttention"/.exec(html)?.[0] || "";
  assert.match(dashboard, /<div id="operationsBlocks"><\/div>/);
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
