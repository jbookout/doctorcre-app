import { hasArtifactPage } from "./artifact-pages-fixture.mjs";
import test from "node:test";
import { JSDOM } from "jsdom";
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
  const routes = (await import("../js/routes.js")).routeContract;
  const carr = JSON.parse(await readFile(`${ROOT}/contracts/carr-interface.v1.json`, "utf8"));
  const serveScript = await readFile(`${ROOT}/scripts/serve.mjs`, "utf8");
  const summary = await readFile(`${ROOT}/SUMMARY.md`, "utf8");

  // Route and contract.
  assert.equal(routes.routes["/all-work"], "work-inventory.html");
  assert.equal(routes.version, "1.21.0", "an additive route is a minor version of the route contract");
  assert.ok(carr.http_surfaces.includes("/api/v1/work-inventory"), "the consumed path belongs in the pinned interface");

  // The page is listed everywhere a page has to be listed.
  assert.equal(await hasArtifactPage("work-inventory.html"), true, "the page ships in the verified artifact");
  assert.match(summary, /work-inventory/);

  // Accessibility floor.
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /id="inventoryLive"[^>]*aria-live="polite"/);
  assert.match(html, /<html lang="en" data-theme="dark"/, "dark is the register's default and light rides the same attribute");
  assert.match(html, /\/css\/system\.css/);
  // One icon button per preference: filled is on, hollow is off, and the only
  // words are the accessible label and the tooltip (2026-09-16 review).
  assert.match(html, /src="\/js\/app-shell\.js"/);
  assert.doesNotMatch(html, /data-pref="motion"/);
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
  assert.match(js, /updatedLabel\(payload\.source\.observed_at\)/, "the census displays its update timestamp");
  assert.match(js, /Partly available/);

  // Both local servers share the same synthetic census implementation.
  assert.match(serveScript, /\/api\/v1\/work-inventory/);
  assert.match(serveScript, /import.*censusResponse.*work-inventory-fixture/);
  const {censusResponse} = await import('../scripts/work-inventory-fixture.mjs');
  const first=censusResponse(new URL('http://fixture.local/api/v1/work-inventory'));
  const second=censusResponse(new URL(`http://fixture.local/api/v1/work-inventory?cursor=${first.next_cursor}`));
  assert.deepEqual(first.kinds,WORK_INVENTORY_KINDS);
  assert.ok([...first.items,...second.items].every(item=>item.title.startsWith('Demo ')));
  for (const status of ['superseded','dormant']) assert.ok(first.items.some(item=>item.status===status));
  assert.ok(first.coverage.some(leg=>leg.state==='unavailable'));
  assert.ok(first.next_cursor); assert.equal(second.next_cursor,null);
});

test("an item's open link must stay on this app, including the backslash form browsers read as another host", () => {
  for (const open of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)"]) {
    assert.equal(validWorkInventoryPayload(census({ items: [censusItem({ open })] })), false, open);
  }
  for (const open of ["/system-work.html", "/incidents?ref=INC-1", null]) {
    assert.equal(validWorkInventoryPayload(census({ items: [censusItem({ open })] })), true, String(open));
  }
});

const kinds = ['work_request', 'portfolio_node', 'loop', 'work_shape', 'slice_plan', 'governance_item'];
const ref = 'WR-000904';
const relatedRef = 'PF-DEMO-D';
const item = (overrides = {}) => ({ kind: 'work_request', id: ref, version: '37',
  title: 'Demo captured request', status: 'captured', source_ref: 'ops.work_request',
  updated_at: '2026-09-01T18:05:00Z', related: [{ kind: 'portfolio_node', id: relatedRef }],
  unlinked: false, open: '/system-work.html', ...overrides });
