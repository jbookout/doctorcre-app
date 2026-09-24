// V5-UX-B04 — the critical-dates Calendar.
//
// The calendar is a READ surface over two verbs the app already pins:
// `deal-room-board` (which deals exist) and `get-deal-room` (each deal's own
// critical_date rows, every horizon — not today-triage's 14-day window). These
// tests pin four things:
//
//   1. the date arithmetic is calendar arithmetic on YYYY-MM-DD, never on a
//      local clock that can slide a date across midnight;
//   2. the read is honest — a deal that could not be read makes the page
//      PARTIAL and names the deal, a row with no readable date is listed as
//      undated instead of being dropped, and a signed-out session shows nothing;
//   3. the URL is the view's memory (view, anchor, selected day);
//   4. the motion rule 9293d609: month/week transitions, approach pulses,
//      hover/press, a staggered entrance under a second, and a reduced-motion
//      fallback that leaves every date visible.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CALENDAR_VIEWS, ENTRANCE_BUDGET_MS, addDays, addMonths, approach, calendarHref, calendarPhase,
  criticalDateEntries, daysBetween, entriesByDay, localToday, monthGrid, motionDirection,
  parseCalendarState, readCalendar, staggerDelay, stepAnchor, toDay, upcomingEntries, weekStrip,
} from "../js/calendar-model.js";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

/* ------------------------------------------------------------ date arithmetic */

test("toDay accepts a calendar date and node-pg's midnight timestamp, and refuses anything it would have to guess", () => {
  assert.equal(toDay("2026-09-30"), "2026-09-30");
  assert.equal(toDay("2026-09-30T00:00:00.000Z"), "2026-09-30");
  assert.equal(toDay("2026-09-30T00:00:00Z"), "2026-09-30");
  assert.equal(toDay("2026-09-30T00:00:00+00:00"), "2026-09-30");
  assert.equal(toDay("2026-09-30T14:00:00.000Z"), null, "a time of day is not a calendar date");
  assert.equal(toDay("2026-02-30"), null, "an impossible date is refused, not rolled over");
  assert.equal(toDay("next Tuesday"), null);
  assert.equal(toDay(null), null);
  assert.equal(toDay(undefined), null);
  assert.equal(toDay(20260930), null);
});

test("day arithmetic crosses month and year ends, and a month step clamps to the month's last day", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29", "a leap year keeps the 29th");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(daysBetween("2026-09-24", "2026-10-01"), 7);
  assert.equal(daysBetween("2026-09-24", "2026-09-20"), -4);
});

test("today is the viewer's LOCAL calendar day, not the UTC one", () => {
  // 11 PM on Sep 24 somewhere west of Greenwich is already Sep 25 in UTC.
  const lateEvening = { getFullYear: () => 2026, getMonth: () => 8, getDate: () => 24 };
  assert.equal(localToday(lateEvening), "2026-09-24");
});

test("the month grid is six Sunday-first weeks with the anchor's month marked", () => {
  const grid = monthGrid("2026-09-24");
  assert.equal(grid.title, "September 2026");
  assert.equal(grid.days.length, 42);
  assert.equal(grid.days[0].day, "2026-08-30", "Sep 1 2026 is a Tuesday, so the grid opens on Sunday Aug 30");
  assert.equal(grid.days[2].day, "2026-09-01");
  assert.equal(grid.days[2].inMonth, true);
  assert.equal(grid.days[0].inMonth, false);
  assert.equal(grid.days.filter((cell) => cell.inMonth).length, 30);
  assert.equal(grid.days[41].day, "2026-10-10");
});

test("the week strip is the anchor's Sunday-first week with a readable range title", () => {
  const week = weekStrip("2026-09-24");
  assert.deepEqual(week.days.map((cell) => cell.day), [
    "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26",
  ]);
  assert.equal(week.title, "Sep 20 – 26, 2026");
  assert.equal(weekStrip("2026-09-30").title, "Sep 27 – Oct 3, 2026");
  assert.equal(weekStrip("2026-12-31").title, "Dec 27, 2026 – Jan 2, 2027");
});

