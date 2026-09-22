// V5-UX-C01 — one test per checkable-done clause, plus the static page rules.
//
// The payloads below are the record layer's own shapes, keyed as
// mcp-server's incident and work-request reads key them: `occurrences`,
// `age_days`, `next_action`, `hours_since_last_change`, `blocker`, `wip`. A
// test written against friendlier names would pass here and fail against CARR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  NO_CADENCE_REASON, TILES, canonicalHref, coverageLine, dashboardTiles, groupedIncidents,
  incidentFilters, needsJoeAdvisoryLabel, notInReleaseBlocks, operationsBlocks, readPhase, sinceChangeLabel, stallCandidates,
  validCurrentWorkItemPayload, validCurrentWorkRequestsPayload, validIncidentBoardPayload,
  workInProgressLine, STUCK_SILENCE_HOURS,
} from "../js/control-room-model.js";
import { acceptsResponse } from "../js/workspace-command-center-model.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("control-room.html");
const css = await read("css/control-room.css");
const pageJs = await read("js/control-room.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async () => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}` });
};

const INCIDENTS = {
  count: 2,
  by_severity: { "SEV-1": 1, "SEV-3": 1 },
  by_state: { investigating: 1, monitoring: 1 },
  ready_to_close: 1,
  incidents: [
    {
      ref: "INC-20260915-01", title: "Demo export stopped writing", severity: "SEV-1", state: "investigating",
      owner_actor: "joe", next_action: "Read the demo export log", age_days: 4, occurrences: 6,
      ready_to_close: false, blocked_by: "no recovery evidence — supply one, or adjudicate it as a duplicate",
    },
    {
      ref: "INC-20260916-03", title: "Demo deploy retried once", severity: "SEV-3", state: "monitoring",
      owner_actor: "dell", next_action: null, age_days: 1, occurrences: 1, ready_to_close: true, blocked_by: null,
    },
  ],
};

const WORK = {
  ok: true, count: 2,
  current: [
    { human_ref: "WR-000901", title: "Demo reconcile", state: "in_progress", owner: "joe", executor: "claude", done_predicate: ["Demo rows reconcile"], blocker: null, hours_since_last_change: 3.5 },
    { human_ref: "WR-000902", title: "Demo coverage note", state: "blocked", owner: "joe", executor: "dell", done_predicate: null, blocker: { code: "counterparty", detail: "Demo Coastal Surveying has not answered" }, hours_since_last_change: 51.2 },
  ],
  wip: { limit_system_wide: 2, limit_per_executor: 1, in_flight: 1, over_system_limit: false },
};

const NEEDS_JOE = {
  ok: true,
  items: [
    { human_ref: "WR-000904", title: "Demo retention window", state: "needs_joe", source: { label: "Demo council minute", freshness: "fresh" }, next_human_action: "Name the demo retention window" },
  ],
};

const answered = (payload) => ({ state: "read", payload });
const refused = (reason) => ({ state: "unknown", reason });

/* ------------------------------------------------------- checkable done clauses */

test("the five questions are answered from the real payload shapes, in doctrine order", () => {
  assert.ok(validIncidentBoardPayload(INCIDENTS));
  assert.ok(validCurrentWorkItemPayload(WORK));
  assert.ok(validCurrentWorkRequestsPayload(NEEDS_JOE));
  const tiles = dashboardTiles({ incidents: answered(INCIDENTS), work: answered(WORK), needsJoe: answered(NEEDS_JOE) });
  assert.deepEqual(tiles.map((tile) => tile.id), [...TILES]);
  assert.deepEqual(tiles.map((tile) => tile.title), ["Broken", "Running", "Stuck", "Needs Joe", "Changed"]);
  assert.equal(tiles[0].value, 2);
  assert.equal(tiles[1].value, 2);
  assert.equal(tiles[3].value, 1);
  // With no cadence passed, Stuck is still unknown by ruling, not by outage,
  // and Changed has no producer.
  assert.equal(tiles[2].state, "unknown");
  assert.equal(tiles[2].reason, NO_CADENCE_REASON);
  assert.equal(tiles[4].state, "not_in_release");
  for (const tile of tiles) assert.ok(tile.sentence.length > 0 && !/\bunknown count\b/.test(tile.sentence));
});

test("one read failing makes only its own tile unknown, and no tile falls back to zero", () => {
  const tiles = dashboardTiles({
    incidents: refused("the incident ledger refused"), work: answered(WORK), needsJoe: answered(NEEDS_JOE),
  });
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(byId.broken.state, "unknown");
  assert.equal(byId.broken.value, null);
  assert.equal(byId.broken.word, "unknown");
  assert.match(byId.broken.sentence, /the incident ledger refused/);
  assert.equal(byId.running.state, "read");
  assert.equal(byId.running.value, 2);
  assert.equal(byId.needs_joe.value, 1);
  for (const tile of tiles) {
    if (tile.state !== "read") assert.equal(tile.value, null, `${tile.id} invented a value`);
    assert.notEqual(tile.word, "0", `${tile.id} fell back to zero`);
  }
});

test("a verified zero stays a zero and never becomes unknown", () => {
  const empty = { ...INCIDENTS, count: 0, incidents: [], by_severity: {}, by_state: {}, ready_to_close: 0 };
  const [broken] = dashboardTiles({ incidents: answered(empty) });
  assert.equal(broken.state, "read");
  assert.equal(broken.value, 0);
  assert.equal(broken.word, "0");
});

test("a payload the read layer would not recognise is refused rather than rendered", () => {
  assert.equal(validIncidentBoardPayload({ count: 1, incidents: [] }), false);
  assert.equal(validIncidentBoardPayload({ ...INCIDENTS, incidents: [{ ...INCIDENTS.incidents[0], severity: "high" }], count: 1 }), false);
  assert.equal(validCurrentWorkItemPayload({ ...WORK, wip: { limit_system_wide: "two", in_flight: 1 } }), false);
  assert.equal(validCurrentWorkItemPayload({ ...WORK, current: [{ ...WORK.current[0], state: "ready" }], count: 1 }), false);
  assert.equal(validCurrentWorkRequestsPayload({ ok: true, items: [{ human_ref: "WR-1", title: "x", state: "needs_joe" }] }), false);
  const [broken] = dashboardTiles({ incidents: answered({ count: 1, incidents: [] }) });
  assert.equal(broken.value, null);
});

test("the coverage line states each read's own clock and carries no denominator", () => {
  const chips = coverageLine({
    incidents: { state: "read", observed_at: "2026-09-17T14:02:00Z" },
    work: { state: "unknown", reason: "the held-work read refused" },
    needs_joe: { state: "read", observed_at: "2026-09-17T14:02:30Z" },
    census: { state: "read", observed_at: "not a time" },
  });
  assert.deepEqual(chips.map((chip) => chip.state), ["read", "unknown", "read", "unknown"]);
  assert.equal(chips[0].text, "Incidents: read at 2:02 PM");
  assert.equal(chips[1].text, "Active work: unknown (the held-work read refused)");
  assert.match(chips[3].text, /unknown \(the read carried no readable time\)/);
  for (const chip of chips) assert.doesNotMatch(chip.text, /\bof \d+ collectors\b/);
  assert.equal(coverageLine({}).length, 0);
});

