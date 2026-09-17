import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_ORB, WORK_INVENTORY_KINDS, buildInventoryQuery, coverageOrbState, coverageSummary,
  filterItemsByStatusText, groupItemsByKind, inventoryRequestPath, itemKey, listPhase,
  mergeInventoryPages, validWorkInventoryPayload,
} from "../js/work-inventory-model.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** What a reader can actually see. A comment is not a claim the page makes. */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/.*$/gm, "$1");

const SOURCE_REFS = {
  work_request: "ops.work_request",
  portfolio_node: "ops.portfolio_node",
  loop: "public.loop_item",
  work_shape: "ops.work_shape_revision",
  slice_plan: "ops.engineering_slice_plan",
  governance_item: "ops.rule_admission",
};

/**
 * The producer's own shape, transcribed from
 * mcp-server/src/work-inventory-census.v5.js. If the producer changes, this
 * fixture is the thing that has to change with it.
 */
function censusItem(overrides = {}) {
  const item = {
    kind: "work_request", id: "WR-000060", version: "3", title: "Demo bounded request",
    status: "queued", source_ref: "ops.work_request", updated_at: "2026-09-15T18:00:00.000Z",
    related: [{ kind: "work_request", id: "WR-000048" }], open: "/system-work.html", ...overrides,
  };
  // unlinked is derived, never passed, so a fixture cannot disagree with itself
  // by accident — the one test that needs the disagreement builds it in place.
  return { ...item, unlinked: item.related.length === 0 };
}

function coverageRow(kind, overrides = {}) {
  return {
    kind, source_ref: SOURCE_REFS[kind], state: "complete", count_returned: 0,
    count_total: 4, reason: null, excluded_other_tenant: 0, page_capped: false, ...overrides,
  };
}

function census(overrides = {}) {
  const items = overrides.items ?? [censusItem()];
  const coverage = overrides.coverage ?? WORK_INVENTORY_KINDS.map((kind) => coverageRow(kind, {
    count_returned: items.filter((item) => item.kind === kind).length,
  }));
  const complete = coverage.every((entry) => entry.state === "complete");
  return {
    viewer: "joe", tenant: "carr-internal", kinds: [...WORK_INVENTORY_KINDS], statuses: null,
    limit: 100, next_cursor: null,
    ...overrides,
    items, coverage, census_complete: complete,
    source: overrides.source ?? {
      source: "work_inventory_census",
      source_ref: Object.values(SOURCE_REFS).join("+"),
      observed_at: "2026-09-16T14:00:00.000Z", valid_until: "2026-09-16T14:01:00.000Z",
      freshness: complete ? "fresh" : "unknown", correlation_id: "corr-c10-1",
      safe_explanation: complete
        ? "Fresh because every source answered a no-store request-time canonical read; valid for 60 seconds."
        : "This census is INCOMPLETE, not empty: governance_item could not be read.",
    },
  };
}

/* ------------------------------------------------------------------ validation */

test("the model accepts the producer's shape and refuses anything it cannot render", () => {
  assert.equal(validWorkInventoryPayload(census()), true);

  // Every status is in scope by default, which is the whole point of the census.
  assert.equal(validWorkInventoryPayload(census({
    items: [
      censusItem({ id: "WR-000061", status: "superseded" }),
      censusItem({ kind: "loop", id: "573", source_ref: "public.loop_item", status: "dormant", version: "2", open: null, related: [{ kind: "loop_domain", id: "engineering" }] }),
      censusItem({ kind: "governance_item", id: "9e3fb6d0", source_ref: "ops.rule_admission", status: "declined", version: "1", open: null, related: [] }),
    ],
  })), true);

  // An UNKNOWN TOP-LEVEL KEY is refused, not ignored: a field this page cannot
  // render must come back declared beside its renderer.
  assert.equal(validWorkInventoryPayload({ ...census(), partner_rank: 1 }), false);
  assert.equal(validWorkInventoryPayload({ ...census(), extra: null }), false);

  // Coverage is not optional, and it is not allowed to be short of the kinds read.
  const missing = census();
  delete missing.coverage;
  assert.equal(validWorkInventoryPayload(missing), false);
  assert.equal(validWorkInventoryPayload(census({ coverage: WORK_INVENTORY_KINDS.slice(0, 5).map((kind) => coverageRow(kind)) })), false);

  // The unavailable row the producer really emits — six keys, no counters.
  const unavailable = census();
  unavailable.coverage = WORK_INVENTORY_KINDS.map((kind) => (kind === "governance_item"
    ? { kind, source_ref: SOURCE_REFS[kind], state: "unavailable", count_returned: 0, count_total: null, reason: "DEPENDENCY_UNAVAILABLE" }
    : coverageRow(kind, { count_returned: kind === "work_request" ? 1 : 0 })));
  unavailable.census_complete = false;
  unavailable.source.freshness = "unknown";
  unavailable.source.safe_explanation = "This census is INCOMPLETE, not empty: governance_item could not be read.";
  assert.equal(validWorkInventoryPayload(unavailable), true);

  // census_complete is a restatement of coverage, never an independent claim.
  assert.equal(validWorkInventoryPayload({ ...unavailable, census_complete: true }), false);
  // A degraded source without a reason reads exactly like a complete one.
  assert.equal(validWorkInventoryPayload(census({ coverage: WORK_INVENTORY_KINDS.map((kind, index) => coverageRow(kind, index === 0 ? { state: "partial", reason: null } : {})) })), false);
  // unlinked must agree with related; a lying chip is worse than no chip.
  assert.equal(validWorkInventoryPayload(census({ items: [{ ...censusItem(), unlinked: true }] })), false);
  // An item shape the page does not render is refused as firmly as a payload one.
  const strayField = { ...censusItem(), rank: 2 };
  assert.equal(validWorkInventoryPayload({ ...census(), items: [strayField] }), false);
  assert.equal(validWorkInventoryPayload(null), false);
});