/* ---------------------------------------------------------------- URL memory */

test("the address is the view's memory: view, anchor and selected day round-trip, and junk is dropped", () => {
  const today = "2026-09-24";
  assert.deepEqual(parseCalendarState("", today), { view: "month", anchor: today, day: null });
  const state = parseCalendarState("?view=week&d=2026-10-05&day=2026-10-07", today);
  assert.deepEqual(state, { view: "week", anchor: "2026-10-05", day: "2026-10-07" });
  assert.equal(calendarHref(state), "/calendar?view=week&d=2026-10-05&day=2026-10-07");
  assert.deepEqual(parseCalendarState(calendarHref(state).split("?")[1], today), state);
  assert.deepEqual(parseCalendarState("?view=year&d=soon&day=2026-02-30", today), { view: "month", anchor: today, day: null });
  assert.equal(calendarHref({ view: "month", anchor: today, day: null }), "/calendar?view=month&d=2026-09-24");
  assert.deepEqual(CALENDAR_VIEWS, ["month", "week"]);
});

test("stepping moves a month or a week, and the motion direction follows the step", () => {
  const month = { view: "month", anchor: "2026-09-24", day: null };
  assert.equal(stepAnchor(month, 1).anchor, "2026-10-24");
  assert.equal(stepAnchor(month, -1).anchor, "2026-08-24");
  const week = { view: "week", anchor: "2026-09-24", day: "2026-09-25" };
  assert.equal(stepAnchor(week, 1).anchor, "2026-10-01");
  assert.equal(stepAnchor(week, 1).day, "2026-09-25", "a step keeps the selected day");
  assert.equal(motionDirection(month, stepAnchor(month, 1)), "forward");
  assert.equal(motionDirection(month, stepAnchor(month, -1)), "back");
  assert.equal(motionDirection(month, { ...month, view: "week" }), "zoom-in");
  assert.equal(motionDirection(week, { ...week, view: "month" }), "zoom-out");
  assert.equal(motionDirection(month, { ...month, day: "2026-09-02" }), "none", "selecting a day moves nothing");
  assert.equal(motionDirection(null, month), "enter");
});

/* ------------------------------------------------------------ approach pulses */

test("a date pulses faster as it approaches, and a settled date never pulses", () => {
  const today = "2026-09-24";
  assert.deepEqual(approach({ day: "2026-09-20", settled: false }, today), { band: "overdue", days: -4, pulse: "urgent", label: "4 days ago" });
  assert.deepEqual(approach({ day: today, settled: false }, today), { band: "today", days: 0, pulse: "urgent", label: "today" });
  assert.deepEqual(approach({ day: "2026-09-25", settled: false }, today), { band: "soon", days: 1, pulse: "attention", label: "tomorrow" });
  assert.equal(approach({ day: "2026-10-01", settled: false }, today).band, "soon", "seven days out is still this week");
  assert.equal(approach({ day: "2026-10-02", settled: false }, today).band, "near");
  assert.equal(approach({ day: "2026-10-02", settled: false }, today).pulse, "calm");
  assert.equal(approach({ day: "2026-10-24", settled: false }, today).band, "near", "thirty days out is near");
  assert.deepEqual(approach({ day: "2026-12-01", settled: false }, today), { band: "later", days: 68, pulse: "still", label: "in 68 days" });
  assert.deepEqual(approach({ day: "2026-09-20", settled: true }, today), { band: "settled", days: -4, pulse: "still", label: "4 days ago" });
  assert.equal(approach({ day: "2026-09-23", settled: false }, today).label, "yesterday");
});

test("the staggered entrance finishes inside the one-second budget however many cells there are", () => {
  assert.equal(staggerDelay(0), 0);
  assert.ok(staggerDelay(1) > 0);
  assert.ok(staggerDelay(41) <= ENTRANCE_BUDGET_MS);
  assert.ok(staggerDelay(500) <= ENTRANCE_BUDGET_MS, "a long agenda never delays past the budget");
  assert.ok(ENTRANCE_BUDGET_MS + 270 <= 1000, "stagger plus the shared --motion-enter stays under a second");
});