test("read phase separates loading, partial, offline and ready without blanking the page", () => {
  assert.equal(readPhase({ status: "loading", reads: {} }), "loading");
  assert.equal(readPhase({ status: "ready", reads: { incidents: { state: "read", observed_at: "2026-09-17T14:02:00Z" } } }), "ready");
  assert.equal(readPhase({ status: "ready", reads: { incidents: { state: "read", observed_at: "2026-09-17T14:02:00Z" }, work: { state: "unknown", reason: "refused" } } }), "partial");
  assert.equal(readPhase({ status: "ready", reads: { incidents: { state: "unknown", reason: "refused" } } }), "offline");
  assert.equal(readPhase({ status: "unauthorized", reads: {} }), "no_access");
});

test("stuck states facts, not a verdict, until a cadence is approved", () => {
  const without = stallCandidates(WORK.current, {});
  assert.equal(without.state, "unknown");
  assert.equal(without.reason, NO_CADENCE_REASON);
  assert.deepEqual(without.items.map((item) => item.human_ref), ["WR-000902", "WR-000901"]);
  // The later ruling turns it on without a rewrite.
  const withCadence = stallCandidates(WORK.current, { cadence: 48 });
  assert.equal(withCadence.state, "read");
  assert.deepEqual(withCadence.items.map((item) => item.human_ref), ["WR-000902"]);
  assert.equal(sinceChangeLabel(51.2), "51.2 hours since change");
  assert.equal(sinceChangeLabel(1), "1 hour since change");
  assert.equal(sinceChangeLabel(null), "unknown");
});

test("the approved 48-hour cadence turns Stuck into a count the read actually supports", () => {
  assert.equal(STUCK_SILENCE_HOURS, 48);
  const tiles = dashboardTiles({
    incidents: answered(INCIDENTS), work: answered(WORK), needsJoe: answered(NEEDS_JOE),
    cadence: STUCK_SILENCE_HOURS,
  });
  const stuck = tiles.find((tile) => tile.id === "stuck");
  // 47 h is not stuck; 49 h is. The fixture above holds one of each side.
  assert.equal(stuck.state, "read");
  assert.equal(stuck.value, 1, "only the 51.2-hour row is past the cadence");
  assert.equal(stuck.sentence, "Held work with no change for 48 hours or more.");
  assert.equal(stuck.reason, null);

  const edges = {
    ...WORK,
    count: 2,
    current: [
      { ...WORK.current[0], human_ref: "WR-000911", hours_since_last_change: 47 },
      { ...WORK.current[1], human_ref: "WR-000912", hours_since_last_change: 49 },
    ],
  };
  assert.deepEqual(
    stallCandidates(edges.current, { cadence: STUCK_SILENCE_HOURS }).items.map((item) => item.human_ref),
    ["WR-000912"],
  );
  const quiet = dashboardTiles({
    incidents: answered(INCIDENTS), needsJoe: answered(NEEDS_JOE), cadence: STUCK_SILENCE_HOURS,
    work: answered({ ...WORK, count: 1, current: [{ ...WORK.current[0], hours_since_last_change: 2 }] }),
  });
  const none = quiet.find((tile) => tile.id === "stuck");
  assert.equal(none.state, "read");
  assert.equal(none.value, 0, "a read that answered says 0, never unknown");

  // An unanswered read is the only thing that still says unknown.
  const outage = dashboardTiles({
    incidents: answered(INCIDENTS), work: refused("the held-work read refused"),
    needsJoe: answered(NEEDS_JOE), cadence: STUCK_SILENCE_HOURS,
  });
  assert.equal(outage.find((tile) => tile.id === "stuck").state, "unknown");
});

test("the Control Room page passes the approved cadence rather than inventing one", () => {
  assert.match(pageJs, /cadence: STUCK_SILENCE_HOURS/);
  assert.doesNotMatch(pageJs, /cadence: null/);
  assert.match(pageJs, /STUCK_SILENCE_HOURS,\n\} from "\.\/control-room-model\.js";/);
});

test("the work-in-progress line is stated only when the read carried both integers", () => {
  assert.deepEqual(workInProgressLine(WORK.wip), { known: true, text: "1 of 2 in flight" });
  assert.deepEqual(workInProgressLine({ in_flight: 1 }), { known: false, text: "unknown" });
  assert.deepEqual(workInProgressLine(null), { known: false, text: "unknown" });
});

test("incidents group by severity with the ledger's own next step, verbatim or absent", () => {
  const groups = groupedIncidents(INCIDENTS.incidents);
  assert.deepEqual(groups.map((group) => group.severity), ["SEV-1", "SEV-3"]);
  const [first] = groups[0].incidents;
  assert.equal(first.recommendedNext, "Read the demo export log");
  assert.equal(first.age, "4 days old");
  assert.equal(first.occurrences, 6);
  assert.equal(first.readyToClose, false);
  assert.equal(groups[1].incidents[0].recommendedNext, null, "an absent next step is never invented");
  assert.equal(groups[1].incidents[0].readyToClose, true);
  assert.equal(groupedIncidents(INCIDENTS.incidents, { severity: "SEV-3" }).length, 1);
  assert.deepEqual(incidentFilters(INCIDENTS.incidents).map((filter) => `${filter.id}:${filter.count}`), ["all:2", "SEV-1:1", "SEV-3:1"]);
});

test("an incident resolves to the same canonical identity from the tile and from the queue", () => {
  const fromQueue = groupedIncidents(INCIDENTS.incidents)[0].incidents[0];
  const fromTile = groupedIncidents(INCIDENTS.incidents, { severity: "SEV-1" })[0].incidents[0];
  assert.equal(fromTile.ref, fromQueue.ref);
  assert.equal(fromTile.href, fromQueue.href);
  // V5-UX-C14 gave an operational incident its own page, so the queue links to
  // it. Everything that is neither a work request nor an incident still has none.
  assert.equal(canonicalHref(INCIDENTS.incidents[0]), "/incidents?ref=INC-20260915-01");
  assert.equal(canonicalHref(WORK.current[0]), "/system-work.html");
  assert.equal(canonicalHref({ human_ref: "not a ref" }), null);
});

