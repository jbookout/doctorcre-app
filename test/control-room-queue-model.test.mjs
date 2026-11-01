import test from "node:test";
import assert from "node:assert/strict";
import {
  SECTION_KEYS, sectionForTab, kindLabel, statusGroup, validCensus, createQueue, addPage,
  queueItems, groupItems, triageItems, coverageLine, isTriageState, refreshQueue, settleRefresh, bugItems, REASON_WORDS,
} from "../js/control-room-queue-model.js";

// Synthetic rows in the producer's own vocabulary (unfinished-work.v1,
// mcp-server/src/system-work-census.v5.js): one per kind the live census
// returned on 2026-10-18.
const row = (kind, id, state, extra = {}) => ({
  kind, id, state, status: state, title: `Demo ${kind} ${id}`, owner: "joe", age: 3,
  version: "2", link: null, source: `demo.${kind}`, source_ref: `demo.${kind}`,
  identity: {}, available_triage_actions: [], completed: false, cancelled: false,
  opened_at: "2026-10-01T12:00:00.000Z", last_activity_at: "2026-10-15T12:00:00.000Z", ...extra,
});
const NINE = [
  row("work_request", "WR-000910", "verification", { identity: { human_ref: "WR-000910" } }),
  row("incident", "INC-20261001-01", "monitoring", { identity: { ref: "INC-20261001-01" }, version: null }),
  row("defect", "0d3f6c2a-0000-4000-8000-00000000d001", "fix_untracked", { identity: { defect_id: "0d3f6c2a-0000-4000-8000-00000000d001" }, owner: null, version: null }),
  row("loop", "1a2b3c4d-0000-4000-8000-00000000a001", "open", { identity: { loop_id: "1a2b3c4d-0000-4000-8000-00000000a001", kind: "open_loop" },
    available_triage_actions: [{ action: "cancel", verb: "close-loop", args: {}, fields: [{ name: "outcome" }], versioned: true }] }),
  row("work_shape", "5e6f7a8b-0000-4000-8000-00000000b001", "ready", { identity: { work_request: "WR-000911" } }),
  row("builder_brief", "5e6f7a8b-0000-4000-8000-00000000b002", "triaged", { identity: { work_request: "WR-000912" } }),
  row("slice_plan", "9c8d7e6f-0000-4000-8000-00000000c001", "blocked", { identity: { work_request: "WR-000913" }, link: "/system-work.html?work_request=WR-000913" }),
  row("capability_session", "2b3c4d5e-0000-4000-8000-00000000e001", "claimed", { identity: { sequence: 2 } }),
  row("retrieval_proposal", "3c4d5e6f-0000-4000-8000-00000000f001", "pending", { owner: null }),
];
const census = (items, extra = {}) => ({
  ok: true, schema: "unfinished-work.v1", items, census_complete: true, next_cursor: null, limit: 100,
  coverage: [...new Set(items.map((item) => item.kind))].map((kind) => ({ kind, source_ref: `demo.${kind}`, state: "complete", count_total: items.filter((item) => item.kind === kind).length, count_returned: items.filter((item) => item.kind === kind).length, reason: null })),
  ...extra,
});

test("the section router maps every old ?tab= key onto a new section", () => {
  assert.deepEqual(SECTION_KEYS, ["inbox", "waiting", "triage", "queue", "views", "boards", "approvals", "automations", "connections", "agents", "system-map", "sessions"]);
  const legacy = { overview: "boards", dashboard: "boards", connections: "connections", automations: "automations", attention: "views", agents: "agents", "model-room": "agents", "system-map": "system-map", atlas: "system-map", sessions: "sessions" };
  for (const [old, section] of Object.entries(legacy)) assert.equal(sectionForTab(old), section, old);
  for (const key of SECTION_KEYS) assert.equal(sectionForTab(key), key);
  assert.equal(sectionForTab(null), "queue");
  assert.equal(sectionForTab("nonsense"), "queue");
});