const batchDCensus = {
  viewer: 'joe', tenant: 'carr-internal', kinds, statuses: null, limit: 100, next_cursor: null,
  items: [item(), item({ kind: 'loop', id: '573', title: null, status: 'needs_joe',
    source_ref: 'public.loop_item', related: [], unlinked: true, open: null })],
  coverage: kinds.map(kind => ({ kind, source_ref: kind, state: 'complete',
    count_returned: ['work_request', 'loop'].includes(kind) ? 1 : 0,
    count_total: ['work_request', 'loop'].includes(kind) ? 1 : 0,
    reason: null, excluded_other_tenant: 0, page_capped: false })),
  census_complete: true,
  source: { source: 'work_inventory_census', source_ref: 'synthetic-census',
    observed_at: '2026-09-01T18:05:00Z', valid_until: '2026-09-01T18:06:00Z',
    freshness: 'fresh', correlation_id: 'batch-d-test', safe_explanation: 'Synthetic census.' },
};

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

// Read screen copy, including hover/accessibility labels, without counting
// diagnostics in closed Details disclosures or closed dialogs as visible.
function screenCopy(document) {
  return [...document.querySelectorAll('body *')].filter(element =>
    !element.closest('[hidden], dialog:not([open]), details:not([open])') &&
    !['SCRIPT', 'STYLE'].includes(element.tagName)).flatMap(element => [
    ...[...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent),
    element.getAttribute('title') || '', element.getAttribute('aria-label') || '',
  ]).join(' ');
}