test("every prototype panel without a producer is a named scope statement", () => {
  const blocks = notInReleaseBlocks();
  const ids = blocks.map((block) => block.id);
  for (const id of ["changed", "accomplishments", "detected_and_repaired", "resources", "model_room", "atlas_renderer"]) {
    assert.ok(ids.includes(id), `${id} has no scope statement`);
  }
  for (const block of blocks) {
    assert.match(block.title, /not in this release$/);
    assert.match(block.slice, /^V5-UX-C[0-9]/, `${block.id} names no owning slice`);
    assert.ok(block.reason.length > 0);
  }
});

// V5-UX-C14 — the Operations section. Neither card may carry a digit: there is
// no read behind either of them, so any number would be invented.
test("the two Operations cards name their missing read and render no number", () => {
  const blocks = operationsBlocks();
  assert.deepEqual(blocks.map((block) => block.id), ["approvals", "automation"]);
  const approvals = blocks[0];
  const automation = blocks[1];
  assert.equal(approvals.title, "Approvals of production effects");
  assert.equal(automation.title, "Scheduled automation");
  for (const verb of ["accept-ready-plan", "accept-workflow", "issue-execution-envelope"]) {
    assert.ok(approvals.body.includes(verb), `${verb} is not named`);
  }
  assert.match(approvals.body, /partner-only and hash-pinned/);
  assert.match(approvals.body, /no read lists what is pending/);
  assert.match(approvals.rule, /^Reconcile before retry is already how every command on this app behaves/);
  assert.match(automation.body, /No read exposes scheduled jobs, last or next runs/);
  assert.match(automation.body, /no pause, run or stop verb/);
  assert.equal(automation.rule, null);
  for (const block of blocks) {
    assert.match(block.body, /^Not in this release\./);
    assert.doesNotMatch(`${block.title} ${block.body} ${block.rule || ""}`, /\d/, `${block.id} renders a number`);
  }
});

test("the Control Room page mounts the Operations section on the Dashboard tab", () => {
  const dashboard = /<section class="tabpanel" id="panelDashboard"[\s\S]*?<\/section>\s*<section class="tabpanel" id="panelAttention"/.exec(html)?.[0] || "";
  assert.match(dashboard, /<section class="card glass" data-section="operations"/, "Operations is not on the Dashboard tab");
  assert.match(dashboard, /<div id="operationsBlocks"><\/div>/);
  assert.doesNotMatch(html, /role="tab"[^>]*>Operations</, "Operations is a section, not a new tab");
  assert.match(pageJs, /operationsBlocks\(\)/, "the page does not render the model's blocks");
});

test("a stale answer that overtakes a newer read is dropped", () => {
  assert.equal(acceptsResponse(2, 2), true);
  assert.equal(acceptsResponse(3, 2), false);
  assert.match(pageJs, /acceptsResponse\(view\.sequence, sequence\)/, "the page drops an overtaken answer");
});

/* ---------------------------------------------------------------- the clients */

test("the fixture serves the three reads in the record layer's own shapes, and one switch makes one read fail", async () => {
  const client = await fixture();
  const incidents = await client.incidentBoard({ state: "open" });
  assert.ok(validIncidentBoardPayload(incidents));
  assert.equal(incidents.count, 3);
  assert.equal(incidents.ready_to_close, 1);
  assert.deepEqual(Object.keys(incidents.by_severity).sort(), ["SEV-1", "SEV-2", "SEV-3"]);
  assert.ok(incidents.incidents.some((row) => row.occurrences > 1), "one row recurs");
  assert.ok(incidents.incidents.every((row) => /^Demo /.test(row.title)));

  const work = await client.currentWorkItem();
  assert.ok(validCurrentWorkItemPayload(work));
  assert.equal(work.count, 3);
  assert.equal(new Set(work.current.map((row) => row.hours_since_last_change)).size, 3);
  assert.equal(work.current.filter((row) => row.blocker).length, 1);

  const needsJoe = await client.currentWorkRequests();
  assert.ok(validCurrentWorkRequestsPayload(needsJoe));
  assert.equal(needsJoe.items.length, 2);

  const seed = await read("data/board-seed.json");
  const outage = await createFixtureClient({
    seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, outage: "incidents",
  });
  await assert.rejects(() => outage.incidentBoard({}), /fixture outage/);
  assert.equal((await outage.currentWorkItem()).ok, true, "the other reads keep answering");
  assert.equal((await outage.currentWorkRequests()).ok, true);
});