test("all nine unfinished-work kinds normalise into one issue shape", () => {
  const queue = addPage(createQueue(), census(NINE), {
    incidents: { incidents: [{ ref: "INC-20261001-01", severity: "sev2", occurrences: 3 }] },
    current: { current: [{ human_ref: "WR-000910", executor: "claude", owner: "joe", state: "in_progress" }] },
  });
  const all = queueItems(queue, { includeTriage: true });
  assert.equal(all.length, 9);
  const shape = ["id", "kind", "kindLabel", "ref", "title", "statusGroup", "state", "source", "owner", "age", "version", "link", "triageActions", "holder"];
  for (const issue of all) for (const key of shape) assert.ok(key in issue, `${issue.kind} lacks ${key}`);
  const by = Object.fromEntries(all.map((issue) => [issue.kind, issue]));
  assert.deepEqual(Object.keys(by).sort(), NINE.map((r) => r.kind).sort());
  assert.equal(by.work_request.ref, "WR-000910");
  assert.equal(by.work_request.holder, "claude");
  assert.equal(by.work_request.statusGroup, "review");
  assert.equal(by.incident.ref, "INC-20261001-01");
  assert.equal(by.incident.severity, "sev2");
  assert.equal(by.incident.occurrences, 3);
  assert.equal(by.defect.ref, "DEF-0d3f6c2a");
  assert.equal(by.defect.statusGroup, "triage");
  assert.deepEqual(by.defect.triageActions, [], "X2: defects carry no triage action");
  assert.equal(by.loop.ref, "LOOP-1a2b3c4d");
  assert.equal(by.loop.statusGroup, "backlog");
  assert.deepEqual(by.loop.triageActions.map((a) => a.verb), ["close-loop"]);
  assert.equal(by.work_shape.ref, "WR-000911");
  assert.equal(by.work_shape.statusGroup, "ready");
  assert.equal(by.builder_brief.ref, "WR-000912");
  assert.equal(by.slice_plan.statusGroup, "blocked");
  assert.equal(by.slice_plan.link, "/system-work.html?work_request=WR-000913");
  assert.equal(by.capability_session.statusGroup, "in_progress");
  assert.equal(by.retrieval_proposal.statusGroup, "review");
  assert.equal(by.retrieval_proposal.owner, null);
  for (const issue of all) assert.equal(issue.kindLabel, kindLabel(issue.kind));
  assert.equal(kindLabel("work_request"), "Work Request");
  assert.equal(kindLabel("brand_new_kind"), "Brand new kind", "an unknown kind still gets a readable label");
  assert.equal(statusGroup("work_request", "an_unknown_state"), "other", "nothing disappears");
  assert.equal(new Set(all.map((issue) => issue.id)).size, 9, "ids are unique across kinds");
});

test("the Queue excludes triage-state items unless the Everything flag asks for them", () => {
  const rows = [...NINE,
    row("work_request", "WR-000920", "captured", { identity: { human_ref: "WR-000920" },
      available_triage_actions: [{ action: "progress", verb: "review-and-triage", args: {}, fields: [], versioned: true }] }),
    row("incident", "INC-20261002-01", "detected", { identity: { ref: "INC-20261002-01" }, version: null,
      available_triage_actions: [{ action: "progress", verb: "triage-incident", args: {}, fields: [], versioned: false }] })];
  const queue = addPage(createQueue(), census(rows));
  for (const state of ["captured", "detected", "fix_untracked"]) assert.equal(isTriageState(state), true, state);
  assert.equal(isTriageState("open"), false);
  const plain = queueItems(queue);
  assert.equal(plain.length, 8);
  assert.ok(plain.every((issue) => !isTriageState(issue.state)), "default Queue holds no captured, detected or untracked rows");
  const everything = queueItems(queue, { includeTriage: true });
  assert.equal(everything.length, 11);
  assert.deepEqual(triageItems(queue).map((issue) => issue.ref), ["WR-000920", "INC-20261002-01"],
    "Triage holds only triage-state rows with an allowed transition; untracked defects stay out (X2)");
  const groups = groupItems(plain);
  assert.deepEqual(groups.map((group) => group.key), ["in_progress", "review", "blocked", "ready", "backlog"]);
  assert.ok(groups.every((group) => group.label && group.items.length > 0));
  assert.deepEqual(groupItems([]), []);
});

test("cursor paging appends without duplicates and keeps the latest cursor and coverage", () => {
  const first = census(NINE.slice(0, 5), { census_complete: false, next_cursor: "cursor-1" });
  const second = census([NINE[4], ...NINE.slice(5)], { census_complete: true, next_cursor: null });
  let queue = addPage(createQueue(), first);
  assert.equal(queue.nextCursor, "cursor-1");
  assert.equal(queue.pages, 1);
  queue = addPage(queue, second);
  assert.equal(queue.nextCursor, null);
  assert.equal(queue.pages, 2);
  assert.equal(queueItems(queue, { includeTriage: true }).length, 9, "the repeated row is not duplicated");
  assert.equal(queue.censusComplete, true);
});