/* -------------------------------------------------------------------- grouping */

test("items group by kind, and a source that returned nothing still gets its group", () => {
  const items = [
    censusItem({ id: "WR-1" }),
    censusItem({ id: "WR-2", status: "declined" }),
    censusItem({ kind: "loop", id: "250", source_ref: "public.loop_item", open: null, related: [] }),
  ];
  const groups = groupItemsByKind(items);
  assert.deepEqual(groups.map((group) => group.kind), [...WORK_INVENTORY_KINDS]);
  assert.deepEqual(groups.find((group) => group.kind === "work_request").items.map((item) => item.id), ["WR-1", "WR-2"]);
  assert.equal(groups.find((group) => group.kind === "loop").items.length, 1);
  assert.equal(groups.find((group) => group.kind === "slice_plan").items.length, 0);
  // A narrowed read shows only the sources it asked for.
  assert.deepEqual(groupItemsByKind(items, ["loop"]).map((group) => group.kind), ["loop"]);
});

test("the coverage summary keeps counted and returned apart and never claims an uncounted total", () => {
  const coverage = WORK_INVENTORY_KINDS.map((kind) => coverageRow(kind, { count_returned: 2, count_total: 10 }));
  const whole = coverageSummary(coverage);
  assert.equal(whole.returned, 12);
  assert.equal(whole.total, 60);
  assert.equal(whole.worst, "complete");

  const degraded = coverage.map((entry, index) => (index === 0
    ? { ...entry, state: "unavailable", count_total: null, reason: "DEPENDENCY_UNAVAILABLE" }
    : index === 1 ? { ...entry, state: "partial", reason: "count_unavailable", count_total: null } : entry));
  const summary = coverageSummary(degraded);
  assert.equal(summary.total, null, "a census with an uncounted source claims no total");
  assert.deepEqual(summary.unavailable, ["work_request"]);
  assert.deepEqual(summary.partial, ["portfolio_node"]);
  assert.equal(summary.worst, "unavailable");
  assert.equal(coverageSummary([]).worst, "unavailable");
});

/* ------------------------------------------------- the coverage state mapping */

test("coverage state maps to the shared orb states, and an unreadable source is never healthy", () => {
  assert.equal(coverageOrbState("complete"), "healthy");
  assert.equal(coverageOrbState("partial"), "attention");
  assert.equal(coverageOrbState("unavailable"), "urgent");
  assert.equal(coverageOrbState("nonsense"), "unknown");
  // Pinned as a set too, so a mapping cannot be widened without being seen.
  assert.deepEqual(COVERAGE_ORB, { complete: "healthy", partial: "attention", unavailable: "urgent" });
  assert.notEqual(coverageOrbState("unavailable"), "healthy", "a source that could not be read must not paint as healthy");
  assert.notEqual(coverageOrbState("partial"), "healthy", "a partially read source must not paint as healthy");
  // And the census-wide orb follows the worst leg, not the best.
  const degraded = WORK_INVENTORY_KINDS.map((kind, index) => coverageRow(kind, index === 5
    ? { state: "unavailable", count_total: null, reason: "DEPENDENCY_UNAVAILABLE" } : {}));
  assert.equal(coverageOrbState(coverageSummary(degraded).worst), "urgent");
});

/* ----------------------------------------------------------------- query build */