test("live Needs Joe uses the authenticated GET and preserves received item order", async () => {
  const paths = [];
  const canonical = { ok: true, items: [
    { human_ref: "WR-000124", title: "First", state: "ready", source: { label: "source", freshness: "current" }, next_human_action: "Review" },
    { human_ref: "WR-000123", title: "Second", state: "ready", source: { label: "source", freshness: "current" }, next_human_action: "Decide" },
  ], advisory: { schema: "jev_c13_decision_queue_advisory/v1", status: "available",
    snapshot_digest: `sha256:${"a".repeat(64)}`, question_config_digest: `sha256:${"b".repeat(64)}`,
    model: "jev-1.13.0", source_observed_at: "2026-09-21T22:00:00.000Z", items: [
    { human_ref: "WR-000124", index: 0, judged: true, attention_class: "routine_review", priority_probability: 0.2, relevance_probability: 0.7, ambiguity_probability: 0.1, calibration_status: "unverified_model_output" },
    { human_ref: "WR-000123", index: 1, judged: false },
  ] } };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical.items)));
  canonical.advisory.snapshot_digest = `sha256:${[...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    paths.push({ path, init });
    return { ok: true, json: async () => ({ ok: true, data: canonical }) };
  } });
  const readback = await client.currentWorkRequests();
  assert.deepEqual(readback.items.map(item => item.human_ref), ["WR-000124", "WR-000123"]);
  assert.deepEqual(paths[0], { path: "/api/system-work/current", init: {
    credentials: "same-origin", headers: { accept: "application/json" }, cache: "no-store",
  } });
  assert.match(needsJoeAdvisoryLabel(readback, 0), /Jev estimate \(uncalibrated\).*priority 20%/);
  assert.equal(needsJoeAdvisoryLabel(readback, 1), "Jev abstained");
  const unsupportedCalibration = structuredClone(readback);
  delete unsupportedCalibration.advisory.items[0].calibration_status;
  assert.equal(needsJoeAdvisoryLabel(unsupportedCalibration, 0), "Jev advisory unavailable");
  const swapped = structuredClone(readback);
  swapped.advisory.items.reverse();
  assert.equal(needsJoeAdvisoryLabel(swapped, 0), "Jev advisory unavailable");
  assert.deepEqual(swapped.items, canonical.items);
  canonical.advisory.snapshot_digest = `sha256:${"c".repeat(64)}`;
  const stale = await client.currentWorkRequests();
  assert.deepEqual(stale.items, canonical.items);
  assert.equal(needsJoeAdvisoryLabel(stale, 0), "Jev advisory unavailable");
});

/* --------------------------------------------------------------- static page */

test("the route and the three verbs are pinned in the contracts", () => {
  assert.equal(routes.routes["/control-room"], "control-room.html");
  assert.equal(routes.version, "1.10.0");
  assert.equal(contract.version, "1.19.0");
  for (const verb of ["incident-board", "current-work-item", "current-work-requests", "get-incident", "link-incident-work-request"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.equal(routes.routes["/incidents"], "incidents.html", "the incident queue links to a route that exists");
  // V5-UX-S02: the Sessions tab is a fifth tab on an already-admitted route, so
  // its two reads are pinned and NO route moves.
  for (const verb of ["read-session-identity", "read-dispatch-history"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.equal(contract.mcp_operations.length, 57);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
});

test("the page is the shared shell: one live line, tabs, one Doc, AM/PM, no lede, and 44px targets", () => {
  assert.match(html, /<title>Control Room · DoctorCRE<\/title>/);
  assert.match(html, /<div class="tabs" id="controlRoomTabs" role="tablist"/);
  for (const label of ["Dashboard", "Attention", "Model Room", "Atlas", "Sessions"]) {
    assert.match(html, new RegExp(`role="tab"[^>]*>${label}<`), `tab ${label}`);
  }
  assert.equal([...html.matchAll(/aria-live="polite" role="status"/g)].length, 1, "one status live region");
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.equal([...html.matchAll(/class="doc-chat glass" id="docChat"/g)].length, 1, "Doc appears once");
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.doesNotMatch(html, /\bTODO\b/);
  assert.doesNotMatch(html, /draggable="true"/, "nothing here is drag-only");
  assert.match(html, /<dialog id="incidentDialog"/, "the incident card is a popup");
  for (const match of html.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>").matchAll(/\b\d{1,2}:\d{2}\b(.{0,4})/g)) {
    assert.match(match[1], /^\s*(AM|PM)/, `"${match[0]}" prints without AM or PM`);
  }
  assert.match(css, /\.chip \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.btn-group \.btn \{ min-height: var\(--touch\); \}/);
  assert.match(pageJs, /formatClock/, "clocks come from the shared formatter");
  assert.doesNotMatch(pageJs, /scrollIntoView/, "tabs and popups, never autoscroll");
  for (const write of ["addLoop", "patchDealField", "closeIncident", "adjudicate"]) {
    assert.ok(!pageJs.includes(write), `the Control Room must not ${write}`);
  }
});

/* ------------------------------------------- V5-UX-C07: the Atlas tab (C07) */
//
// One test per checkable-done clause and per acceptance text in scope. The
// payloads below are the PRODUCER's own shapes, taken from
// mcp-server/src/atlas-inventory-graph.v5.js at a7b7bf46: a node carries ten
// keys or thirteen, `inferred` is a coverage class and never a layer, and the
// four structural gaps ride on every response. A test written against
// friendlier names would pass here and fail against CARR.
//
// The fixture is EXECUTED, not described: atlasFixtureResponse is the same
// function scripts/serve.mjs answers the route with, so the fixture cannot
// drift away from what these tests certify.
import { atlasFixtureResponse } from "../scripts/atlas-fixture.mjs";
import {
  ATLAS_LAYERS, ATLAS_LIMIT_MAX, ATLAS_STATE_COPY, EVIDENCE_CLASSES, EXPOSURE_STATEMENT,
  INCOMPLETE_HEADING, KNOWN_GAPS, NO_ENFORCEMENT_SENTENCE, NO_SUCCESSOR_SENTENCE,
  NO_TEST_EVIDENCE_SENTENCE, PAGE_SCOPE_SENTENCE, UNLINKED_SENTENCE, VERB_RUN_GAP_SENTENCE,
  atlasDegraded, atlasPhase, atlasRequestPath, classifyAtlasFailure, coverageGroups, coverageOrbFor,
  groupIndex, mergeNodePages, pagingState, selectionFor, validAtlasPayload,
  NO_OBSERVED_CLOCK, NO_OBSERVED_STATUS,
} from "../js/atlas-model.js";

const atlasJs = await read("js/atlas.js");
const atlasModelJs = await read("js/atlas-model.js");
const atlasFixtureJs = await read("scripts/atlas-fixture.mjs");
const checkJs = await read("scripts/check-repository.mjs");

/** The fixture route, reached exactly as the browser reaches it. */
const ATLAS_ORIGIN = "https://app.doctorcre.com";
const atlasCall = (query = "", method = "GET") =>
  atlasFixtureResponse(new URL(`${ATLAS_ORIGIN}/api/v1/atlas-graph${query}`), method);
const atlasBody = (query = "") => atlasCall(query).body;

const ATLAS_GAP_ROWS = KNOWN_GAPS.map((gap) => ({ ...gap, node_count: 0, edge_count: 0, complete: false }));

/** §2.5's example, completed with the four gaps the producer always appends. */
const atlasExample = () => structuredClone({
  version: {
    bundle_digest: "a".repeat(64), registry_version: "scac-mutation-registry.v32",
    registry_digest: "b".repeat(64), declared_counts: { verbs: 218, mutations: 0, surfaces: 0, routes: 0 },
  },
  observed_at: "2026-09-16T12:00:00.000Z",
  viewer: "joe", tenant: "carr-internal",
  layer: ["declared", "installed", "observed"],
  q: null, include_retired: false, limit: 500,
  nodes: [{
    id: "service:dealroom-worker", class: "service", key: "dealroom-worker", title: "Deal Room Worker",
    layer: "installed", status: "critical", retired_at: null, source_ref: "ops.service",
    evidence: "observed", unlinked: false, observed_at: "2026-09-16T11:40:00.000Z",
    observed_status: "succeeded", observed_source_ref: "ops.run",
  }, {
    id: "service:record-exporter", class: "service", key: "record-exporter", title: "Record Exporter",
    layer: "installed", status: "ordinary", retired_at: null, source_ref: "ops.service",
    evidence: "installed", unlinked: false,
  }],
  edges: [{
    from: "service:dealroom-worker", to: "service:record-exporter", type: "depends_on",
    evidence: "installed", source_ref: "ops.service_dependency", observed_at: null,
  }],
  index: { installed: { service: ["service:dealroom-worker", "service:record-exporter"] } },
  coverage: [
    { source_ref: "mcp-server/src/tools.js", evidence_class: "declared", node_count: 218, edge_count: 0, complete: true, missing_reason: null },
    { source_ref: "ops.service", evidence_class: "installed", node_count: 2, edge_count: 1, complete: true, missing_reason: null },
    ...ATLAS_GAP_ROWS,
  ],
  truncated: false, next_cursor: null,
  source: {
    source: "atlas_inventory_graph", source_ref: "mcp-server/src/tools.js+ops.service+verb->service",
    observed_at: "2026-09-16T12:00:00.000Z", correlation_id: "corr-atlas", freshness: "fresh",
    safe_explanation: "Every reachable source answered a no-store request-time read; the four structural gaps are named in coverage.",
  },
});

test("C07-1 the atlas payload validator accepts the producer's shape and refuses what it cannot render", () => {
  assert.equal(validAtlasPayload(atlasExample()), true, "the producer's own example is refused");

  const extraKey = atlasExample();
  extraKey.nodes[0].depth = 3;
  assert.equal(validAtlasPayload(extraKey), false, "an unknown node key is ignored rather than refused");

  const halfObserved = atlasExample();
  delete halfObserved.nodes[0].observed_source_ref;
  assert.equal(validAtlasPayload(halfObserved), false, "two of the three observed keys is accepted");

  const unexplained = atlasExample();
  unexplained.coverage[0] = { ...unexplained.coverage[0], complete: false, missing_reason: null };
  assert.equal(validAtlasPayload(unexplained), false, "an incomplete row with no reason is accepted");

  const inferredLayer = atlasExample();
  inferredLayer.nodes[0].layer = "inferred";
  assert.equal(validAtlasPayload(inferredLayer), false, "inferred is accepted as a layer");

  const inferredEvidence = atlasExample();
  inferredEvidence.nodes[1].evidence = "inferred";
  assert.equal(validAtlasPayload(inferredEvidence), false, "inferred is accepted as a node's evidence");

  const missingGap = atlasExample();
  missingGap.coverage = missingGap.coverage.slice(0, 5);
  assert.equal(validAtlasPayload(missingGap), false, "a response missing a structural gap is accepted");

  const withValidUntil = atlasExample();
  withValidUntil.source.valid_until = "2026-09-16T12:01:00.000Z";
  assert.equal(validAtlasPayload(withValidUntil), false, "the census's valid_until is accepted on the atlas source");
});

test("C07-2 all four evidence classes are distinguishable and source-linked, and no node carries inferred", () => {
  const body = atlasBody();
  assert.equal(validAtlasPayload(body), true, "the fixture does not satisfy the producer's own contract");
  for (const node of body.nodes) {
    assert.ok(ATLAS_LAYERS.includes(node.layer), `${node.id} has no renderable layer`);
    assert.ok(ATLAS_LAYERS.includes(node.evidence), `${node.id} has no renderable evidence`);
    assert.notEqual(node.evidence, "inferred", `${node.id} carries inferred as evidence`);
    assert.ok(node.source_ref.length > 0, `${node.id} is not source-linked`);
  }
  for (const edge of body.edges) {
    assert.ok(ATLAS_LAYERS.includes(edge.evidence), `${edge.type} has no typed evidence`);
    assert.ok(edge.source_ref.length > 0, `${edge.type} is not source-linked`);
  }
  const classes = new Set(body.coverage.map((row) => row.evidence_class));
  for (const name of EVIDENCE_CLASSES) assert.ok(classes.has(name), `${name} is not visible in coverage`);
  assert.ok(classes.has("inferred"), "the fourth class never reaches the reader");
  // A word beside every shape, never a colour alone.
  assert.match(atlasJs, /coverageGroups\(payload\.coverage\)/, "the page does not render the coverage block");
  assert.match(atlasJs, /chip\("evidence", entry\.evidence_class\)/, "a coverage row prints no evidence class");
  assert.match(atlasJs, /chip\("layer", node\.layer\)/, "a node row prints no layer");
  assert.match(atlasJs, /chip\("evidence", node\.evidence\)/, "a node row prints no evidence");
  assert.match(atlasJs, /escapeHtml\(node\.source_ref\)/, "a node row prints no source ref");
});

test("C07-3 the four structural gaps are rendered on every render, clean payload and failed leg alike", () => {
  const clean = atlasExample();
  const failed = atlasExample();
  failed.coverage.splice(2, 0, { source_ref: "ops.run", evidence_class: "observed", node_count: 0, edge_count: 0, complete: false, missing_reason: "DEPENDENCY_UNAVAILABLE" });
  for (const payload of [clean, failed]) {
    const groups = coverageGroups(payload.coverage);
    assert.equal(groups.gaps.length, 4, "the four structural gaps are not grouped as gaps");
    for (const gap of KNOWN_GAPS) {
      const row = groups.gaps.find((entry) => entry.source_ref === gap.source_ref);
      assert.ok(row, `${gap.source_ref} is not rendered`);
      assert.equal(row.evidence_class, gap.evidence_class);
      assert.equal(row.missing_reason, gap.missing_reason);
      assert.equal(coverageOrbFor(row), "urgent", `${gap.source_ref} paints as answered`);
    }
  }
  assert.equal(coverageGroups(atlasBody().coverage).gaps.length, 4, "the fixture drops a structural gap");
  const searched = atlasBody("?q=no-such-thing-anywhere");
  assert.equal(searched.nodes.length, 0, "the empty search still returns nodes");
  assert.equal(coverageGroups(searched.coverage).gaps.length, 4, "an empty page drops the gaps");
  assert.equal(atlasPhase({ status: "ready", payload: searched }), "empty");
  assert.match(html, /id="atlasCoverageGaps"/, "the page has no place for the known gaps");
  assert.match(html, /Known gaps in this release/, "the gaps have no heading of their own");
  assert.match(html, /Sources that answered/, "the answered sources have no heading of their own");
});

test("C07-4 an incomplete atlas is never shown as complete", () => {
  const degraded = atlasExample();
  degraded.coverage.splice(2, 0, { source_ref: "ops.run", evidence_class: "observed", node_count: 0, edge_count: 0, complete: false, missing_reason: "DEPENDENCY_UNAVAILABLE" });
  assert.equal(atlasDegraded(degraded), true);
  assert.equal(atlasPhase({ status: "ready", payload: degraded }), "partial");
  // The four structural gaps alone are not an outage; they are always there.
  assert.equal(atlasDegraded(atlasExample()), false, "the always-present gaps are read as a failed leg");
  assert.equal(INCOMPLETE_HEADING, "This atlas is incomplete, not empty");
  assert.match(atlasJs, /explanation\.textContent = payload\.source\.safe_explanation/, "safe_explanation is not printed verbatim");
  assert.match(atlasJs, /INCOMPLETE_HEADING/, "the incomplete heading is never shown");
  const live = atlasBody();
  assert.equal(live.source.freshness, "unknown", "a partial fixture claims fresh");
  assert.match(live.source.safe_explanation, /^This atlas is INCOMPLETE, not empty:/);
  assert.equal(atlasPhase({ status: "ready", payload: live }), "partial", "the fixture's default state is not partial");
  for (const [name, source] of [["js/atlas.js", atlasJs], ["js/atlas-model.js", atlasModelJs], ["css", css], ["html", html], ["fixture", atlasFixtureJs]]) {
    assert.doesNotMatch(source, /the atlas is complete/i, `${name} claims the atlas is complete`);
  }
});

test("C07-5 search binds to q, and nothing is re-sorted or re-filtered in the browser", () => {
  assert.equal(atlasRequestPath({ q: " Dealroom-Worker " }), "/api/v1/atlas-graph?q=Dealroom-Worker");
  assert.equal(atlasRequestPath({ layer: "installed", includeRetired: true, limit: 500 }),
    "/api/v1/atlas-graph?layer=installed&include_retired=true&limit=500");
  // `inferred` is a coverage class: offering it as a layer would send a request
  // the producer refuses with a 403.
  assert.equal(atlasRequestPath({ layer: "inferred" }), "/api/v1/atlas-graph");
  assert.doesNotMatch(atlasJs, /data-layer="inferred"/, "an inferred filter button exists");
  for (const [name, source] of [["js/atlas.js", atlasJs], ["js/atlas-model.js", atlasModelJs]]) {
    // The graph arrives sorted by id and filtered by the server. Re-ordering or
    // re-narrowing the node list in the browser is what this forbids; sorting a
    // key list to compare shapes is not that.
    assert.doesNotMatch(source, /nodes[\s\]]*\.(?:sort|filter|reverse)\(/, `${name} re-sorts or re-filters the producer's list`);
  }
  // The DOM file sorts nothing at all.
  assert.doesNotMatch(atlasJs, /\.sort\(|\.reverse\(/, "the Atlas DOM file re-orders what it was handed");
  assert.match(atlasJs, /view\.q = search\.value; read\(\)/, "search does not cost a fresh read");
  assert.match(atlasJs, /view\.layer = button\.dataset\.layer === "all" \? null : button\.dataset\.layer;\s*\n\s*read\(\);/, "the layer filter does not cost a fresh read");
  const narrowed = atlasBody("?q=demo-worker");
  assert.equal(narrowed.q, "demo-worker", "q is not echoed lower-cased and trimmed");
  assert.ok(narrowed.nodes.length > 0, "the search matched nothing at all");
  for (const node of narrowed.nodes) {
    assert.match(`${node.id} ${node.key} ${node.title}`.toLowerCase(), /demo-worker/, `${node.id} does not match q`);
  }
  assert.equal(atlasBody("?q=%20%20").q, null, "a blank q is not read as no query");
});