/* ------------------------------------------------------------- the entries */

const deal = { id: "d1", name: "Demo Crestview Dental", phase: "Negotiation", owner: "joe", operating_state: "active" };

test("a live get-deal-room row becomes an entry with its label, kind, source and status, and a row with no readable date is kept as undated", () => {
  const detail = {
    critical_dates: [
      { id: "cd-1", kind: "loi_expiry", due_on: "2026-10-02", note: "LOI expires", source: "LOI draft v3", status: "open", label: "LOI expires", date: "2026-10-02" },
      { id: "cd-2", kind: "option_window", due_on: "2026-09-01", note: null, source: "lease §4", status: "done", label: "option_window", date: "2026-09-01" },
      { id: "cd-3", kind: "earnout", due_on: null, note: "Earnout", source: null, status: "open", label: "Earnout", date: null },
    ],
  };
  const { entries, undated } = criticalDateEntries(deal, detail);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    key: "cd-1", deal_id: "d1", deal_name: "Demo Crestview Dental", day: "2026-10-02", label: "LOI expires",
    kind: "loi_expiry", kind_label: "LOI expiry", source: "LOI draft v3", status: "open", settled: false,
  });
  assert.equal(entries[1].settled, true, "a done date is settled");
  assert.equal(entries[1].label, "Option window", "a bare kind slug is shown as words");
  assert.equal(undated.length, 1);
  assert.equal(undated[0].label, "Earnout");
  assert.equal(undated[0].day, null);
});

test("the fixture adapter's {label, date} rows read the same way, with stable keys", () => {
  const { entries } = criticalDateEntries(deal, { critical_dates: [{ label: "Lease commencement", date: "2026-11-01" }] });
  assert.equal(entries[0].key, "d1:0");
  assert.equal(entries[0].day, "2026-11-01");
  assert.equal(entries[0].status, null, "a missing status is unknown, not open");
  assert.equal(entries[0].settled, false);
  assert.equal(entries[0].source, null);
});

test("entriesByDay groups by day and orders open before settled, then by label", () => {
  const rows = [
    { key: "b", day: "2026-10-02", label: "Zeta", settled: false },
    { key: "a", day: "2026-10-02", label: "Alpha", settled: true },
    { key: "c", day: "2026-10-02", label: "Beta", settled: false },
    { key: "d", day: "2026-10-03", label: "Gamma", settled: false },
  ];
  const map = entriesByDay(rows);
  assert.deepEqual(map.get("2026-10-02").map((row) => row.key), ["c", "b", "a"]);
  assert.equal(map.get("2026-10-03").length, 1);
});

test("the upcoming agenda is the open dates from today forward, nearest first, overdue ones ahead of them", () => {
  const today = "2026-09-24";
  const rows = [
    { key: "later", day: "2026-11-01", label: "L", settled: false },
    { key: "soon", day: "2026-09-26", label: "S", settled: false },
    { key: "late", day: "2026-09-20", label: "O", settled: false },
    { key: "done", day: "2026-09-25", label: "D", settled: true },
  ];
  assert.deepEqual(upcomingEntries(rows, today, 10).map((row) => row.key), ["late", "soon", "later"]);
  assert.deepEqual(upcomingEntries(rows, today, 2).map((row) => row.key), ["late", "soon"]);
});

/* ------------------------------------------------------------------ the read */

