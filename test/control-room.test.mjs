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
  incidentFilters, notInReleaseBlocks, readPhase, sinceChangeLabel, stallCandidates,
  validCurrentWorkItemPayload, validCurrentWorkRequestsPayload, validIncidentBoardPayload,
  workInProgressLine,
} from "../js/control-room-model.js";
import { acceptsResponse } from "../js/workspace-command-center-model.js";
import { createFixtureClient } from "../js/fixture-client.js";

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
  // Stuck is unknown by ruling, not by outage, and Changed has no producer.
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
  // An operational incident has no page in this application, so no link is invented.
  assert.equal(canonicalHref(INCIDENTS.incidents[0]), null);
  assert.equal(canonicalHref(WORK.current[0]), "/system-work.html");
  assert.equal(canonicalHref({ human_ref: "not a ref" }), null);
});

test("every prototype panel without a producer is a named scope statement", () => {
  const blocks = notInReleaseBlocks();
  const ids = blocks.map((block) => block.id);
  for (const id of ["changed", "accomplishments", "detected_and_repaired", "resources", "model_room", "atlas"]) {
    assert.ok(ids.includes(id), `${id} has no scope statement`);
  }
  for (const block of blocks) {
    assert.match(block.title, /not in this release$/);
    assert.match(block.slice, /^V5-UX-C[0-9]/, `${block.id} names no owning slice`);
    assert.ok(block.reason.length > 0);
  }
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

/* --------------------------------------------------------------- static page */

test("the route and the three verbs are pinned in the contracts", () => {
  assert.equal(routes.routes["/control-room"], "control-room.html");
  assert.equal(routes.version, "1.6.0");
  assert.equal(contract.version, "1.6.0");
  for (const verb of ["incident-board", "current-work-item", "current-work-requests"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
});

test("the page is the shared shell: one live line, tabs, one Doc, AM/PM, no lede, and 44px targets", () => {
  assert.match(html, /<title>Control Room · DoctorCRE<\/title>/);
  assert.match(html, /<div class="tabs" id="controlRoomTabs" role="tablist"/);
  for (const label of ["Dashboard", "Attention", "Model Room", "Atlas"]) {
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