test("C07-6 paging is opaque and honest", () => {
  assert.equal(pagingState({ truncated: true, next_cursor: "c", nodes: [1, 2] }).more, true);
  assert.equal(pagingState({ truncated: true, next_cursor: "", nodes: [] }).more, false, "a truncated page with no cursor offers more");
  assert.equal(pagingState({ truncated: true, next_cursor: null, nodes: [] }).more, false);
  assert.equal(pagingState({ truncated: false, next_cursor: "c", nodes: [] }).more, false, "an untruncated page offers more");
  assert.equal(pagingState({ truncated: true, next_cursor: "c", nodes: [1, 2] }).line, "2 shown · more remain");
  assert.equal(pagingState({ truncated: false, next_cursor: null, nodes: [1] }).line, null);
  // Never "N of M": the graph publishes no total, so none is printed.
  for (const source of [atlasJs, atlasModelJs]) {
    assert.doesNotMatch(source, /shown of /, "a total the graph never sent is printed");
    assert.doesNotMatch(source, /atob\(|JSON\.parse\(\s*[a-zA-Z_.]*cursor|cursor\.split\(/, "the cursor is opened");
  }
  const one = atlasBody("?limit=10");
  assert.equal(one.truncated, true);
  assert.equal(one.next_cursor, "demo-atlas-page-2");
  assert.equal(one.nodes.length, 10);
  const two = atlasBody("?limit=10&cursor=demo-atlas-page-2");
  assert.equal(two.truncated, false, "a second click on the last page is possible");
  assert.equal(two.next_cursor, null);
  const merged = mergeNodePages(one.nodes, [...two.nodes, one.nodes[0]]);
  assert.equal(merged.length, one.nodes.length + two.nodes.length, "a re-delivered node is duplicated");
  assert.equal(merged[0].id, one.nodes[0].id, "the first copy lost its position");
  // The two traps the producer sets: limit is CLAMPED above the maximum and
  // REFUSED at zero; a cursor this filter no longer yields is a 403.
  assert.equal(atlasBody("?limit=99999").limit, ATLAS_LIMIT_MAX, "a large limit is not clamped");
  assert.equal(atlasCall("?limit=0").status, 403, "limit=0 is not refused");
  assert.equal(atlasCall("?limit=many").status, 403, "an unparseable limit is not refused");
  assert.equal(atlasCall("?cursor=not-a-cursor").status, 403, "a stale cursor silently restarts");
  assert.equal(atlasCall("?cursor=demo-atlas-page-9").status, 403, "a cursor naming an absent page is not refused");
});

test("C07-7 a retired node keeps its historical identity and no successor is drawn", () => {
  const hidden = atlasBody();
  assert.ok(!hidden.nodes.some((node) => node.id === "service:demo-md-renderer"), "a retired node shows by default");
  assert.equal(hidden.include_retired, false);
  const shown = atlasBody("?include_retired=true");
  const retired = shown.nodes.find((node) => node.id === "service:demo-md-renderer");
  assert.ok(retired, "include_retired=true does not return the retired node");
  assert.equal(retired.status, "retired");
  assert.ok(retired.retired_at !== null, "the retired node carries no retired_at");
  assert.equal(retired.key, "demo-md-renderer", "the historical identity is lost");
  assert.equal(retired.id, "service:demo-md-renderer", "the stable identity is lost");
  assert.equal(NO_SUCCESSOR_SENTENCE, "This release records no successor for a retired node.");
  assert.match(atlasJs, /NO_SUCCESSOR_SENTENCE/, "the page never says there is no successor");
  // The graph has no successor field, so nothing here may invent one.
  for (const [name, source] of [["js/atlas.js", atlasJs], ["js/atlas-model.js", atlasModelJs], ["fixture", atlasFixtureJs]]) {
    assert.doesNotMatch(source, /successor_(?:id|ref|node)|supersededBy/, `${name} invents a successor pointer`);
  }
  assert.equal(atlasCall("?include_retired=maybe").status, 403, "a bad include_retired is not refused");
});

test("C07-8 the unlinked node survives in the full inventory and the page scope is stated", () => {
  const body = atlasBody();
  const surface = body.nodes.find((node) => node.id === "surface:demo-surface");
  assert.ok(surface, "the unlinked node is missing from the inventory");
  assert.equal(surface.unlinked, true, "the unlinked node is not marked unlinked");
  assert.ok(body.index.declared.surface.includes("surface:demo-surface"), "the unlinked node is missing from the index");
  const declared = groupIndex(body).find((group) => group.layer === "declared");
  const surfaces = declared.classes.find((entry) => entry.class === "surface");
  assert.ok(surfaces.nodes.some((node) => node.id === "surface:demo-surface"), "the unlinked node is dropped from its group");
  const selection = selectionFor(body, "surface:demo-surface");
  assert.equal(selection.out.length + selection.in.length, 0);
  assert.equal(PAGE_SCOPE_SENTENCE,
    "Relationships are shown for nodes on this page. A relationship to a node on another page is not drawn here.");
  assert.equal(UNLINKED_SENTENCE, "Nothing on this page points at this node.");
  assert.match(atlasJs, /PAGE_SCOPE_SENTENCE/, "the page-scope sentence is never printed");
  assert.match(atlasJs, /UNLINKED_SENTENCE/, "the unlinked sentence is never printed");
  for (const source of [atlasJs, atlasModelJs]) assert.doesNotMatch(source, /\borphan\b/i, "unlinked is rendered as orphan");
  // Page scoping is real: the retired node's edge exists only when it is on the page.
  assert.ok(!body.edges.some((edge) => edge.to === "service:demo-md-renderer"), "an edge to an off-page node is drawn");
  assert.ok(atlasBody("?include_retired=true").edges.some((edge) => edge.to === "service:demo-md-renderer"));
});

test("C07-13 an observation with no clock and no status is accepted and rendered as absent, never as a blank or a zero", () => {
  // The producer attaches observations from ops.v_rule_enforcement_status with
  // observed_at null and observed_status null (isoOrNull, `?? null`). On
  // 2026-09-18 production returned 128 such rule nodes and the validator refused
  // the whole atlas. The fixture carries one such node so this cannot recur.
  const body = atlasBody();
  const clockless = body.nodes.find((node) => node.id === "rule:22222222-2222-4222-8222-222222222222");
  assert.ok(clockless, "the fixture carries no clockless observed node");
  assert.equal(clockless.observed_at, null);
  assert.equal(clockless.observed_status, null);
  assert.equal(validAtlasPayload(body), true, "a null observed clock or status is refused");
  const stillOwed = atlasExample();
  stillOwed.nodes[0].observed_at = null;
  stillOwed.nodes[0].observed_status = null;
  assert.equal(validAtlasPayload(stillOwed), true, "a null observed clock or status is refused on the producer's example");
  const noRef = atlasExample();
  noRef.nodes[0].observed_source_ref = null;
  assert.equal(validAtlasPayload(noRef), false, "a null observed source ref is accepted");
  const selection = selectionFor(body, clockless.id);
  assert.ok(selection.observed, "the clockless observation did not travel with the node");
  assert.match(atlasJs, /observed_status \?\? NO_OBSERVED_STATUS/, "a null status renders as a blank");
  assert.match(atlasJs, /observed_at \? \(formatClock/, "a null clock is handed to formatClock");
  assert.match(atlasJs, /: NO_OBSERVED_CLOCK/, "a null clock renders as a blank");
  assert.equal(NO_OBSERVED_CLOCK, "no clock recorded for this observation");
  assert.equal(NO_OBSERVED_STATUS, "no status recorded for this observation");
});

test("C07-9 the selection contract is what V5-UX-C08 consumes", () => {
  const body = atlasBody();
  const rule = selectionFor(body, "rule:11111111-1111-4111-8111-111111111111");
  assert.ok(rule, "the rule is not selectable");
  assert.equal(rule.pageScoped, true, "the selection does not carry its page scope");
  assert.ok(rule.out.some((edge) => edge.type === "loaded_in_pack"), "the declared pack edge is missing");
  const enforced = rule.out.filter((edge) => edge.type === "enforced_by").map((edge) => edge.to);
  assert.ok(enforced.includes("control:demo.gate"), "the installed enforcement point is missing");
  assert.ok(enforced.includes("control:demo.uninstalled"), "the declared_only control is missing");
  assert.equal(body.nodes.find((node) => node.id === "control:demo.uninstalled").status, "declared_only",
    "the visible enforcement gap is not visible");
  assert.ok(rule.observed, "the observed trio did not travel with the rule");
  assert.equal(rule.observed.observed_status, "enforced");
  assert.equal(rule.observed.observed_source_ref, "ops.v_rule_enforcement_status");

  const verb = selectionFor(body, "verb:demo-add-loop");
  assert.deepEqual(verb.out.map((edge) => edge.type), ["mutates_through"], "the verb chain does not start at mutates_through");
  const mutation = selectionFor(body, "mutation:demo-add-loop");
  assert.ok(mutation.out.some((edge) => edge.type === "implemented_in"), "the declared chain stops at the mutation");
  assert.equal(verb.observed, null, "a verb carries run evidence the graph cannot give");
  assert.match(VERB_RUN_GAP_SENTENCE, /public\.tool_call verb name/, "the verb gap is not named");
  assert.match(atlasJs, /VERB_RUN_GAP_SENTENCE/, "the verb panel never names the gap");
  assert.match(NO_ENFORCEMENT_SENTENCE, /^No installed enforcement point is recorded/);
  assert.match(NO_TEST_EVIDENCE_SENTENCE, /No test relation is read by any leg/);
  assert.equal(selectionFor(body, "service:nothing-here"), null, "an unknown id selects something");
  // The panel is a pure function of the payload in hand: no second request.
  assert.match(atlasJs, /selectionFor\(view\.payload, view\.selected\)/, "the DOM recomputes the selection");
  assert.equal((atlasJs.match(/await fetch\(/g) || []).length, 1, "the selection panel takes a second request");
  // An unknown edge type is rendered as its own string, never mapped.
  assert.deepEqual(selectionFor(body, "doctrine_section:demo-section").out.map((edge) => edge.type), ["citation"]);
  assert.match(atlasJs, /escapeHtml\(edge\.type\)/, "an edge type is not rendered verbatim");
});

test("C07-10 every atlas refusal is its own state, and the two 404 causes read identically", () => {
  for (const [status, state] of [[401, "no_access"], [403, "no_access"], [404, "not_here"],
    [409, "freshness_unknown"], [500, "offline"], [503, "unavailable"], [0, "offline"]]) {
    assert.equal(classifyAtlasFailure(status), state, `${status} is not ${state}`);
    assert.ok(ATLAS_STATE_COPY[state], `${state} has no copy`);
  }
  assert.equal(ATLAS_STATE_COPY.no_access.title, "This session cannot read the atlas. Nothing here has been inferred.");
  assert.equal(ATLAS_STATE_COPY.not_here.title, "The atlas read is not available on this host.");
  assert.equal(ATLAS_STATE_COPY.freshness_unknown.title, "CARR could not establish the freshness of this atlas, so nothing is shown as current.");
  assert.equal(ATLAS_STATE_COPY.unavailable.title, "A source CARR depends on is unavailable right now, so no partial atlas is presented as whole.");
  assert.equal(ATLAS_STATE_COPY.offline.title, "The atlas read failed. Nothing here has been inferred.");
  // The two 404 causes, side by side. They are different errors on the wire and
  // deliberately INDISTINGUISHABLE on the page, which must not guess which.
  const flagOff = atlasCall("?outage=atlas-flag");
  const tenantRefused = atlasCall("?outage=atlas-tenant");
  assert.equal(flagOff.status, 404);
  assert.equal(tenantRefused.status, 404);
  assert.notEqual(flagOff.body.error, tenantRefused.body.error, "the fixture collapses the producer's two errors");
  assert.deepEqual(ATLAS_STATE_COPY[classifyAtlasFailure(flagOff.status)], ATLAS_STATE_COPY[classifyAtlasFailure(tenantRefused.status)],
    "the two 404 causes produce different copy");
  assert.equal(atlasCall("?outage=atlas-freshness").status, 409);
  assert.equal(atlasCall("?outage=atlas").status, 503);
  assert.equal(atlasCall("?outage=all").status, 503);
  assert.equal(atlasCall("?outage=atlas-internal").status, 500);
  assert.equal(atlasCall("?layer=inferred").status, 403, "layer=inferred is not refused");
  assert.equal(atlasCall("?viewer=joe").status, 403, "a stray parameter is not refused");
  // A refused or failed read CLEARS the list rather than leaving a stale page.
  assert.match(atlasJs, /view\.status = classifyAtlasFailure\(response\.status\);\s*\n\s*view\.payload = null;/,
    "a refused read leaves the previous page on screen");
  assert.match(atlasJs, /if \(!validAtlasPayload\(incoming\)\)[\s\S]{0,240}view\.payload = null;/,
    "a payload the validator refuses is painted anyway");
  // Not reachable from the page, asserted so the fixture cannot drift.
  const method = atlasCall("", "POST");
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET, HEAD, OPTIONS");
  assert.equal(atlasCall("", "OPTIONS").status, 204);
});

test("C07-11 the Atlas tab keeps the shell, the register and 360px", () => {
  assert.match(html, /<section class="tabpanel" id="panelAtlas"[\s\S]*?id="atlasIndex"/, "the Atlas panel holds no index");
  assert.match(html, /role="tab"[^>]*>Atlas</, "the Atlas tab is gone");
  assert.equal([...html.matchAll(/class="doc-chat glass" id="docChat"/g)].length, 1, "a second Doc control appeared");
  assert.doesNotMatch(html, /atlas\.css/, "the atlas added its own stylesheet");
  assert.equal([...html.matchAll(/rel="stylesheet"/g)].length, 3, "the atlas added a stylesheet link");
  // Mobile first at 360px: no fixed pixel width of three digits or more.
  assert.equal(/[^-]width:\s*\d{3,}px/.test(css), false, "a fixed pixel width was added");
  // Every control this slice adds sits at or above the 44px touch floor.
  for (const rule of [/\.atlas-filters \.btn \{ min-height: var\(--touch\); \}/, /#atlasSearch \{ min-height: var\(--touch\); \}/,
    /#atlasMore, #atlasRetry \{ min-height: var\(--touch\); \}/, /summary \{ min-height: var\(--touch\)/]) {
    assert.match(css, rule, "an atlas control sits below the touch floor");
  }
  assert.doesNotMatch(css.split("V5-UX-C07 Atlas tab")[1] || "", /#[0-9a-fA-F]{3}\b/, "the atlas rules name a literal colour");
  assert.match(atlasJs, /formatClock/, "an atlas clock does not come from the shared formatter");
  assert.doesNotMatch(atlasJs, /new Date\(\)/, "the atlas keeps a clock of its own");
  assert.doesNotMatch(atlasJs, /scrollIntoView/, "the atlas autoscrolls");
  // escapeHtml is imported, not copied for the Nth time (B07 advisory A2).
  assert.match(atlasJs, /import \{ escapeHtml \} from "\.\/control-room\.js"/, "escapeHtml is not imported");
  assert.doesNotMatch(atlasJs, /const escapeHtml =/, "escapeHtml was copied again");
  assert.match(pageJs, /export const escapeHtml/, "the one escaper is not exported");
  // No new route: the deep link is a query on the path that already exists.
  assert.equal(routes.routes["/control-room"], "control-room.html");
  assert.equal(routes.version, "1.10.0", "the route contract moved for a slice that adds no route");
  assert.doesNotMatch(JSON.stringify(routes), /control-room\/atlas/, "a new top-level path was added");
  assert.match(pageJs, /parameters\.get\("tab"\) === "atlas"/, "the deep link is not read on boot");
  assert.match(atlasJs, /history\.pushState/, "selection does not push a deep link");
  // The read is lazy: it fires on first selection of the tab, not on boot.
  assert.match(pageJs, /event\.target\.closest\("#tabAtlas"\)/, "the atlas read is not bound to the tab");
  assert.doesNotMatch(pageJs, /take\("atlas"/, "the atlas joined the dashboard's boot reads");
  assert.ok(contract.http_surfaces.includes("/api/v1/atlas-graph"), "the atlas path is not pinned");
  assert.match(checkJs, /the atlas path must stay pinned in the CARR interface/, "the repository check does not pin it");
  // Nothing on this surface writes.
  for (const write of ["addLoop", "patchDealField", "closeIncident", "adjudicate"]) {
    assert.ok(!atlasJs.includes(write), `the Atlas tab must not ${write}`);
  }
  assert.doesNotMatch(atlasJs, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/, "the Atlas tab writes");
  assert.ok(EXPOSURE_STATEMENT.startsWith("This page lists what this system declares it has"), "the exposure statement was reworded");
  assert.match(EXPOSURE_STATEMENT, /nothing here is cached offline\.$/);
  assert.match(atlasJs, /EXPOSURE_STATEMENT/, "the exposure statement is never shown");
});

test("C07-12 the atlas scope block moved on to the renderer slices", () => {
  const ids = notInReleaseBlocks().map((block) => block.id);
  assert.ok(!ids.includes("atlas"), "the Atlas tab still declares itself out of this release");
  assert.ok(ids.includes("atlas_renderer"), "the renderer has no scope statement");
  const renderer = notInReleaseBlocks().find((block) => block.id === "atlas_renderer");
  assert.equal(renderer.title, "Atlas renderer: not in this release");
  assert.equal(renderer.slice, "V5-UX-C08 and V5-UX-C09");
  assert.match(renderer.slice, /^V5-UX-C[0-9]/, "the block names no owning slice");
  assert.match(renderer.reason, /the searchable index is on the Atlas tab now/);
  // The hard-coded panel copy went with the block it sat in.
  assert.doesNotMatch(html, /The atlas renderer is a later phase, in V5-UX-C07 through V5-UX-C09\./);
  assert.doesNotMatch(html, /Atlas: not in this release/);
});