test("the query string says exactly what was asked for, and all six kinds narrow nothing", () => {
  assert.equal(buildInventoryQuery({ kinds: [...WORK_INVENTORY_KINDS] }), "");
  assert.equal(buildInventoryQuery({}), "");
  assert.equal(buildInventoryQuery({ kinds: [] }), "");
  assert.equal(buildInventoryQuery({ kinds: ["loop", "work_request"] }), "?kinds=work_request%2Cloop");
  assert.equal(buildInventoryQuery({ kinds: ["loop", "nope"] }), "?kinds=loop");
  assert.equal(buildInventoryQuery({ statuses: [" dormant ", "queued", "queued"] }), "?statuses=dormant%2Cqueued");
  assert.equal(buildInventoryQuery({ limit: 25 }), "?limit=25");
  assert.equal(buildInventoryQuery({ limit: 9000 }), "?limit=500");
  assert.equal(buildInventoryQuery({ limit: 0 }), "");
  assert.equal(buildInventoryQuery({ cursor: "eyJhIjoxfQ==" }), "?cursor=eyJhIjoxfQ%3D%3D");
  assert.equal(buildInventoryQuery({ cursor: "" }), "");
  assert.equal(inventoryRequestPath({ kinds: ["loop"], limit: 50 }), "/api/v1/work-inventory?kinds=loop&limit=50");
  assert.equal(inventoryRequestPath({}), "/api/v1/work-inventory");
});

/* ------------------------------------------------------------------ page merge */

test("Load more appends without duplicating a row the next page re-delivers", () => {
  const first = [censusItem({ id: "WR-1" }), censusItem({ id: "WR-2" })];
  const second = [censusItem({ id: "WR-2", status: "closed" }), censusItem({ id: "WR-3" }), censusItem({ kind: "loop", id: "WR-3", source_ref: "public.loop_item", open: null, related: [] })];
  const merged = mergeInventoryPages(first, second);
  assert.deepEqual(merged.map(itemKey), ["work_request:WR-1", "work_request:WR-2", "work_request:WR-3", "loop:WR-3"]);
  // The first copy wins, so an already-read row does not change under the reader.
  assert.equal(merged[1].status, "queued");
  // Same id under a different kind is a different record and both survive.
  assert.equal(merged.length, 4);
  assert.deepEqual(mergeInventoryPages(merged, merged).map(itemKey), merged.map(itemKey));
  assert.deepEqual(mergeInventoryPages(null, null), []);
});

test("the status text filter narrows what is read without hiding a status by default", () => {
  const items = [censusItem({ id: "A", status: "queued" }), censusItem({ id: "B", status: "superseded" }), censusItem({ id: "C", status: null })];
  assert.equal(filterItemsByStatusText(items, "").length, 3, "an empty filter shows every status, including hidden ones");
  assert.equal(filterItemsByStatusText(items, "   ").length, 3);
  assert.deepEqual(filterItemsByStatusText(items, "SUPER").map((item) => item.id), ["B"]);
  assert.deepEqual(filterItemsByStatusText(items, "zzz"), []);
});

test("an empty incomplete census is its own state and never the empty one", () => {
  const complete = census({ items: [] });
  assert.equal(listPhase({ status: "ready", payload: complete, visible: 0 }), "empty");
  const incomplete = census({ items: [] });
  incomplete.coverage[5] = { kind: "governance_item", source_ref: SOURCE_REFS.governance_item, state: "unavailable", count_returned: 0, count_total: null, reason: "DEPENDENCY_UNAVAILABLE" };
  incomplete.census_complete = false;
  assert.equal(listPhase({ status: "ready", payload: incomplete, visible: 0 }), "partial");
  assert.equal(listPhase({ status: "loading", payload: null }), "loading");
  assert.equal(listPhase({ status: "unauthorized", payload: null }), "no_access");
  assert.equal(listPhase({ status: "error", payload: null }), "offline");
  assert.equal(listPhase({ status: "ready", payload: census(), visible: 0 }), "no_match");
  assert.equal(listPhase({ status: "ready", payload: census(), visible: 1 }), "ready");
});

/* -------------------------------------------------------------- page invariants */