test('V1 batch D All Work controls and broker copy', async t => {
  const dom = new JSDOM(await readFile(new URL('../work-inventory.html', import.meta.url), 'utf8'),
    { url: 'https://app.doctorcre.com/all-work' });
  const { window } = dom;
  const { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let mode = 'ok';
  let cardReads = 0;
  let releaseHeldCard;
  let releaseEvidence;
  let declineMode = 'ok';
  const calls = [];
  const fetch = async (path, options = {}) => {
    if (path.startsWith('/api/v1/work-inventory')) return Response.json(batchDCensus);
    assert.equal(path, '/mcp', 'all reads stay on the existing app transport');
    const rpc = JSON.parse(options.body);
    const { name, arguments: args } = rpc.params;
    calls.push({ name, args });
    let payload;
    if (name === 'notification-feed') payload = { ok: true, items: [], unread_count: 0 };
    else if (name === 'work-request-card') {
      cardReads++;
      assert.deepEqual(args, { work_request: ref });
      const version = mode === 'hold' ? 1 : 37;
      if (mode === 'hold') await new Promise(resolve => { releaseHeldCard = resolve; });
      if (mode === 'error') throw new TypeError('Synthetic read unavailable');
      payload = mode === 'malformed' ? { ok: true } : { ok: true,
        human_ref: mode === 'wrong-record' ? 'WR-000999' : ref,
        title: 'Demo captured request', state: 'captured', version,
        request: { description: 'Demo record detail returned by the existing card read.' } };
    } else if (name === 'engineering-passport') {
      await new Promise(resolve => { releaseEvidence = resolve; });
      throw new TypeError('Synthetic passport unavailable');
    } else if (name === 'decline-work-request') {
      if (declineMode === 'lost') throw new TypeError('Synthetic response lost');
      assert.equal(args.human_ref, ref);
      assert.equal(args.base_version, 37);
      assert.equal(args.exit_reason, 'Demo duplicate capture');
      payload = { ok: true, human_ref: ref, state: 'declined', version: 38 };
    } else assert.fail(`Unexpected operation: ${name}`);
    return Response.json({ jsonrpc: '2.0', id: rpc.id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  };
  const globals = { window, document, location: window.location, localStorage: window.localStorage,
    navigator: window.navigator, HTMLElement: window.HTMLElement, fetch };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  await import('../js/work-inventory.js');
  await until(() => document.querySelector('[data-open-card]'), 'census must paint');
  const detailsButton = () => document.querySelector('#dispositionRows [data-open-card]');

  await t.test('17: normal copy uses names and readable labels; diagnostics stay in Details', () => {
    const copy = screenCopy(document);
    for (const diagnostic of [ref, relatedRef, '573', 'version', '/api/v1/', 'needs_joe', 'work_request', 'portfolio_node'])
      assert.ok(!copy.includes(diagnostic), `normal copy must not expose ${diagnostic}`);
    assert.match(copy, /Demo captured request/);
    assert.match(copy, /Captured/);
    assert.match(copy, /Needs Joe/);
    assert.match(copy, /Untitled/);
    assert.match(copy, /Available/);
    assert.match(copy, /\d+:\d{2}\s*(?:AM|PM)/);
    assert.equal(cardReads, 0, 'details remain lazy');
    const request = document.querySelector('#requestPath');
    assert.equal(request.closest('details')?.open, false);
    request.closest('details').open = true;
    assert.match(screenCopy(document), /\/api\/v1\/work-inventory/);
    request.closest('details').open = false;
  });

  await t.test('07: Open details opens a named popup with record detail and available actions', async () => {
    const before = cardReads;
    detailsButton().click();
    await until(() => document.querySelector('#evidenceDialog')?.open, 'Open details must open a popup');
    await until(() => document.querySelector('#evidenceDialog [data-action="decline"]'), 'details must offer supported actions');
    assert.equal(cardReads, before + 1);
    assert.equal(document.querySelector('#evidenceTitle').textContent, 'Demo captured request');
    const content = document.querySelector('#evidenceRows').textContent;
    for (const diagnostic of [ref, relatedRef, '37', 'captured']) assert.ok(content.includes(diagnostic));
    assert.match(content, /Demo record detail returned by the existing card read/);
    document.querySelector('#evidenceDialog [data-action="decline"]').click();
    assert.equal(document.querySelector('#evidenceDialog').open, false, 'action closes Details before opening the form');
    assert.equal(document.querySelector('#dispositionDialog').open, true);
    document.querySelector('#dispositionCancel').click();
    assert.ok(detailsButton(), 'Details remains available after a card is cached');
  });

  await t.test('failed or mismatched card reads clear cached actions and expose a working retry', async () => {
    for (const failure of ['error', 'malformed', 'wrong-record']) {
      mode = failure;
      assert.ok(detailsButton(), 'Open details remains available');
      detailsButton().click();
      await until(() => document.querySelector('#evidenceDialog')?.open &&
        /Details unavailable/.test(document.querySelector('#evidenceRows').textContent), `${failure} must paint unavailable`);
      assert.equal(document.querySelector('#evidenceDialog [data-action]'), null);
      assert.equal(document.querySelector('#dispositionRows [data-action]'), null);
      const retry = document.querySelector('#evidenceRetry');
      assert.equal(retry.hidden, false);
      const before = cardReads;
      mode = 'ok';
      retry.click();
      await until(() => document.querySelector('#evidenceDialog [data-action="decline"]'), 'retry must load details');
      assert.equal(cardReads, before + 1);
      document.querySelector('#evidenceClose').click();
    }
  });

  await t.test('closing and reopening Details ignores a late response from the previous read', async () => {
    mode = 'hold';
    assert.ok(detailsButton(), 'Open details remains available');
    detailsButton().click();
    await until(() => releaseHeldCard, 'first read must be held');
    document.querySelector('#evidenceClose').click();
    assert.equal(document.querySelector('#evidenceDialog').open, false);
    mode = 'ok';
    detailsButton().click();
    await until(() => document.querySelector('#evidenceDialog [data-action="decline"]'), 'new read must populate Details');
    releaseHeldCard();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(document.querySelector('#evidenceDialog').open, true);
    assert.match(document.querySelector('#evidenceRows').textContent, /37/);
    document.querySelector('#evidenceClose').click();
    const filter = document.querySelector('#statusFilter');
    filter.value = 'needs joe';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(document.querySelector('#kindGroups').textContent, /Untitled/);
    assert.doesNotMatch(document.querySelector('#kindGroups').textContent, /Demo captured request/);
    filter.value = '';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

  await t.test('17: records without a card operation still open census Details without inventing a read', async () => {
    document.querySelector('#evidenceClose').click();
    const before = cardReads;
    const button = document.querySelector('#kindGroups [data-details-kind="loop"]');
    assert.ok(button, 'every census record has Details');
    button.click();
    assert.equal(document.querySelector('#evidenceDialog').open, true);
    assert.match(document.querySelector('#evidenceTitle').textContent, /Untitled/);
    assert.match(document.querySelector('#evidenceRows').textContent, /573/);
    assert.match(document.querySelector('#evidenceRows').textContent, /needs_joe/);
    assert.equal(cardReads, before);
    const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json', import.meta.url), 'utf8'));
    assert.ok(calls.every(call => contract.mcp_operations.includes(call.name)));
    assert.ok(calls.every(call => ['notification-feed', 'work-request-card'].includes(call.name)));
  });

  await t.test('a late evidence read never replaces another record\'s Details', async () => {
    document.querySelector('#evidenceClose').click();
    document.querySelector('[data-evidence]').click();
    await until(() => releaseEvidence, 'evidence read must be held');
    document.querySelector('#kindGroups [data-details-kind="loop"]').click();
    assert.match(document.querySelector('#evidenceTitle').textContent, /Untitled/);
    releaseEvidence();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(document.querySelector('#evidenceDialog').open, true);
    assert.match(document.querySelector('#evidenceTitle').textContent, /Untitled/);
    assert.equal(document.querySelector('#evidenceEyebrow').textContent, 'Details');
    assert.match(document.querySelector('#evidenceRows').textContent, /573/);
    document.querySelector('#evidenceClose').click();
  });

  await t.test('17: command feedback keeps operation and safety identifiers in Command details', async () => {
    document.querySelector('#evidenceClose').click();
    assert.ok(detailsButton(), 'Open details remains available');
    detailsButton().click();
    await until(() => document.querySelector('#evidenceDialog [data-action="decline"]'), 'Details must offer decline');
    document.querySelector('#evidenceDialog [data-action="decline"]').click();
    document.querySelector('#dispositionReason').value = 'Demo duplicate capture';
    document.querySelector('#dispositionForm').requestSubmit();
    await until(() => document.querySelector('#receiptDock [data-state="confirmed"]') &&
      !document.querySelector('#dispositionDialog').open, 'supported write must be confirmed');
    const copy = screenCopy(document);
    assert.doesNotMatch(copy, /WR-000904|decline:WR|safety key|operation decline|[a-f0-9]{8}-[a-f0-9-]{27,}/);
    assert.match(document.querySelector('#commandStatus').textContent, /Demo captured request.*Changes saved/);
    assert.equal(document.querySelector('#receiptDock').closest('details')?.open, false);
    assert.equal(calls.filter(call => call.name === 'decline-work-request').length, 1);
  });

  await t.test('a lost command response is announced as uncertain, never as unsaved', async () => {
    declineMode = 'lost';
    assert.ok(detailsButton(), 'Open details remains available');
    detailsButton().click();
    await until(() => document.querySelector('#evidenceDialog [data-action="decline"]'), 'Details must offer decline');
    document.querySelector('#evidenceDialog [data-action="decline"]').click();
    document.querySelector('#dispositionReason').value = 'Demo duplicate capture';
    document.querySelector('#dispositionForm').requestSubmit();
    await until(() => /Outcome unavailable/.test(document.querySelector('#commandStatus').textContent), 'lost response must stay unknown');
    const announced = document.querySelector('#inventoryLive').textContent;
    assert.match(announced, /Outcome unavailable/);
    assert.doesNotMatch(announced, /not saved/);
  });
});