function stubClient({ board, details = {}, boardError = null, detailErrors = {} } = {}) {
  const calls = [];
  return {
    calls,
    async getBoard(options) {
      calls.push(["getBoard", options]);
      if (boardError) throw boardError;
      return board;
    },
    async getDeal(id) {
      calls.push(["getDeal", id]);
      if (detailErrors[id]) throw detailErrors[id];
      return details[id];
    },
  };
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("readCalendar reads the board once and every deal's own record, and reports ready with every entry", async () => {
  const client = stubClient({
    board: { actor: "joe", deals: [deal, { ...deal, id: "d2", name: "Demo Bayside Ortho" }] },
    details: {
      d1: { critical_dates: [{ id: "x", kind: "loi_expiry", due_on: "2026-10-02", note: "LOI", source: "s", status: "open" }] },
      d2: { critical_dates: [] },
    },
  });
  const result = await readCalendar(client);
  assert.equal(result.status, "ready");
  assert.equal(result.dealCount, 2);
  assert.equal(result.readCount, 2);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(client.calls[0], ["getBoard", { workspace: "all" }]);
  assert.deepEqual(client.calls.slice(1).map((call) => call[1]).sort(), ["d1", "d2"]);
  assert.equal(calendarPhase(result), "ready");
});

test("a deal whose record cannot be read makes the page PARTIAL and names it; its dates are not guessed", async () => {
  const client = stubClient({
    board: { deals: [deal, { ...deal, id: "d2", name: "Demo Bayside Ortho" }] },
    details: { d1: { critical_dates: [{ id: "x", due_on: "2026-10-02", kind: "loi_expiry", status: "open" }] } },
    detailErrors: { d2: httpError(502) },
  });
  const result = await readCalendar(client);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.failed, [{ deal_id: "d2", deal_name: "Demo Bayside Ortho" }]);
  assert.equal(result.entries.length, 1);
  assert.equal(calendarPhase(result), "partial");
});

test("a malformed deal answer counts as unread, never as a deal with no dates", async () => {
  const client = stubClient({ board: { deals: [deal] }, details: { d1: { critical_dates: "soon" } } });
  const result = await readCalendar(client);
  assert.deepEqual(result.failed.map((row) => row.deal_id), ["d1"]);
  assert.equal(calendarPhase(result), "partial");
});

test("an ended session on any read shows nothing at all", async () => {
  const onBoard = await readCalendar(stubClient({ boardError: httpError(401) }));
  assert.equal(onBoard.status, "unauthorized");
  assert.equal(calendarPhase(onBoard), "unauthorized");
  const onDeal = await readCalendar(stubClient({
    board: { deals: [deal] }, detailErrors: { d1: httpError(403) },
  }));
  assert.equal(onDeal.status, "unauthorized");
  assert.deepEqual(onDeal.entries, [], "no half-read dates survive a sign-out");
});

test("an unreadable board is unavailable, and an empty book is empty — the two are never confused", async () => {
  assert.equal(calendarPhase(await readCalendar(stubClient({ boardError: httpError(502) }))), "unavailable");
  assert.equal(calendarPhase(await readCalendar(stubClient({ board: { deals: "none" } }))), "unavailable");
  assert.equal(calendarPhase(await readCalendar(stubClient({ board: { deals: [] } }))), "empty");
  const noDates = await readCalendar(stubClient({ board: { deals: [deal] }, details: { d1: { critical_dates: [] } } }));
  assert.equal(calendarPhase(noDates), "empty");
  assert.equal(calendarPhase({ status: "loading" }), "loading");
});

test("the per-deal reads are bounded: never more than the concurrency limit in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const deals = Array.from({ length: 12 }, (_, index) => ({ ...deal, id: `d${index}` }));
  const client = {
    async getBoard() { return { deals }; },
    async getDeal() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return { critical_dates: [] };
    },
  };
  const result = await readCalendar(client, { concurrency: 3 });
  assert.equal(result.readCount, 12);
  assert.ok(peak <= 3, `peak ${peak} exceeded the limit`);
});