test("the coverage line is one short sentence; per-source detail sits behind it in plain words", () => {
  const partial = census(NINE, {
    census_complete: false, next_cursor: "cursor-2",
    coverage: [
      { kind: "work_request", source_ref: "ops.work_request", state: "complete", count_total: 445, count_returned: 1, reason: null },
      { kind: "defect", source_ref: "public.defect", state: "partial", count_total: 645, count_returned: 1, reason: "fix_status_not_recorded" },
      { kind: "pull_request", source_ref: "github", state: "unavailable", count_total: null, count_returned: 0, reason: "github_cache_missing_stale_or_incomplete" },
      { kind: "builder_brief_file", source_ref: "builder_files", state: "partial", count_total: 3, count_returned: 0, reason: "unstructured_brief_pr_relationships" },
    ],
  });
  const line = coverageLine(addPage(createQueue(), partial));
  assert.equal(line.complete, false);
  assert.equal(line.text, "9 loaded · more to load · 3 sources incomplete");
  assert.doesNotMatch(line.text, /_|cache|unstructured/, "no internal codes in the default line");
  assert.deepEqual(line.details, [
    { source: "Defect", text: "Partly read: fix status not recorded" },
    { source: "Pull request", text: "Not read: GitHub data has not been refreshed" },
    { source: "Builder brief file", text: "Partly read: links to pull requests are not recorded" },
  ]);
  for (const detail of line.details) assert.doesNotMatch(detail.text, /_/);
  const complete = coverageLine(addPage(createQueue(), census(NINE)));
  assert.equal(complete.complete, true);
  assert.equal(complete.text, "9 items · every source read");
  assert.deepEqual(complete.details, []);
  assert.equal(coverageLine(addPage(createQueue(), census([]))).text, "0 items · every source read");
  const one = coverageLine(addPage(createQueue(), census(NINE, { census_complete: false, coverage: [{ kind: "loop", state: "partial", count_total: 2, reason: "brand_new_reason" }] })));
  assert.equal(one.text, "9 loaded · 1 source incomplete");
  assert.deepEqual(one.details, [{ source: "Loop", text: "Partly read: brand new reason" }], "an unknown reason still reads as words");
  assert.equal(coverageLine(createQueue()).complete, false, "nothing read is not complete");
});

test("every real Work Request, incident and loop state lands in a named group, never Other", () => {
  // States from carr-system migrations 0114 (ops.work_request), 0115 (ops.incident), 0024 (loop_item).
  const expected = {
    work_request: { captured: "triage", triaged: "ready", ready: "ready", claimed: "in_progress", in_progress: "in_progress",
      verification: "review", awaiting_release: "review", released: "review", needs_joe: "blocked", blocked: "blocked",
      failed: "blocked", confirmed_closed: "closed", declined: "closed", superseded: "closed" },
    incident: { detected: "triage", triaged: "ready", investigating: "in_progress", mitigating: "in_progress",
      monitoring: "review", resolved: "closed", reviewed: "closed" },
    loop: { open: "backlog", done: "closed", dropped: "closed" },
  };
  for (const [kind, states] of Object.entries(expected))
    for (const [state, group] of Object.entries(states)) assert.equal(statusGroup(kind, state), group, `${kind}:${state}`);
  const queue = addPage(createQueue(), census([row("work_request", "WR-000930", "needs_joe", { identity: { human_ref: "WR-000930" } })]));
  assert.equal(queueItems(queue)[0].statusGroup, "blocked", "needs_joe shows as blocked on Joe, not Other");
});