test("the Work Inventory page is a first-class, honest, listed surface", async () => {
  const html = await readFile(`${ROOT}/work-inventory.html`, "utf8");
  const js = withoutComments(await readFile(`${ROOT}/js/work-inventory.js`, "utf8"));
  const model = withoutComments(await readFile(`${ROOT}/js/work-inventory-model.js`, "utf8"));
  const routes = JSON.parse(await readFile(`${ROOT}/contracts/app-routes.v1.json`, "utf8"));
  const carr = JSON.parse(await readFile(`${ROOT}/contracts/carr-interface.v1.json`, "utf8"));
  const checkScript = await readFile(`${ROOT}/scripts/check-repository.mjs`, "utf8");
  const artifactScript = await readFile(`${ROOT}/scripts/artifact.mjs`, "utf8");
  const serveScript = await readFile(`${ROOT}/scripts/serve.mjs`, "utf8");
  const summary = await readFile(`${ROOT}/SUMMARY.md`, "utf8");

  // Route and contract.
  assert.equal(routes.routes["/work-inventory"], "work-inventory.html");
  assert.equal(routes.version, "1.3.0", "an additive route is a minor version of the route contract");
  assert.ok(carr.http_surfaces.includes("/api/v1/work-inventory"), "the consumed path belongs in the pinned interface");

  // The page is listed everywhere a page has to be listed.
  assert.match(checkScript, /"work-inventory\.html"/);
  assert.match(artifactScript, /"work-inventory\.html"/);
  assert.match(summary, /work-inventory/);

  // Accessibility floor.
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /id="inventoryLive"[^>]*aria-live="polite"/);
  assert.match(html, /<html lang="en" data-theme="dark"/, "dark is the register's default and light rides the same attribute");
  assert.match(html, /\/css\/system\.css/);
  // One icon button per preference: filled is on, hollow is off, and the only
  // words are the accessible label and the tooltip (2026-09-16 review).
  assert.match(html, /data-pref="theme" data-on="light" data-off="dark"/);
  assert.match(html, /data-pref="motion" data-on="reduced" data-off="full"/);
  assert.doesNotMatch(html, /draggable="true"|ondragstart/, "no drag-only path exists on this surface");
  assert.doesNotMatch(js, /addEventListener\("(?:drag|mouseover)/);
  for (const id of ["kindChips", "statusFilter", "coverageStrip", "kindGroups", "loadMore", "inventoryState"]) {
    assert.ok(html.includes(`id="${id}"`), `the page must carry #${id}`);
  }
  // Every control is a real button or input, so it is keyboard reachable and
  // gets the shared 44px/--touch target rules.
  assert.match(html, /<button class="chip" type="button" data-kind="work_request" aria-pressed="true">/);
  assert.equal((html.match(/data-kind="/g) || []).length, WORK_INVENTORY_KINDS.length, "all six kinds are chips");
  assert.match(html, /<button class="btn btn-primary" type="button" id="loadMore"/);

  // Showing hidden statuses is the DEFAULT, and there is no ranking anywhere.
  assert.match(html, /All statuses shown by default/);
  assert.doesNotMatch(html, /show hidden statuses.{0,40}(?:off|disabled)/i);
  for (const source of [html, js, model]) {
    assert.doesNotMatch(source, /\brank(?:s|ed|ing)?\b/i, "nothing on this surface ranks work or partners");
    assert.doesNotMatch(source, /\bleaderboard\b|\bscore(?:s|d)?\b|\btop\s+\d/i);
    assert.doesNotMatch(source, /\bpriorit(?:y|ise|ize|ised|ized)\b/i);
  }

  // No inline network, and nothing leaves this origin but the pinned font sheet.
  assert.doesNotMatch(html, /<script(?![^>]*src="\/js\/)/, "the page runs only its own module");
  const remote = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(remote.map((url) => new URL(url).host))].sort(), ["fonts.googleapis.com", "fonts.gstatic.com"]);
  assert.doesNotMatch(js, /https?:\/\//, "the census is read same-origin or not at all");
  assert.match(js, /\/api\/v1\/work-inventory|WORK_INVENTORY_ENDPOINT/);

  // The honest-state discipline: typed errors are named, and a failed read drops
  // the payload rather than showing an old page as current.
  for (const code of ["AUTHENTICATION_REQUIRED", "AUTHORIZATION_REFUSED", "DEPENDENCY_UNAVAILABLE", "FRESHNESS_UNKNOWN"]) {
    assert.ok(js.includes(code), `the page must handle ${code}`);
  }
  assert.match(js, /cache: "no-store"/);
  assert.match(js, /view\.payload = null;/);
  assert.match(js, /safe_explanation/, "an incomplete census shows the census's own explanation");
  assert.match(js, /incomplete, not empty/i);

  // The fixture server really serves the census, with all six kinds and a second page.
  assert.match(serveScript, /\/api\/v1\/work-inventory/);
  assert.match(serveScript, /Demo /);
  for (const kind of WORK_INVENTORY_KINDS) assert.ok(serveScript.includes(kind), `the fixture must exercise ${kind}`);
  for (const status of ["superseded", "dormant"]) assert.ok(serveScript.includes(status), `the fixture must exercise ${status}`);
  assert.match(serveScript, /"unavailable"/, "the fixture must exercise an unavailable leg");
  assert.match(serveScript, /next_cursor/);
});