test("the calendar reads through the fixture adapter's real getBoard/getDeal shapes", async () => {
  const { createFixtureClient } = await import("../js/fixture-client.js");
  const seedText = await read("data/board-seed.json");
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seedText).toString("base64")}` });
  const result = await readCalendar(client);
  assert.equal(result.status, "ready");
  assert.ok(result.dealCount > 0);
  assert.ok(result.entries.length > 0, "the synthetic board carries dated rows");
  assert.ok(result.entries.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.day)));
});

/* ----------------------------------------------------------------- the page */

test("the Calendar is a routed, shipped surface that reads only pinned verbs", async () => {
  const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
  const carr = JSON.parse(await read("contracts/carr-interface.v1.json"));
  const artifact = await read("scripts/artifact.mjs");
  const check = await read("scripts/check-repository.mjs");
  const summary = await read("SUMMARY.md");
  assert.equal(routes.routes["/calendar"], "calendar.html");
  assert.equal(routes.version, "1.13.0", "two added routes are an additive, minor bump");
  for (const verb of ["deal-room-board", "get-deal-room"]) assert.ok(carr.mcp_operations.includes(verb), `${verb} must stay pinned`);
  assert.match(artifact, /"calendar\.html"/);
  assert.match(check, /"calendar\.html"/);
  assert.match(summary, /calendar\.html/);

  const js = await read("js/calendar.js");
  const model = await read("js/calendar-model.js");
  // Reads only: no write verb, no idempotency key, no fixture on the live path.
  for (const source of [js, model]) {
    assert.doesNotMatch(source, /addCriticalDate|patchDealField|idempotency_key|setNextStep/);
  }
  assert.match(js, /resolveDealroomBoot/, "live or fixture is decided by the reviewed boot rule, never by the page");
  assert.doesNotMatch(model, /fixture-client|createFixtureClient|board-seed/, "the model has no fixture branch");
  assert.match(js, /mountNotificationBadge\(/);
  assert.match(js, /history\.(pushState|replaceState)/, "the address carries the view");
});

test("the Calendar page carries the shared shell, an accessible grid and an agenda that never waits on motion", async () => {
  const html = await read("calendar.html");
  assert.match(html, /<html lang="en" data-theme="dark" data-density="comfortable" data-motion="full">/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/calendar\.css">/);
  assert.match(html, /id="navUnreadBadge" hidden/);
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.match(html, /id="docReading">Doc is reading: Calendar</);
  assert.match(html, /id="receiptDock"/);
  assert.match(html, /id="calGrid"[^>]*role="grid"/);
  assert.match(html, /data-view="month"[^>]*aria-pressed="true"/);
  assert.match(html, /data-view="week"[^>]*aria-pressed="false"/);
  assert.match(html, /id="calPrev"/);
  assert.match(html, /id="calToday"/);
  assert.match(html, /id="calNext"/);
  assert.match(html, /id="calPeriod"[^>]*aria-live="polite"/);
  assert.match(html, /id="calAgenda"/, "a plain list carries every upcoming date for a reader who never touches the grid");
  assert.match(html, /id="calUndated"/, "undated rows have a place, so missing is not shown as empty");
  assert.match(html, /id="dayPanel"/);
  assert.match(html, /<script type="module" src="\/js\/calendar\.js"><\/script>/);
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
});

/* ------------------------------------------------------------------- motion */

const css = await read("css/calendar.css");

test("month and week transitions animate between before and after on the shared tokens", () => {
  for (const direction of ["forward", "back", "zoom-in", "zoom-out"]) {
    assert.match(css, new RegExp(`\\.cal-grid\\[data-enter="${direction}"\\][^{]*\\{[^}]*animation:[^;]*var\\(--motion-move\\)[^;]*var\\(--ease\\)`), direction);
  }
  for (const frame of ["cal-slide-forward", "cal-slide-back", "cal-zoom-in", "cal-zoom-out"]) {
    assert.match(css, new RegExp(`@keyframes ${frame}`), frame);
  }
});

test("dates pulse on the shared state durations as they approach", () => {
  assert.match(css, /\.cal-pulse\[data-pulse="urgent"\][^{]*\{[^}]*animation:[^;]*var\(--motion-urgent\)/);
  assert.match(css, /\.cal-pulse\[data-pulse="attention"\][^{]*\{[^}]*animation:[^;]*var\(--motion-attention\)/);
  assert.match(css, /\.cal-pulse\[data-pulse="calm"\][^{]*\{[^}]*animation:[^;]*var\(--motion-calm\)/);
  assert.doesNotMatch(css, /\.cal-pulse\[data-pulse="still"\][^{]*\{[^}]*animation/, "a distant or settled date is still");
});

test("every interactive calendar element answers hover and press", () => {
  for (const selector of ["\\.cal-day", "\\.cal-chip", "\\.cal-agenda-item"]) {
    assert.match(css, new RegExp(`${selector}:hover[^{]*\\{[^}]*transform`), `${selector} hover`);
    assert.match(css, new RegExp(`${selector}:active[^{]*\\{[^}]*transform`), `${selector} press`);
  }
});

test("the entrance is staggered from a per-cell index on the shared receipt-in keyframe", () => {
  assert.match(css, /\.cal-day \{[^}]*animation: receipt-in var\(--motion-enter\) var\(--ease\) backwards/);
  assert.match(css, /animation-delay: var\(--stagger, 0ms\)/);
  // No new motion vocabulary: only the shared duration tokens are used.
  const durations = [...css.matchAll(/var\((--motion-[a-z]+)\)/g)].map((match) => match[1]);
  for (const token of durations) assert.match(token, /^--motion-(calm|attention|urgent|flow|enter|move|ring|toast)$/);
  assert.doesNotMatch(css, /--motion-[a-z]+:\s/, "the page defines no motion token of its own");
});

/**
 * The reduced-motion fallback, FORCED rather than read. The shared floor in
 * css/system.css strips every animation and transition under
 * prefers-reduced-motion: reduce (and data-motion="reduced"). This test does
 * the same to the page sheet — removes every animation and transition
 * declaration — and then checks that what is left shows every date: no rule
 * leaves a cell, chip or agenda row invisible, collapsed or off-screen, which is
 * what a `from { opacity: 0 }` start state would do if a page relied on the
 * animation to reveal content.
 */
test("reduced motion: forcing the fallback leaves every date visible and every state legible", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "the page has its own reduced-motion block");
  assert.match(css, /:root\[data-motion="reduced"\]/, "the in-app motion preference is honoured too");

  const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(reducedBlock, /transform: none/, "hover and press transforms are removed, not just their transitions");

  const forced = css
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "")
    .replace(/(?:animation|transition)(?:-[a-z]+)?\s*:[^;}]+;?/g, "");
  const rules = [...forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  // `display: none` is not in this list on purpose: the sheet uses it for
  // layout (the deal name inside a month cell, the weekday header on a phone),
  // which is identical with motion on or off, and the same text is in the day
  // panel and the cell's label. The fallback risk is a START state — something
  // at zero opacity or hidden that only an animation would have revealed.
  const hides = /opacity:\s*0(?![.\d])|visibility:\s*hidden|transform:\s*scale\(0\)/;
  for (const [, selector, body] of rules) {
    if (!/cal-(day|chip|agenda|grid|pulse|week|undated)/.test(selector)) continue;
    if (/\[hidden\]|:not\(|\.sr-only/.test(selector)) continue;
    assert.doesNotMatch(body, hides, `${selector.trim()} hides content once motion is gone`);
  }
  // The pulse shape itself carries the state when it stops moving.
  assert.match(css, /\.cal-pulse\[data-pulse="urgent"\][^{]*\{[^}]*box-shadow/, "urgent is a double ring, readable still");
  assert.match(css, /\.cal-pulse\[data-pulse="still"\][^{]*\{[^}]*background: transparent/, "still is a hollow dot");
});

test("reduced motion is honoured by the script too: no programmatic scroll animation or timed reveal", async () => {
  const js = await read("js/calendar.js");
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /data-motion/);
  assert.doesNotMatch(js, /behavior:\s*["']smooth["']\s*}/, "smooth scrolling is chosen per preference, never hard-coded");
});