test("a refresh re-reads every page already loaded, so Load more survives the 15-second update", async () => {
  const pages = { "": census(NINE.slice(0, 5), { census_complete: false, next_cursor: "c1" }),
    c1: census(NINE.slice(5), { census_complete: true, next_cursor: null }) };
  const reads = [];
  const read = async (cursor) => { reads.push(cursor); return pages[cursor ?? ""]; };
  let queue = addPage(createQueue(), await read(null));
  queue = addPage(queue, await read("c1"));
  assert.equal(queueItems(queue, { includeTriage: true }).length, 9);
  reads.length = 0;
  pages[""] = census(NINE.slice(1, 5), { census_complete: false, next_cursor: "c1" });
  const refreshed = await refreshQueue(queue, read);
  assert.deepEqual(reads, [null, "c1"], "both loaded pages are re-read in order");
  assert.equal(refreshed.pages, 2);
  assert.equal(queueItems(refreshed, { includeTriage: true }).length, 8, "a row gone from the source leaves the queue");
  const fresh = await refreshQueue(createQueue(), read);
  assert.equal(fresh.pages, 1, "an unread queue refreshes to one page");
  pages[""] = census(NINE.slice(0, 3), { census_complete: true, next_cursor: null });
  const shrunk = await refreshQueue(queue, read);
  assert.equal(shrunk.pages, 1, "stops when the source has no further page");
});

test("the Bugs view holds defects and incidents, untracked defects included (X2)", () => {
  const queue = addPage(createQueue(), census([...NINE,
    row("incident", "INC-20261002-01", "detected", { identity: { ref: "INC-20261002-01" }, version: null })]));
  assert.deepEqual(bugItems(queue).map((issue) => issue.kind).sort(), ["defect", "incident", "incident"]);
});

test("an invalid census is refused instead of rendering as an empty queue", () => {
  assert.equal(validCensus(census(NINE)), true);
  for (const bad of [null, {}, { schema: "unfinished-work.v1", items: "x", coverage: [] }, { schema: "other", items: [], coverage: [] },
    { schema: "unfinished-work.v1", items: [], coverage: [], census_complete: "yes" }]) assert.equal(validCensus(bad), false);
  assert.throws(() => addPage(createQueue(), { schema: "nope" }), /Invalid unfinished-work read/);
  const rows = addPage(createQueue(), census([row("loop", "", "open"), ...NINE.slice(0, 1)]));
  assert.equal(queueItems(rows, { includeTriage: true }).length, 1, "a row without an id is dropped, not invented");
});

test("every reason code the census producer emits has a plain-words entry, including github_cache_unavailable", () => {
  const emitted = ["fix_status_not_recorded", "github_cache_missing_stale_or_incomplete", "github_cache_unavailable",
    "unstructured_brief_pr_relationships", "cache_contains_open_github_work_only", "external_history_pages_missing_or_invalid",
    "rows_rejected_invalid_dates_or_identity", "rows_missing_dates", "count_unavailable", "DEPENDENCY_UNAVAILABLE", "source_read_failed"];
  for (const code of emitted) assert.ok(REASON_WORDS[code], `${code} has plain words`);
  const line = coverageLine(addPage(createQueue(), census(NINE, { census_complete: false,
    coverage: [{ kind: "builder_brief_file", state: "unavailable", count_total: null, reason: "github_cache_unavailable" }] })));
  assert.equal(line.details[0].text, "Not read: GitHub data could not be read");
});

test("a refresh in flight while Load more lands cannot overwrite the page just loaded", async () => {
  const pages = { "": census(NINE.slice(0, 5), { census_complete: false, next_cursor: "c1" }),
    c1: census(NINE.slice(5), { census_complete: true, next_cursor: null }) };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let queue = addPage(createQueue(), pages[""]);
  const inFlight = refreshQueue(queue, async (cursor) => { await gate; return pages[cursor ?? ""]; });
  queue = addPage(queue, pages.c1); // Load more lands while the refresh is still reading
  assert.equal(queue.pages, 2);
  release();
  const stale = await inFlight;
  assert.equal(stale.pages, 1, "the in-flight refresh only knew about one page");
  queue = settleRefresh(queue, stale);
  assert.equal(queue.pages, 2, "the stale response is dropped");
  assert.equal(queueItems(queue, { includeTriage: true }).length, 9);
  const next = await refreshQueue(queue, async (cursor) => pages[cursor ?? ""]);
  assert.equal(settleRefresh(queue, next).pages, 2, "later refreshes keep the larger page count");
  const fresher = addPage(addPage(createQueue(), pages[""]), pages.c1);
  assert.equal(settleRefresh(queue, fresher), fresher, "an equal or larger refresh replaces the queue");
});

test('queue refresh cannot drain an unbounded sequence of distinct pages', async () => {
  let reads = 0;
  await assert.rejects(refreshQueue({ ...createQueue(), pages: 1000 }, async () => {
    reads++;
    return census([], { next_cursor: `next-${reads}` });
  }), /page_limit/);
  assert.equal(reads, 100);
});
