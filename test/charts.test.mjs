// V5-UX-B06 — Commercial charts and linked drilldown.
//
// One test per clause of the frozen spec, named B06-1 … B06-12. Each asserts
// over the MODEL (js/charts-model.js) rather than only over the page text,
// because a page that paints the right words from the wrong decision is the
// failure this suite exists to catch.
//
// Every test that needs a payload uses the REAL captured `deal-room-board`
// answer (test/fixtures/charts-live-capture.json, 74 deals / 3 accounts), fed
// through the REAL live client adapter over an injected fetch — so the phase
// vocabulary has exactly one owner and the fixture cannot drift from the wire.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createLiveClient } from "../js/live-client.js";
import { PREFERENCES_KEY } from "../js/shell.js";
import { SAVED_VIEWS_KEY } from "../js/search-model.js";
import {
  CHARTS_STATES, CHARTS_STATE_COPY, CHARTS_VIEW_KEY, DIMENSION_IDS, NEVER_REVIEWED, NO_VALUE_KEY,
  accountRows, acceptsBoardResponse, barShare, bucketRows, chartsAddress, chartsPhase,
  classifyBoardFailure, countValue, filterDeals, nextDateCoverage, ownerRows, parseChartsAddress,
  phaseRows, readChartsView, rowTotal, selectionLabel, touchCoverage, validBoardPayload,
  waitingSummary, writeChartsView,
} from "../js/charts-model.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFile(`${ROOT}${file}`, "utf8");

const html = await read("business-workspace.html");
const pageJs = await read("js/charts.js");
const modelJs = await read("js/charts-model.js");
const workspaceJs = await read("js/business-workspace.js");
const css = await read("css/business-workspace.css");
const checkScript = await read("scripts/check-repository.mjs");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));

/** The real capture, unchanged, exactly as the verb answered it. */
const capture = JSON.parse(await read("test/fixtures/charts-live-capture.json"));

/** A live client over the captured payload: one call recorded per read. */
function captureClient(payload = capture, { status = 200, throwStatus = null } = {}) {
  const calls = [];
  const client = createLiveClient({
    fetchImpl: async (path, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path, verb: body.params?.name, arguments: body.params?.arguments });
      if (throwStatus) return new Response("a body no surface may render", { status: throwStatus });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ text: JSON.stringify(payload) }] } }), {
        status, headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls };
}

const board = await (async () => {
  const { client } = captureClient();
  return client.getBoard({ workspace: "all" });
})();

/* ------------------------------------------------------------------------ B06-1 */

test("B06-1 the phase chart's rows sum to the board's own row count, and pending is 31", () => {
  const rows = phaseRows(board.deals);
  assert.equal(board.deals.length, 74, "the capture is the real 74-row board");
  assert.equal(rowTotal(rows), board.deals.length, "the eight columns plus unplaced account for every row");
  assert.equal(rows.find((row) => row.key === "pending").count, 31);
  assert.equal(rows.find((row) => row.key === "research").count, 17);
  assert.equal(rows.find((row) => row.key === "negotiation").count, 9);
  assert.equal(rows.find((row) => row.key === "legal").count, 6);
  assert.equal(rows.find((row) => row.key === "due_diligence").count, 5);
  assert.equal(rows.find((row) => row.key === "closed").count, 4);
  assert.equal(rows.find((row) => row.key === "closing").count, 1);
  assert.equal(rows.find((row) => row.key === "site_selection").count, 1);

  // A phase outside the eight is PRINTED as unplaced, never dropped and never
  // folded into a neighbouring column.
  const withStranger = [...board.deals, { id: "x", phase: "a phase this board does not have" }];
  const strangerRows = phaseRows(withStranger);
  assert.equal(rowTotal(strangerRows), 75);
  assert.equal(strangerRows.at(-1).key, NO_VALUE_KEY);
  assert.equal(strangerRows.at(-1).count, 1);
  assert.equal(strangerRows.at(-1).label, "Not placed on this board");
});

/* ------------------------------------------------------------------------ B06-2 */

test("B06-2 the page never re-ranks: no count ordering anywhere, and the producer's order survives bucketing", () => {
  for (const [name, source] of [["js/charts-model.js", modelJs], ["js/charts.js", pageJs]]) {
    assert.ok(!source.includes(".sort("), `${name} contains no .sort(`);
    assert.ok(!source.includes(".reverse("), `${name} contains no .reverse(`);
  }
  // ONE ordering call exists in the whole slice, it is in ownerRows, and it
  // orders on the NAME. An ordering on a count would be a ranking.
  const ordering = modelJs.match(/\.toSorted\(/g) || [];
  assert.equal(ordering.length, 1, "exactly one ordering call exists in the model");
  assert.equal((pageJs.match(/\.toSorted\(/g) || []).length, 0, "the page orders nothing at all");
  const ownerBody = modelJs.slice(modelJs.indexOf("export function ownerRows("), modelJs.indexOf("/* ------------------------------------------------------------- the drilldown */"));
  assert.match(ownerBody, /\.toSorted\(\(a, b\) => a\.label\.localeCompare\(b\.label\)\)/, "the one ordering is by name");
  assert.doesNotMatch(ownerBody, /count/, "the one ordering never reads a count");

  // The phase order is COLUMNS' order, and the segment order is the producer's
  // order of first appearance — both different from an order by count.
  assert.deepEqual(phaseRows(board.deals).map((row) => row.key),
    ["pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing", "closed"]);
  const segments = bucketRows(board.deals, "segment");
  assert.equal(segments[0].label, "Dermatology", "the first segment is the first one the producer sent, not the largest");
  const byCount = [...segments].map((row) => row.count);
  assert.notDeepEqual(byCount, [...byCount].toSorted((a, b) => b - a), "the rendered order is not a ranking by count");
  const accounts = accountRows(capture.accounts);
  assert.deepEqual(accounts.map((row) => row.name), capture.accounts.map((row) => row.account_name), "the account order is the verb's own");
});

/* ------------------------------------------------------------------------ B06-3 */

test("B06-3 a null dimension is a bucket at the end, never a dropped row", () => {
  const segments = bucketRows(board.deals, "segment");
  assert.equal(rowTotal(segments), 74, "the segment buckets account for every row on the board");
  const missing = segments.at(-1);
  assert.equal(missing.key, NO_VALUE_KEY);
  assert.equal(missing.missing, true);
  assert.equal(missing.label, "Not segmented");
  assert.equal(missing.count, 49, "the 49 unsegmented records are counted, not omitted");
  assert.equal(segments.filter((row) => row.missing).length, 1, "there is exactly one null bucket and it is last");

  // Every other charted dimension obeys the same rule against the same board.
  for (const [field, missingCount] of [["market", 34], ["owner", 32], ["type", 0], ["operating_state", 0], ["phase", 0]]) {
    const rows = field === "phase" ? phaseRows(board.deals) : bucketRows(board.deals, field);
    assert.equal(rowTotal(rows), 74, `${field} buckets sum to the board`);
    assert.equal(rows.filter((row) => row.missing).reduce((total, row) => total + row.count, 0), missingCount, `${field} null count`);
  }
  // A count of zero is never printed as a bucket that does not exist.
  assert.equal(bucketRows(board.deals, "type").some((row) => row.count === 0), false);
});

/* ------------------------------------------------------------------------ B06-4 */

test("B06-4 the account counts arrive as strings and are narrowed to numbers, with unknown rather than zero", () => {
  // The producer's own shape: five bigints, every one of them a STRING.
  for (const key of ["open_deals", "attention_deals", "overdue_deals", "stale_deals", "parked_deals"]) {
    assert.equal(typeof capture.accounts[0][key], "string", `${key} arrives as a string`);
  }
  const rows = accountRows(capture.accounts);
  const musicologie = rows.find((row) => row.name === "Musicologie");
  assert.equal(musicologie.counts.find((count) => count.id === "open_deals").value, 15);
  assert.equal(musicologie.counts.find((count) => count.id === "stale_deals").value, 15);
  assert.equal(typeof musicologie.counts[0].value, "number", "a count is a number by the time it is rendered");

  // "0" is TRUTHY as a string. Narrowed it is a real zero, and it is still known.
  const zero = countValue("0");
  assert.equal(zero.value, 0);
  assert.equal(zero.known, true);
  assert.equal(zero.text, "0");
  assert.equal(Boolean("0"), true, "the trap this narrowing exists to close");
  assert.equal(zero.value > 0, false, "a narrowed zero compares as a zero");

  // A count this page cannot read as a number is unknown, and NEVER a zero.
  const bad = countValue("abc");
  assert.equal(bad.value, null);
  assert.equal(bad.known, false);
  assert.equal(bad.text, "unknown");
  assert.equal(countValue(null).text, "unknown");
  assert.equal(countValue(undefined).text, "unknown");
  // A `count(*)` is a string of digits. Everything Number() would happily
  // narrow but Postgres cannot produce is refused rather than charted.
  for (const notACount of [[], true, false, {}, "0x10", "1e3", "-1", "1.5", " ", "９"]) {
    assert.equal(countValue(notACount).text, "unknown", `${JSON.stringify(notACount)} is not a count`);
  }
  assert.equal(countValue(" 12 ").value, 12, "the producer's own whitespace is tolerated");
  assert.equal(countValue("9007199254740993").text, "unknown", "a count past 2^53 is unknown, never silently rounded");
  const broken = accountRows([{ ...capture.accounts[1], open_deals: "abc" }]);
  assert.equal(broken[0].counts[0].text, "unknown");
  assert.equal(broken[0].counts[3].text, "15", "one unreadable count does not take the readable ones down with it");
});

/* ------------------------------------------------------------------------ B06-5 */

test("B06-5 a missing date is counted as missing and never rendered as a zero or an age", () => {
  const coverage = nextDateCoverage(board.deals);
  assert.equal(coverage.total, 74);
  assert.equal(coverage.withDate, 1);
  assert.equal(coverage.without, 73);
  assert.equal(coverage.sentence, "73 of 74 have no next date on file");
  // No day count, no year, no clock: the card counts records, not time.
  assert.doesNotMatch(coverage.sentence, /\bdays?\b|1970|\d{4}-\d{2}-\d{2}/);

  // `last_touch` null is UNKNOWN, not stale: the board did not say the record
  // went quiet, it said it does not know when it was last touched.
  const touch = touchCoverage(board.deals);
  assert.equal(touch.unknown, 60);
  assert.match(touch.sentence, /unknown rather than stale/);
  assert.doesNotMatch(touch.sentence, /1970/);

  // Nothing in the slice ever falls a date back to zero or to now.
  for (const [name, source] of [["js/charts-model.js", modelJs], ["js/charts.js", pageJs]]) {
    assert.ok(!/new Date\(/.test(source.replace("function clockNow(now = new Date())", "")), `${name} parses no date into an age`);
    assert.ok(!source.includes("Date.now()"), `${name} measures no record against the clock`);
  }
  // The attention flag is false on all 74, and is stated as 0 OF 74.
  assert.equal(waitingSummary(board.deals).attentionLine, "0 of 74 flagged for attention");
});

/* ------------------------------------------------------------------------ B06-6 */

test("B06-6 a null last_review_at renders never reviewed here, on all three accounts", () => {
  assert.equal(capture.accounts.filter((account) => account.last_review_at === null).length, 3);
  const rows = accountRows(capture.accounts);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.review, NEVER_REVIEWED);
  assert.equal(NEVER_REVIEWED, "never reviewed here");
  // It is never a clock, never a zero, and never borrowed from a deal's own
  // last_touch — a different field on a different record.
  for (const row of rows) assert.doesNotMatch(row.review, /\b0\b|days|last touch/i);
  assert.ok(!modelJs.slice(modelJs.indexOf("export function accountRows(")).slice(0, 900).includes("last_touch"),
    "the account review clock never falls back to a deal's last touch");
  // A real review time passes through as the producer wrote it.
  assert.equal(accountRows([{ ...capture.accounts[0], last_review_at: "2026-09-01T12:00:00Z" }])[0].review, "2026-09-01T12:00:00Z");
});

/* ------------------------------------------------------------------------ B06-7 */

test("B06-7 empty, no-match, refused and unavailable are four renderings, and only one offers Retry", async () => {
  // An answered board with no deals is an ANSWER, not an outage.
  assert.equal(chartsPhase({ status: "ready", payload: { deals: [], accounts: [] } }), "empty");
  assert.equal(CHARTS_STATE_COPY.empty.title, "The board answered and holds no open deals");
  assert.equal(CHARTS_STATE_COPY.empty.retry, false, "there is nothing to retry about an answer");

  // 403 is a DECISION taken before the verb ran: named, and no Retry.
  const refused = await captureClient(capture, { throwStatus: 403 }).client.getBoard().catch((error) => error);
  assert.equal(refused.status, 403);
  assert.equal(classifyBoardFailure(refused), "refused");
  assert.equal(CHARTS_STATE_COPY.refused.retry, false);
  assert.equal(CHARTS_STATE_COPY.refused.title, "The record layer refused this read for your session.");
  assert.equal(classifyBoardFailure({ status: 401 }), "refused");

  // 5xx and a network throw are a path that did not answer: Retry is offered.
  const down = await captureClient(capture, { throwStatus: 503 }).client.getBoard().catch((error) => error);
  assert.equal(classifyBoardFailure(down), "unavailable");
  assert.equal(classifyBoardFailure(new Error("network")), "unavailable");
  assert.equal(CHARTS_STATE_COPY.unavailable.retry, true);
  assert.match(CHARTS_STATE_COPY.unavailable.title, /Nothing here has been inferred/);

  // A payload whose shape this page cannot read paints nothing from it, and it
  // is never parked on a loading that cannot end (advisory A3).
  assert.equal(chartsPhase({ status: "unreadable", payload: null }), "unreadable");
  assert.equal(chartsPhase({ status: "ready", payload: { deals: [], accounts: {} } }), "unreadable");
  // The word `unknown` belongs to a CELL, not to the page (advisory A1).
  assert.equal(CHARTS_STATE_COPY.unknown, undefined);
  assert.equal(CHARTS_STATES.includes("unknown"), false);
  assert.equal(countValue("abc").text, "unknown", "the cell keeps the word the spec gave it");
  // §4's own wording: a NON-OBJECT payload is the unanswered path (advisory A2).
  assert.match(pageJs, /view\.status = payload === null \|\| typeof payload !== "object" \? "unavailable" : "unreadable";/);
  assert.equal(chartsPhase({ status: "ready", payload: { deals: board.deals, accounts: [] } }), "partial");
  assert.equal(chartsPhase({ status: "ready", payload: board }), "ready");
  for (const state of CHARTS_STATES) assert.ok(CHARTS_STATE_COPY[state], `${state} carries its own rendered text`);
  assert.equal(new Set(CHARTS_STATES.map((state) => CHARTS_STATE_COPY[state].title)).size, CHARTS_STATES.length - 1,
    "loading and stale deliberately share one heading; every other state has its own");

  // No refusal body ever reaches a rendered string.
  assert.equal(refused.body, "a body no surface may render");
  assert.ok(!pageJs.includes(".body"), "the page never reads an error body");

  // The empty and unavailable branches draw no chart at all: a chart of zeros
  // would be a claim the read did not make.
  const renderBody = pageJs.slice(pageJs.indexOf("function render()"), pageJs.indexOf("export async function read("));
  assert.match(renderBody, /phase === "empty" \|\| phase === "refused" \|\| phase === "unavailable" \|\| phase === "unreadable"\) \{\s*\n\s*\/\/[^\n]*\n\s*canvas\.innerHTML = "";/);
});

/* ------------------------------------------------------------------------ B06-8 */

test("B06-8 an older answer that overtakes a newer one renders nothing", () => {
  assert.equal(acceptsBoardResponse(2, 2), true);
  assert.equal(acceptsBoardResponse(2, 1), false, "the older read's token is refused once a newer read has started");
  assert.equal(acceptsBoardResponse(1, 2), false);
  // The guard runs on BOTH legs — the thrown path and the resolved path — so a
  // late failure cannot blank a good newer answer either.
  const readBody = pageJs.slice(pageJs.indexOf("export async function read("), pageJs.indexOf("function pushAddress()"));
  assert.equal((readBody.match(/if \(!acceptsBoardResponse\(view\.sequence, sequence\)\) return;/g) || []).length, 2);
  assert.match(readBody, /const sequence = \+\+view\.sequence;/);
  assert.equal(CHARTS_STATE_COPY.stale.copy, "An older answer arrived after a newer one and was dropped.");
});

/* ------------------------------------------------------------------------ B06-9 */

test("B06-9 Back restores the selection from the address, and a filtered total is a subset of the one it came from", () => {
  const address = chartsAddress({ group: "segment", pick: "Dental" });
  assert.equal(address, "/business?charts=1&group=segment&pick=Dental");
  const restored = parseChartsAddress(address.slice(address.indexOf("?")));
  assert.equal(restored.present, true);
  assert.equal(restored.group, "segment");
  assert.equal(restored.pick, "Dental");
  // Byte-equal: the address a restored selection produces is the one it came from.
  assert.equal(chartsAddress(restored), address);
  assert.equal(chartsAddress({}), "/business?charts=1");
  // A dimension this page does not group is dropped rather than carried.
  assert.equal(parseChartsAddress("?charts=1&group=invented&pick=x").group, null);
  assert.equal(parseChartsAddress("?q=Dell").present, false, "the Search tab's address does not open the Charts tab");

  // The filter is taken from the rows already in hand: a subset, always.
  const dental = filterDeals(board.deals, "segment", "Dental");
  assert.equal(dental.length, 7);
  assert.ok(dental.every((deal) => board.deals.includes(deal)), "every filtered row is one of the rows already in hand");
  assert.equal(rowTotal(phaseRows(dental)), dental.length, "the filtered phase chart totals the filtered rows");
  assert.ok(rowTotal(phaseRows(dental)) <= rowTotal(phaseRows(board.deals)));
  assert.equal(filterDeals(board.deals, "segment", NO_VALUE_KEY).length, 49, "the null bucket is drillable too");
  assert.equal(filterDeals(board.deals, "phase", "pending").length, 31, "a phase drilldown speaks the slug, through the adapter's own map");
  assert.equal(filterDeals(board.deals, null, null).length, 74, "no selection filters nothing");
  assert.equal(selectionLabel("segment", "Dental"), "Segment: Dental");
  assert.equal(selectionLabel("segment", NO_VALUE_KEY), "Segment: Not segmented");
  assert.equal(selectionLabel("phase", "due_diligence"), "Phase: Due diligence");

  // popstate restores and repaints. It reads nothing.
  assert.match(pageJs, /addEventListener\?\.\("popstate", \(\) => restoreFromAddress\(\)\)/);
  const restoreBody = pageJs.slice(pageJs.indexOf("function restoreFromAddress()"), pageJs.indexOf("function wire()"));
  assert.doesNotMatch(restoreBody, /read\(|client\./, "a restore paints from the payload in hand");
  const chooseBody = pageJs.slice(pageJs.indexOf("function choose("), pageJs.indexOf("function restoreFromAddress()"));
  assert.doesNotMatch(chooseBody, /read\(|client\./, "choosing a slice issues no read");
});

/* ----------------------------------------------------------------------- B06-10 */

test("B06-10 one read per paint: getBoard once, and no other verb at all", async () => {
  const { client, calls } = captureClient();
  const answer = await client.getBoard({ workspace: "all" });
  assert.equal(calls.length, 1, "one paint, one call");
  assert.equal(calls[0].verb, "deal-room-board");
  assert.deepEqual(calls[0].arguments, { workspace: "all" }, "the schema's two keys, and only the one this tab sends");
  assert.equal(validBoardPayload(answer), true);

  // The render path reads nothing. Every number it paints is in hand already.
  const renderBody = pageJs.slice(pageJs.indexOf("function render()"), pageJs.indexOf("export async function read("));
  assert.doesNotMatch(renderBody, /client\./, "the render path issues no read of its own");
  assert.doesNotMatch(renderBody, /fetch\(/, "the render path issues no fetch of its own");
  // `client.` appears exactly once in the whole page, and it is getBoard.
  assert.deepEqual(pageJs.match(/client\.\w+/g), ["client.getBoard"]);
  // Matched over the CODE with the comments stripped, because §6.1 and §6.2 are
  // written down in the model's header: naming a rejected verb in prose is the
  // point, calling it is the failure. `deal-board` is matched without its
  // `room-` prefix so it cannot hide inside the name of the verb this tab reads.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const verb of [/today-triage/, /(?<!room-)deal-board/, /lead-board/, /commandCenter/, /command-center/, /getDeal/, /patchDealField/]) {
    assert.doesNotMatch(code(pageJs), verb, `the Charts tab never calls ${verb}`);
    assert.doesNotMatch(code(modelJs), verb, `the Charts model never calls ${verb}`);
  }
  // And it writes nothing: the tab offers no action that mutates a record.
  for (const source of [pageJs, modelJs]) assert.ok(!/idempotency_key|\bwrite\(/.test(source), "the Charts tab sends no write");

  // The one device fact is its own key, and it is neither of the other two.
  const written = [];
  const storage = { getItem: () => null, setItem: (key, value) => written.push([key, value]) };
  writeChartsView(storage, { ownerOpen: true });
  assert.deepEqual(written, [[CHARTS_VIEW_KEY, '{"ownerOpen":true}']]);
  assert.equal(CHARTS_VIEW_KEY, "doctorcre.charts-view.v1");
  assert.notEqual(CHARTS_VIEW_KEY, PREFERENCES_KEY);
  assert.notEqual(CHARTS_VIEW_KEY, SAVED_VIEWS_KEY);
  assert.equal(readChartsView(null).ownerOpen, false);
  assert.equal(readChartsView({ getItem: () => { throw new Error("blocked"); } }).ownerOpen, false);
  // Owners are listed by name with the unassigned bucket last, never ranked.
  assert.deepEqual(ownerRows(board.deals).map((row) => [row.label, row.count]), [["dell", 35], ["joe", 7], ["unassigned", 32]]);
});

/* ----------------------------------------------------------------------- B06-11 */

test("B06-11 the live capture validates, and a payload missing a key is rejected (defect 33e8409b)", () => {
  // Accepts the REAL production payload, in both the wire and adapted shapes.
  assert.equal(validBoardPayload(capture), true);
  assert.equal(validBoardPayload(board), true);
  assert.deepEqual(Object.keys(capture).toSorted(), ["accounts", "actor", "deals", "open_session"]);
  assert.equal(capture.deals.length, 74);
  assert.equal(capture.accounts.length, 3);
  assert.equal(capture.open_session, null);

  // And rejects what is not that shape. A payload with `deals` removed is the
  // exact case the defect was filed about.
  const { deals, ...withoutDeals } = capture;
  assert.equal(validBoardPayload(withoutDeals), false);
  const { accounts, ...withoutAccounts } = capture;
  assert.equal(validBoardPayload(withoutAccounts), false);
  assert.equal(validBoardPayload({ ...capture, deals: {} }), false);
  assert.equal(validBoardPayload({ ...capture, deals: [{ name: "no id" }] }), false);
  assert.equal(validBoardPayload(null), false);
  assert.equal(validBoardPayload([]), false);
  assert.equal(validBoardPayload("a string the page must not chart"), false);

  // The nullability the PRODUCER guarantees, not only what this capture holds:
  // every date field is a string or null, never a Date, and field_base is an
  // object that may be empty rather than a null.
  for (const deal of capture.deals) {
    for (const field of ["next_date", "last_touch", "last_review_at", "parked_at"]) {
      assert.ok(deal[field] === null || typeof deal[field] === "string", `${field} is a string or null`);
    }
    assert.equal(typeof deal.attention, "boolean");
    assert.equal(typeof deal.field_base, "object");
  }
  // A bar over an all-zero chart divides by nothing rather than by zero.
  assert.equal(barShare({ count: 0 }, [{ count: 0 }]), 0);
  assert.equal(barShare({ count: 31 }, phaseRows(board.deals)), 100);
});

/* ----------------------------------------------------------------------- B06-12 */

test("B06-12 repository invariants: deal-room-board stays pinned, no route moves, and the tab is a query on an admitted path", () => {
  assert.ok(contract.mcp_operations.includes("deal-room-board"), "the Charts tab's one read stays pinned");
  assert.equal(contract.version, "1.24.0", "S02 added the two session-identity verbs after B12 shipped");
  assert.equal(contract.mcp_operations.length, 61);
  assert.equal(contract.producer.source_commit, "35009e9dedab3a603836c662d0f7f12dfeb1a284");
  assert.match(checkScript, /the Charts tab needs deal-room-board pinned/);

  // No route is added. `/business` already resolves, and the gate does not
  // inspect a query string, so `?charts=1` needs no admission of its own.
  assert.equal(routes.routes["/business"], "business-workspace.html");
  assert.equal(routes.routes["/charts"], undefined, "the Charts tab adds no route");
  assert.equal(Object.keys(routes.routes).some((route) => route.includes("chart")), false);
  assert.equal(chartsAddress({ group: "segment", pick: "Dental" }).startsWith("/business?"), true);

  // The tab, its panel and its wiring are all present, and the tab is selected
  // from the address exactly as the Search tab is.
  assert.match(html, /id="tabCharts" aria-controls="panelCharts"/);
  assert.match(html, /<section class="tabpanel" id="panelCharts"/);
  assert.match(workspaceJs, /if \(parseChartsAddress\(globalThis\.location\?\.search \|\| ""\)\.present\) tabs\?\.select\("tabCharts"\);/);
  assert.match(workspaceJs, /mountCharts\(\{ client, board: boardRead, onRestore: \(\) => tabs\?\.select\("tabCharts"\) \}\);/);

  // UX19: the row is the control, it clears the touch floor, the bar is paint,
  // and reduced motion is honoured by having no transition at all.
  assert.match(pageJs, /<span class="chart-bar" aria-hidden="true"/);
  assert.match(css, /\.chart-pick \{[^}]*min-height: var\(--touch\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.chart-bar \{ transition: none; \} \}/);
  assert.match(css, /:root\[data-motion="reduced"\] \.chart-bar \{ transition: none; \}/);
  assert.match(css, /@media \(max-width: 480px\) \{\s*\n\s*\.chart-bar-cell \{ display: none; \}/);
  assert.ok(!css.includes("--share: ") || css.includes("var(--share, 0%)"));
  // No new colour token and no new type scale: the shared visual system stands.
  const b06Css = css.slice(css.indexOf("/* V5-UX-B06 Charts tab"));
  assert.doesNotMatch(b06Css, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "the Charts block defines no colour of its own");

  // Every dimension the address can name is one this page actually charts.
  assert.deepEqual([...DIMENSION_IDS], ["phase", "type", "segment", "market", "operating_state", "owner"]);
});

/* ----------------------------------------------------------------------- B06-13 */

test("B06-13 a pick no record carries renders the no-match state and draws no chart at all", () => {
  // An address is editable and copyable (§3.4), so a slice that matches nothing
  // is ordinary traffic: a segment that was on the board yesterday and is not
  // today produces exactly this.
  const address = parseChartsAddress("?charts=1&group=segment&pick=NoSuchSegment");
  assert.equal(address.present, true);
  assert.equal(address.group, "segment");
  assert.equal(address.pick, "NoSuchSegment");
  assert.equal(filterDeals(board.deals, "segment", "NoSuchSegment").length, 0);

  // It is its OWN state, with its own heading, and it is not `ready`.
  const phase = chartsPhase({ status: "ready", payload: board, group: "segment", pick: "NoSuchSegment" });
  assert.equal(phase, "no_match");
  assert.equal(CHARTS_STATE_COPY.no_match.title, "Nothing on this board matches that slice");
  assert.equal(CHARTS_STATE_COPY.no_match.retry, false, "the board answered; there is nothing to retry");
  assert.notEqual(CHARTS_STATE_COPY.no_match.title, CHARTS_STATE_COPY.empty.title, "an empty board and an empty slice say different things");

  // Every other dimension reaches it the same way, and a pick that DOES match
  // never does.
  for (const [group, pick] of [["market", "Atlantis"], ["type", "barter"], ["owner", "nobody"], ["phase", "abandoned"], ["operating_state", "frozen"]]) {
    assert.equal(chartsPhase({ status: "ready", payload: board, group, pick }), "no_match", `${group}=${pick}`);
  }
  assert.equal(chartsPhase({ status: "ready", payload: board, group: "segment", pick: "Dental" }), "ready");
  assert.equal(chartsPhase({ status: "ready", payload: board, group: "segment", pick: NO_VALUE_KEY }), "ready");
  assert.equal(chartsPhase({ status: "ready", payload: board, group: null, pick: null }), "ready");

  // And the page paints no chart from it — only the way back out. A grid of
  // zeros would read as a finding, which is what the empty-state copy forbids.
  const renderBody = pageJs.slice(pageJs.indexOf("function render()"), pageJs.indexOf("export async function read("));
  assert.match(renderBody, /\} else if \(phase === "no_match"\) \{[\s\S]*?canvas\.innerHTML = selectionHtml\(deals, all\);/);
  const noMatchBranch = renderBody.slice(renderBody.indexOf('phase === "no_match"'), renderBody.indexOf("    } else {"));
  assert.ok(noMatchBranch.length > 0 && noMatchBranch.length < renderBody.length);
  assert.doesNotMatch(noMatchBranch, /chartHtml\(|accountsHtml\(|ownerHtml\(/, "the no-match branch draws not one chart");
  // The selection strip it does draw offers the way out and names the miss.
  assert.match(pageJs, /id="chartsClear">Clear this slice</);
  assert.equal(selectionLabel("segment", "NoSuchSegment"), "Segment: NoSuchSegment");
});

/* ----------------------------------------------------------------------- B06-14 */

/**
 * A DOM small enough to drive the real `mountCharts` and nothing more. The
 * point of this test is the CALL COUNT at the fetch, which no assertion over
 * the text of `js/charts.js` alone can reach: B06-10 counts the call sites
 * inside one file, and a second read taken by the page that mounts it would
 * slip straight past that.
 */
function stubDom({ search = "?charts=1" } = {}) {
  const nodes = new Map();
  for (const id of ["chartsCanvas", "chartsState", "chartsLive", "chartsReadAt", "chartsOneRead", "chartsSnapshot", "chartsForecast"]) {
    nodes.set(id, {
      id, innerHTML: "", textContent: "", hidden: false, open: false, attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      getAttribute(key) { return this.attrs[key]; },
      addEventListener() {},
    });
  }
  globalThis.document = { getElementById: (id) => nodes.get(id) || null, addEventListener() {}, querySelectorAll: () => [] };
  globalThis.location = { search };
  globalThis.history = { pushState() {}, replaceState() {} };
  return nodes;
}

test("B06-14 the whole page takes ONE deal-room-board call per load: the tab is handed the page's read and takes none of its own", async () => {
  const nodes = stubDom();
  const { client, calls } = captureClient();
  const { mountCharts } = await import("../js/charts.js");

  // Exactly the wiring `js/business-workspace.js` boot() performs: the page
  // takes ONE board read and hands the promise to both consumers.
  const boardRead = client.getBoard({ workspace: "all" });
  assert.equal(calls.length, 1, "the page's own read");
  mountCharts({ client, storage: null, board: boardRead });
  const quickAdd = await boardRead;            // the Quick add consumer
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The tab painted from that same answer and issued nothing of its own. TWO
  // is the failure this test exists to catch.
  assert.equal(calls.length, 1, "the Charts tab adds no board read of its own");
  assert.deepEqual(calls.map((call) => call.verb), ["deal-room-board"]);
  assert.equal(quickAdd.deals.length, 74);
  const painted = nodes.get("chartsCanvas").innerHTML;
  assert.match(painted, /73 of 74 have no next date on file/, "the tab painted from the page's answer");
  assert.match(nodes.get("chartsReadAt").textContent, /^Read at \d\d:\d\d$/);
  assert.equal(nodes.get("chartsState").hidden, true, "a ready paint shows no state block");

  // Only a person pressing Retry takes a new one, and that is a new as-of they
  // asked for — one call, not two.
  const { read } = await import("../js/charts.js");
  await read({ push: false });
  assert.equal(calls.length, 2, "a deliberate re-read is exactly one more call");

  // And the page's wiring is the shared promise, not two reads racing.
  assert.equal((workspaceJs.match(/client\.getBoard\(/g) || []).length, 1, "business-workspace.js takes exactly one board read");
  assert.match(workspaceJs, /const boardRead = readBoard\(\);/);
  assert.match(workspaceJs, /function readBoard\(\) \{\s*return client\.getBoard\(\{ workspace: 'all' \}\);\s*\}/);
  assert.match(workspaceJs, /async function loadBoardRecords\(boardRead\) \{/, "Quick add is handed the read rather than taking one");
  assert.match(workspaceJs, /const board = await boardRead;/);
  assert.match(pageJs, /const pending = sharedBoard \|\| client\.getBoard\(\{ workspace: "all" \}\);\s*\n\s*sharedBoard = null;/);
  // popstate restores the TAB as well as the selection (advisory A6).
  assert.match(pageJs, /if \(address\.present\) selectTab\?\.\(\);/);
  assert.match(workspaceJs, /onRestore: \(\) => tabs\?\.select\("tabCharts"\)/);
});
