import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as homeModel from "../js/business-workspace-model.js";
import {
  CALLS_ABSENT, HOME_SECTIONS, SECTION_READ, SECTION_TITLE, TRIAGE_ROW_CAP, WAITING_ROW_CAP,
  countFrames, dueWords, homeSections, needLabel, sectionPulse, teamReviewRows, thisWeekView,
  unavailableCopy, waitingView, weekRail,
} from "../js/business-workspace-model.js";
import { migratePreferences } from "../js/shell.js";
import { acceptsResponse, quickAddRecordNames, validWorkspacePayload } from "../js/workspace-command-center-model.js";
import { quickAddRecords } from "../js/task-records-model.js";
import { parseQuickAdd } from "../js/visual-system.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFile(`${ROOT}${file}`, "utf8");

const html = await read("business-workspace.html");
const pageJs = await read("js/business-workspace.js");
const shellJs = await read("js/shell.js");
const css = await read("css/business-workspace.css");
const systemCss = await read("css/system.css");
const fixtureSeed = await read("data/board-seed.json");
const fixtureClient = (options = {}) => createFixtureClient({
  seedUrl: `data:application/json;base64,${Buffer.from(fixtureSeed).toString("base64")}`, ...options,
});
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const carrInterface = JSON.parse(await read("contracts/carr-interface.v1.json"));

const metric = (scope, active, flagged) => ({
  scope, active_deals: active, flagged_deals: flagged,
  active_destination: scope === "team" ? "/deals?workspace=team" : null,
  flagged_destination: scope === "team" ? "/deals?workspace=team&filter=flagged" : "/deals?workspace=team&filter=flagged&owner=me",
  source: null,
});

/* ------------------------------------------------------------------- the page */

test("Home carries every section the model orders, once each, and Team review is one of them", () => {
  const sections = [...html.matchAll(/data-section="([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, [...HOME_SECTIONS], "the page renders the model's sections in the model's order");
  assert.equal(new Set(sections).size, sections.length, "no section is rendered twice");
  assert.ok(sections.includes("team_review"), "Team review is a section of Home, not a tab");
  for (const id of HOME_SECTIONS) {
    assert.ok(html.includes(`<h2 id="${id === "needs_action" ? "needsActionTitle" : ""}`) || html.includes(`>${SECTION_TITLE[id]}</h2>`), `${id} carries its title`);
  }
  // Each section is a card in the shared register, and each card is its own
  // section element: the review refused one long scrolling page of loose rows.
  assert.equal([...html.matchAll(/<section class="card glass" data-section=/g)].length, HOME_SECTIONS.length);
});

test("This week, Waiting on others and Calls are sections of their own, and nothing is left 'not in this release'", () => {
  for (const id of ["this_week", "waiting_on_others", "calls"]) {
    assert.ok(HOME_SECTIONS.includes(id), `${id} is a Home section`);
    assert.match(html, new RegExp(`<section class="card glass" data-section="${id}"`), `${id} is its own card`);
  }
  assert.equal(SECTION_TITLE.this_week, "This week");
  assert.equal(SECTION_TITLE.waiting_on_others, "Waiting on others");
  assert.equal(SECTION_TITLE.calls, "Calls");
  assert.doesNotMatch(html, /not in this release/i, "the placeholder card is gone");
  assert.doesNotMatch(html, /data-section="not_in_release"/);
  assert.equal("NOT_IN_RELEASE" in homeModel, false, "the placeholder copy is not kept alive in the model");
  assert.doesNotMatch(css, /not_in_release/, "and its style went with it");
});

test("each section names the read that feeds it, and Calls names none because none exists", () => {
  assert.equal(SECTION_READ.this_week, "today-triage");
  assert.equal(SECTION_READ.waiting_on_others, "loop-board");
  assert.equal(SECTION_READ.calls, null, "no record-layer read returns logged calls");
  for (const id of ["needs_action", "pipeline", "changes", "doc_at_work", "team_review"]) assert.equal(SECTION_READ[id], "command-center");
  for (const verb of Object.values(SECTION_READ).filter((value) => value && value !== "command-center")) {
    assert.ok(carrInterface.mcp_operations.includes(verb), `${verb} is pinned in the CARR interface`);
  }
  // The command-centre payload declares this_week and recent_calls ALWAYS
  // empty, so reading them would paint a verified-looking zero it never asked
  // for. The sections read their own verbs instead.
  assert.doesNotMatch(pageJs, /payload\.(this_week|recent_calls)/, "the always-empty contract arrays are never read");
});

test("Calls states its absence in the page itself and issues no read", () => {
  assert.equal(CALLS_ABSENT, "Calls: no record-layer read returns logged calls yet");
  assert.ok(html.includes(`<h3>${CALLS_ABSENT}</h3>`), "the absent state is literal markup");
  assert.match(html, /data-section="calls"[\s\S]*?<div class="state-block" id="callsState" data-state="absent">/);
  assert.ok(!pageJs.includes(CALLS_ABSENT), "no renderer writes it, so no read can overwrite it");
  assert.doesNotMatch(pageJs, /client\.\w*(?:[Oo]utreach|[Cc]all(?:s|Log))\w*\(/, "no call or outreach read is invented");
  assert.match(css, /\.state-block\[data-state="absent"\]/, "an absent read is drawn as its own state");
});

test("a title does the job of its section: no sentence sits under any heading in a card", () => {
  // The element that FOLLOWS a heading, which is what a reader sees as the
  // description. An eyebrow precedes its heading and is not one.
  for (const match of html.matchAll(/<(h1|h2|h3)\b[^>]*>[\s\S]*?<\/\1>\s*(<[^>]+>)?/g)) {
    const next = match[2] || "";
    if (!next.startsWith("<p")) continue;
    assert.match(next, /class="[^"]*\bcaption\b[^"]*"/, `a paragraph follows a heading: ${next}`);
  }
});

test("Home never ranks the partners against each other", () => {
  assert.doesNotMatch(html, /rank|leaderboard|vs\. Dell|vs\. Joe/i);
  assert.doesNotMatch(pageJs, /rank|leaderboard|vs\. Dell|vs\. Joe/i);
  // Team review is a share of one total, which is the only partner-shaped
  // number the payload can honestly produce.
  assert.match(html, /<h2 id="teamReviewTitle">Team review<\/h2>/);
  assert.match(pageJs, /teamReviewRows/);
});

test("the shell is present: freshness line, dock, Doc, tabs, four bottom entries and 44px controls", () => {
  assert.match(html, /<p class="caption freshness" id="homeFreshness">/, "one freshness line, under the hero");
  assert.match(pageJs, /`As of \$\{clock \|\| "an unreadable time"\} · \$\{freshness\}`/, "the line states the freshness against the clock now");
  assert.match(html, /id="receiptDock" class="receipt-dock"/);
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.match(html, /<a class="btn btn-primary" id="signInAgain" href="\/auth\/login\?return_to=\/business"/, "an expired session is offered the way back in");

  const tabs = /<div class="tabs" id="businessTabs"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  assert.notEqual(tabs, "", "the page has a tab strip");
  for (const label of ["Home", "Work", "Pipeline", "Doc history"]) assert.ok(tabs.includes(`>${label}</`), `tab ${label}`);
  // Work and Pipeline NAVIGATE: they are ordinary links, so Back, a middle
  // click and a screen reader all behave as they always do.
  assert.match(tabs, /<a class="tab" href="\/tasks">Work<\/a>/);
  assert.match(tabs, /<a class="tab" href="\/pipeline">Pipeline<\/a>/);
  assert.match(css, /a\.tab\[aria-current="page"\]/, "an active page tab is marked by aria-current alone");

  const nav = /<nav class="mobile-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] || "";
  assert.equal([...nav.matchAll(/<a\b/g)].length, 4, "the bottom navigation mirrors the four tabs");
  for (const label of ["Home", "Work", "Pipeline", "Doc history"]) assert.ok(nav.includes(`${label}</a>`), `bottom entry ${label}`);

  // Every control on the page is one of the four shapes the shared sheet holds
  // at or above the 44px floor. A bare <button> would be under it.
  for (const match of html.matchAll(/<button\b[^>]*class="([^"]*)"/g)) {
    const classes = match[1].split(/\s+/);
    assert.ok(classes.some((name) => ["btn", "tab", "pref-icon", "doc-fab"].includes(name)), `a control is outside the touch-target vocabulary: ${match[1]}`);
  }
  assert.match(systemCss, /--touch: 44px/);
  assert.match(systemCss, /\.btn \{[^}]*min-height: var\(--touch\)/);
  assert.match(systemCss, /\.tab \{[^}]*min-height: var\(--touch\)/);
});

test("the page is pinned in the route contract and reads the pinned command-centre path", () => {
  assert.equal(routes.routes["/business"], "business-workspace.html");
  assert.equal(routes.routes["/"], "workspace.html", "the old Home keeps serving / until a later slice retires it");
  assert.ok(carrInterface.http_surfaces.includes("/api/v1/command-center"));
  assert.match(html, /<script type="module" src="\/js\/business-workspace\.js">/);
  assert.match(pageJs, /client\.commandCenter\(\)/, "the page reads through the client seam, not a second fetch of its own");
});

test("a read that cannot be verified drops the payload and never leaves an older count on screen", () => {
  assert.match(pageJs, /view\.payload = status === "ready" \? payload : null;/);
  assert.match(pageJs, /acceptsResponse\(view\.sequence, sequence\)/, "a response only paints if no newer read has started");
  assert.match(pageJs, /freshnessSignature/, "the clock alone can make a read stale");
  assert.match(pageJs, /status === 401 \|\| status === 403/, "an ended session is not an outage");
});

/* ------------------------------------------------------------ the pure decisions */

test("the section order is the model's, and a refused payload still produces every section", () => {
  assert.deepEqual(homeSections(null).map((section) => section.id), [...HOME_SECTIONS]);
  const unavailable = homeSections(null).filter((section) => section.fromRead);
  assert.ok(unavailable.length > 0);
  for (const section of unavailable) assert.equal(section.state, "unavailable", `${section.id} states that it is unverified`);
  const byId = (sections) => Object.fromEntries(sections.map((section) => [section.id, section]));
  assert.equal(byId(homeSections(null)).quick_add.state, "static");
  assert.equal(byId(homeSections(null)).calls.state, "absent", "a section with no read is absent, never zero");
  assert.equal(byId(homeSections(null)).calls.fromRead, false);
  // A section with a read of its own is verified by THAT read, not by the
  // command centre: a failed triage read does not blank the Pipeline, and a
  // verified triage read does not vouch for it either.
  const own = byId(homeSections(null, { this_week: "read", waiting_on_others: "unavailable" }));
  assert.equal(own.this_week.state, "read");
  assert.equal(own.waiting_on_others.state, "unavailable");
  assert.equal(own.pipeline.state, "unavailable");
  assert.equal(byId(homeSections(null, { this_week: "maybe" })).this_week.state, "unavailable", "anything but a verified read is unverified");
  assert.equal(unavailableCopy("this_week"), "This week's dates could not be verified");
  assert.equal(unavailableCopy("waiting_on_others"), "Waiting work could not be verified");
  assert.equal(unavailableCopy("changes"), "Recent changes could not be verified");
  assert.equal(unavailableCopy("invented"), "This read could not be verified");
  assert.equal(needLabel("my_flagged_deals"), "Your flagged deals");
});

test("Team review is the viewer's share of the team total, and is refused when the numbers cannot be one", () => {
  const rows = teamReviewRows([metric("team", 11, 3), metric("mine", 4, 2)]);
  assert.deepEqual(rows.map((row) => `${row.label}: ${row.value}`), ["Your active deals: 4 of 11", "Your flagged: 2 of 3"]);
  assert.equal(rows[0].destination, "/deals?workspace=team", "mine-active has no Deal Room URL, so the row opens the list it sits inside");
  assert.equal(rows[1].destination, "/deals?workspace=team&filter=flagged&owner=me");
  // Nothing flagged of your own: the row still opens the team's flagged list
  // rather than an owner filter that is known to be empty.
  assert.equal(teamReviewRows([metric("team", 11, 3), metric("mine", 4, 0)])[1].destination, "/deals?workspace=team&filter=flagged");
  assert.deepEqual(teamReviewRows([metric("team", 2, 0), metric("mine", 5, 0)]), [], "a personal count larger than the team's is not a share");
  assert.deepEqual(teamReviewRows([metric("team", 11, 3)]), [], "two scopes or nothing");
  assert.deepEqual(teamReviewRows(null), []);
});

test("mountPrefs migrates a legacy key exactly once, and never over a choice made since", () => {
  const map = new Map([["doctorcre.presentation.v1", JSON.stringify({ theme: "light" })]]);
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
  const options = { storageKey: "doctorcre.visual-preferences", legacyKeys: ["doctorcre.presentation.v1"] };
  assert.deepEqual(migratePreferences(storage, options), { theme: "light" });
  assert.equal(map.get("doctorcre.visual-preferences"), JSON.stringify({ theme: "light" }));
  assert.equal(map.has("doctorcre.presentation.v1"), false, "the legacy key is consumed, so the read happens once");

  map.set("doctorcre.visual-preferences", JSON.stringify({ theme: "dark" }));
  map.set("doctorcre.presentation.v1", JSON.stringify({ theme: "light" }));
  assert.deepEqual(migratePreferences(storage, options), { theme: "dark" }, "a choice made since is never overwritten by an older one");
  assert.equal(map.has("doctorcre.presentation.v1"), false);
  assert.deepEqual(migratePreferences(null, options), {}, "storage is a convenience, never a requirement");
  assert.match(shellJs, /export function wireTabs/, "the tab strip has one owner");
});

/* --------------------------------------------------------------- the fixture read */

test("the synthetic command-centre read is a payload the shared validator accepts", async () => {
  const fixtureText = await read("data/board-seed.json");
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}` });
  const payload = await fixture.commandCenter();
  assert.equal(validWorkspacePayload(payload), true, "the fixture exercises the same rules the live read is held to");
  assert.equal(payload.viewer, "joe");
  assert.deepEqual(payload.this_week, [], "always empty by contract");
  assert.deepEqual(payload.recent_calls, []);
  const [team, mine] = payload.metrics;
  assert.ok(mine.active_deals <= team.active_deals && mine.flagged_deals <= team.flagged_deals);
  assert.equal(payload.needs_you_now.find((item) => item.kind === "team_flagged_deals").count, team.flagged_deals);
  assert.deepEqual(teamReviewRows(payload.metrics).map((row) => row.id), ["active", "flagged"]);

  const dell = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}`, selfActor: "dell" });
  const dellPayload = await dell.commandCenter();
  assert.equal(validWorkspacePayload(dellPayload), true);
  assert.equal(dellPayload.viewer, "dell");
  assert.equal(dellPayload.needs_you_now.some((item) => item.kind === "needs_joe_work"), false, "work waiting on Joe is not shown to Dell as his");

  // Quick add is handed the names THIS read carries. The command-centre read is
  // an aggregate of counts and destinations, so today that is honestly none —
  // never the category labels ("Flagged team deals") the page draws.
  assert.deepEqual([...quickAddRecordNames(payload)], []);
  assert.deepEqual([...quickAddRecordNames(null)], [], "an unverified payload names no record");
});

test("Home's Quick add names come from a board read, and a late board response cannot overwrite a newer one", async () => {
  // The page reads the board for names. Here that read is replayed against the
  // same fixture the page uses, through the same model, so the names asserted
  // are the ones a reader would actually be offered.
  const fixtureText = await read("data/board-seed.json");
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}` });
  const board = await fixture.getBoard();
  const records = quickAddRecords(board.deals);
  assert.ok(records.length > 0, "the board names deals, which is why Quick add reads it");
  for (const record of records) {
    assert.equal(typeof record.name, "string");
    assert.ok(record.name.length > 0);
    assert.ok(record.id, "each name carries the board's own deal id");
  }
  const parsed = parseQuickAdd(`Call about ${records[0].name} friday`, { now: Date.parse("2026-09-16T14:00:00Z"), viewer: "joe", records });
  assert.equal(parsed.related, records[0].name);
  assert.equal(parsed.relatedId, records[0].id);

  // The page issues the board read ALONGSIDE the command-centre read, under a
  // second sequence of its own, and the two guards never share a counter.
  // V5-UX-B06 — the read moved up into boot() and is now SHARED with the Charts
  // tab rather than taken twice. It is still the same one board read, still
  // alongside the command-centre read, still under its own sequence.
  assert.match(pageJs, /const boardRead = readBoard\(\);/, "the names come from the shared deal-room-board read");
  assert.equal((pageJs.match(/client\.getBoard\(/g) || []).length, 1, "the page takes exactly one board read");
  assert.match(pageJs, /const board = await boardRead;/, "Quick add is handed that one read");
  assert.match(pageJs, /boardSequence/, "the board read has its own sequence");
  assert.match(pageJs, /acceptsResponse\(view\.boardSequence, sequence\)/, "a late board answer is discarded");
  assert.match(pageJs, /records: view\.records/);
  assert.doesNotMatch(pageJs, /records:\s*\[\]/, "Quick add is given the records the page already holds");
  const loadBody = pageJs.slice(pageJs.indexOf("async function load()"), pageJs.indexOf("async function loadBoardRecords"));
  assert.doesNotMatch(loadBody, /getBoard|loadBoardRecords/, "the board read is not chained behind the command-centre read");

  // And the guard itself refuses a stale sequence, which is what makes the
  // wiring above mean anything.
  assert.equal(acceptsResponse(3, 2), false, "a board answer from an older read is dropped");
  assert.equal(acceptsResponse(3, 3), true);
});

test("an unread or failed board read leaves Quick add with an empty record list rather than guessed names", () => {
  // Nothing read yet, and a read that threw, are the same thing here: no names.
  for (const records of [[], quickAddRecords(null), quickAddRecords(undefined)]) {
    const parsed = parseQuickAdd("Call about Demo Gulf Breeze Dental friday", { now: Date.parse("2026-09-16T14:00:00Z"), viewer: "joe", records });
    assert.equal(parsed.related, null, "an unread board names no record, and nothing is guessed from capitalisation");
    assert.equal(parsed.relatedId, null);
    assert.deepEqual([...parsed.relatedCandidates], []);
  }

  // The failure is swallowed on the page: the board's error text never reaches
  // a reader whose command-centre read succeeded.
  assert.match(pageJs, /catch \{\s*records = Object\.freeze\(\[\]\);/, "a failed board read falls back to an empty list");
  assert.doesNotMatch(pageJs.slice(pageJs.indexOf("async function loadBoardRecords"), pageJs.indexOf("function settle(")), /setStatus|announce|showToast/, "a failed board read paints no error on the page");
});

test("Home's Quick add renders the ambiguity question from its own read", () => {
  // Two board deals whose names the same sentence answers. The page resolves
  // neither and says so in the Related row it already has.
  const records = [
    { id: "deal-1", name: "Demo Crestview Derm" },
    { id: "deal-2", name: "Demo Crestview Derm Suite 200" },
  ];
  const parsed = parseQuickAdd("Book the Demo Crestview Derm Suite 200 walkthrough", {
    now: Date.parse("2026-09-16T14:00:00Z"), viewer: "joe", records,
  });
  assert.equal(parsed.related, null);
  assert.deepEqual([...parsed.relatedCandidates], ["Demo Crestview Derm", "Demo Crestview Derm Suite 200"]);
  assert.ok(parsed.questions.some((question) => question.startsWith("Which record is this about:")));

  // The Related row is the one that says it, in the markup Home already has,
  // with every candidate escaped and no new class or style.
  assert.match(pageJs, /Two records match, say which:/, "the ambiguity is named in words, not left blank");
  assert.match(pageJs, /function relatedCell\(parsed\)/);
  assert.match(pageJs, /candidates\.map\(\(name\) => escapeHtml\(name\)\)/, "a candidate name is escaped like every other read value");
  assert.match(pageJs, /<div><span>Related<\/span>\$\{relatedCell\(effective\)\}<\/div>/, "the existing Related row carries it");
  assert.doesNotMatch(css, /ambigu/i, "no new CSS was needed");
});

/* ------------------------------------------------ This week (today-triage) */

const TODAY = "2026-09-24";
const triageItem = (row) => ({
  item_kind: "critical_date", id: "cd-1", subject_type: "deal", subject_id: "deal-1", owner: null,
  what: "lease_expiration", due_on: TODAY, subject_name: "Demo Gulf Breeze Dental", subject_ref: "C-0001",
  business_days_overdue: 0, ...row,
});
const TRIAGE = {
  items: [
    triageItem({ id: "cd-1", what: "lease_expiration: renewal notice", due_on: "2026-09-26" }),
    triageItem({ id: "cd-2", what: "loi_expiry", due_on: "2026-10-04" }),
    triageItem({ item_kind: "next_action", id: "na-1", owner: "dell", what: "Send the survey reminder", due_on: "2026-09-21", subject_name: "Demo Pace Pediatrics", subject_ref: "L-0042" }),
    // node-pg hands a DATE column over as a Date, which JSON writes as a timestamp.
    triageItem({ item_kind: "post_call_action", id: "pca-1", owner: "joe", what: "Send the LOI draft", due_on: "2026-09-24T00:00:00.000Z", subject_name: "Demo Navarre Ortho", subject_ref: null }),
    triageItem({ item_kind: "ingest", id: "in-1", subject_type: "inbox", what: "email item awaiting triage", due_on: "2026-09-20", subject_name: null, subject_ref: null }),
    triageItem({ id: "cd-3", what: "option_window", due_on: "2026-09-30" }),
  ],
};

test("This week is the dated work due in the next seven days, overdue first, and nothing from the inbox", () => {
  const week = thisWeekView(TRIAGE, { today: TODAY });
  assert.equal(week.state, "read");
  assert.deepEqual(week.rows.map((row) => row.id), ["na-1", "pca-1", "cd-1", "cd-3"], "ordered by due date; the 4 Oct date and the inbox item are not this week");
  const [overdue, today, soon, edge] = week.rows;
  assert.deepEqual([overdue.kind, overdue.kindLabel, overdue.owner, overdue.due, overdue.offset, overdue.overdue], ["next_action", "Follow-up", "dell", "2026-09-21", -3, true]);
  assert.deepEqual([today.kindLabel, today.due, today.offset, today.overdue, today.ref], ["After the call", "2026-09-24", 0, false, null]);
  assert.deepEqual([soon.kindLabel, soon.what, soon.subject, soon.ref, soon.owner], ["Critical date", "lease_expiration: renewal notice", "Demo Gulf Breeze Dental", "C-0001", null]);
  assert.equal(edge.due, "2026-09-30", "the seventh day is still this week");
  assert.equal(week.overdue, 1);
  assert.equal(week.capped, false);
});

test("This week refuses a read it cannot read, and says when the verb's own row cap may have cut it short", () => {
  for (const payload of [null, undefined, "items", [], { items: "none" }, { rows: [] }]) {
    assert.equal(thisWeekView(payload, { today: TODAY }).state, "unavailable", `${JSON.stringify(payload)} is not a verified read`);
  }
  assert.equal(thisWeekView({ items: [triageItem({ due_on: "soon" })] }, { today: TODAY }).state, "unavailable", "an in-scope row with no readable date is not guessed at");
  assert.equal(thisWeekView({ items: [triageItem({ id: null })] }, { today: TODAY }).state, "unavailable", "a row with no identity is not shown");
  assert.equal(thisWeekView(TRIAGE, { today: "Thursday" }).state, "unavailable", "no clock, no week");
  const empty = thisWeekView({ items: [] }, { today: TODAY });
  assert.deepEqual([empty.state, empty.rows.length], ["read", 0], "a verified read with nothing dated is an empty week, not an outage");
  assert.equal(TRIAGE_ROW_CAP, 50, "today-triage stops at 50 rows");
  const full = { items: Array.from({ length: TRIAGE_ROW_CAP }, (_, index) => triageItem({ item_kind: "ingest", id: `in-${index}`, due_on: "2026-09-01" })) };
  assert.equal(thisWeekView(full, { today: TODAY }).capped, true, "a full page means later dates may be missing, and the section says so");
});

test("each due date is said in words, and the week rail counts the same rows the list shows", () => {
  assert.equal(dueWords(-3), "3 days overdue");
  assert.equal(dueWords(-1), "1 day overdue");
  assert.equal(dueWords(0), "Due today");
  assert.equal(dueWords(1), "Due tomorrow");
  assert.equal(dueWords(5), "Due in 5 days");
  const rail = weekRail(thisWeekView(TRIAGE, { today: TODAY }).rows, TODAY);
  assert.equal(rail.overdue, 1);
  assert.equal(rail.days.length, 7);
  assert.deepEqual(rail.days.map((day) => day.day), ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(rail.days.map((day) => day.count), [1, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(rail.days.map((day) => day.label), ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
  assert.equal(rail.days[0].today, true);
  assert.equal(rail.days.filter((day) => day.today).length, 1);
  assert.deepEqual(weekRail([], "never"), { overdue: 0, days: [] }, "no clock, no rail");
});

/* ------------------------------------------- Waiting on others (loop-board) */

const boardRow = (row) => ({
  number: "204", kind: "open_loop", domain: "deals", status: "open", owner: "dell", marker: "none",
  title: "Demo Pace Pediatrics: confirm the survey window", label: "Demo Pace Pediatrics: confirm the survey window",
  joint_owner: false, blocker_class: "counterparty", blocker_detail: "Demo Coastal Surveying has not offered a window since Monday",
  since_text: "open 3 days", due_on: null, version: 1, ...row,
});

test("Waiting on others is the partnership's open work blocked on someone outside, from the fixture's own board", async () => {
  const fixture = await fixtureClient();
  const payload = await fixture.loopBoard({ kind: "open_loop", status: "open", blocker: "counterparty", limit: WAITING_ROW_CAP });
  const waiting = waitingView(payload, { today: TODAY });
  assert.equal(waiting.state, "read");
  assert.deepEqual(waiting.rows.map((row) => [row.number, row.owner, row.waitingOn]), [["204", "dell", "Demo Coastal Surveying has not offered a window since Monday"]]);
  assert.equal(waiting.held, 0);
  assert.equal(waiting.capped, false);
});

test("Waiting on others keeps only counterparty blocks, sets system and joint rows aside, and orders overdue follow-ups first", () => {
  const payload = {
    count: 5,
    loops: [
      boardRow({ number: "210", due_on: null }),
      boardRow({ number: "211", owner: "joe", due_on: "2026-09-22" }),
      boardRow({ number: "212", blocker_class: "human_only", blocker_detail: "Joe does this personally" }),
      boardRow({ number: "213", owner: "claude" }),
      boardRow({ number: "214", owner: "joe/dell", joint_owner: true }),
      boardRow({ number: "215", version: undefined }),
      boardRow({ number: "216", owner: "joe", due_on: "2026-09-25" }),
    ],
  };
  const waiting = waitingView(payload, { today: TODAY });
  assert.deepEqual(waiting.rows.map((row) => row.number), ["211", "216", "210"], "overdue, then soonest follow-up, then undated");
  assert.equal(waiting.rows[0].overdue, true);
  assert.equal(waiting.rows[0].offset, -2);
  assert.equal(waiting.rows[2].offset, null, "an undated wait has no offset, not a zero");
  assert.equal(waiting.held, 2, "a system-owned or jointly owned wait is counted, not dropped");
  for (const bad of [null, { loops: [] }, { count: 1 }, { count: -1, loops: [] }, []]) {
    assert.equal(waitingView(bad, { today: TODAY }).state, "unavailable", `${JSON.stringify(bad)} is not a verified read`);
  }
  assert.equal(WAITING_ROW_CAP, 300, "loop-board's own ceiling");
  assert.equal(waitingView({ count: WAITING_ROW_CAP, loops: [] }, { today: TODAY }).capped, true);
});

/* ------------------------------------------------------------ ambient + motion */

test("each section's orb breathes from its own data: urgent when overdue, attention when due within a day, calm otherwise", () => {
  assert.equal(sectionPulse({ state: "loading", rows: [] }), "refreshing");
  assert.equal(sectionPulse({ state: "unavailable", rows: [] }), "unknown");
  assert.equal(sectionPulse({ state: "read", rows: [] }), "still", "nothing due is stillness, not health");
  assert.equal(sectionPulse({ state: "read", rows: [{ offset: 4, overdue: false }] }), "healthy");
  assert.equal(sectionPulse({ state: "read", rows: [{ offset: 1, overdue: false }] }), "attention");
  assert.equal(sectionPulse({ state: "read", rows: [{ offset: null, overdue: false }] }), "healthy");
  assert.equal(sectionPulse({ state: "read", rows: [{ offset: 3, overdue: false }, { offset: -1, overdue: true }] }), "urgent");
  assert.equal(sectionPulse(null), "unknown");
});

test("a count climbs to its value in frames, and lands at once when motion is reduced", () => {
  const frames = countFrames(0, 7, { reduced: false });
  assert.ok(frames.length > 1, "full motion counts up");
  assert.equal(frames.at(-1), 7, "and always lands on the read value");
  for (let index = 1; index < frames.length; index += 1) assert.ok(frames[index] >= frames[index - 1], "never counts backwards on the way up");
  assert.ok(frames.every(Number.isInteger));
  assert.deepEqual(countFrames(0, 7, { reduced: true }), [7], "reduced motion paints the final value and nothing else");
  assert.deepEqual(countFrames(4, 4, { reduced: false }), [4], "an unchanged value does not animate");
  assert.equal(countFrames(9, 2, { reduced: false }).at(-1), 2, "a falling count lands too");
});

test("the page reads the two verbs alongside the command centre, each under its own sequence, and never chains them", () => {
  assert.equal((pageJs.match(/client\.todayTriage\(\)/g) || []).length, 1, "one triage read");
  assert.equal((pageJs.match(/client\.loopBoard\(\{ kind: "open_loop", status: "open", blocker: "counterparty", limit: WAITING_ROW_CAP \}\)/g) || []).length, 1, "one waiting read, filtered server-side");
  assert.match(pageJs, /acceptsResponse\(view\.weekSequence, sequence\)/, "a late triage answer is dropped");
  assert.match(pageJs, /acceptsResponse\(view\.waitingSequence, sequence\)/, "a late board answer is dropped");
  const loadBody = pageJs.slice(pageJs.indexOf("async function load()"), pageJs.indexOf("async function loadBoardRecords"));
  assert.doesNotMatch(loadBody, /todayTriage|loopBoard/, "the section reads are not chained behind the command-centre read");
  assert.match(pageJs, /function readSections\(\)/, "one place starts both section reads");
  assert.match(pageJs, /\$\("retryRead"\)\?\.addEventListener\("click", \(\) => \{ load\(\); readSections\(\); \}\)/, "Retry re-reads every section, not only the counts");
  // A failed section read shows that section as unverified and nothing else.
  assert.match(pageJs, /thisWeekView\(view\.week\.payload, \{ today: localDay\(\) \}\)/, "the week is recomputed against today's clock, not the clock of the read");
});

test("the live client sends today-triage through the pinned MCP seam, and the fixture derives it from its own records", async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ items: [] }) }] } }), { status: 200 });
  } });
  assert.deepEqual(await live.todayTriage(), { items: [] });
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].body.params.name, "today-triage");
  assert.deepEqual(calls[0].body.params.arguments, {}, "the verb takes no arguments, so none are sent");

  const fixture = await fixtureClient();
  const before = await fixture.todayTriage();
  assert.equal(thisWeekView(before, { today: TODAY }).state, "read", "the fixture answers in the verb's own shape");
  const deal = (await fixture.getBoard()).deals[0];
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await fixture.addCriticalDate({ deal: deal.id, kind: "lease_expiration", due_on: inTwoDays, source: "Demo lease abstract", idempotency_key: "11111111-1111-4111-8111-111111111111" });
  const after = await fixture.todayTriage();
  const added = after.items.find((item) => item.item_kind === "critical_date" && item.subject_id === deal.id);
  assert.ok(added, "a critical date written through the fixture appears in its triage read");
  assert.equal(added.what, "lease_expiration");
  assert.equal(added.subject_name, deal.name);
  assert.ok(after.items.every((item) => item.subject_name === null || String(item.subject_name).startsWith("Demo ")), "synthetic names only");
});

test("today-triage is pinned in the CARR interface as an additive minor bump", () => {
  assert.ok(carrInterface.mcp_operations.includes("today-triage"));
  assert.ok(carrInterface.mcp_operations.includes("loop-board"));
  assert.deepEqual([...carrInterface.mcp_operations], [...carrInterface.mcp_operations].sort(), "the list stays alphabetical");
  assert.equal(carrInterface.version, "1.24.0");
  assert.equal(carrInterface.mcp_operations.length, 61);
});

test("Home enters in a stagger under a second, answers hover and press, and draws its ambient life from shared keyframes", () => {
  assert.doesNotMatch(css, /@keyframes/, "no page-local keyframes: the shared ones are reused");
  const home = css.slice(css.indexOf("/* V5-UX-B01 Home motion"));
  assert.ok(home.length > 0 && css.includes("/* V5-UX-B01 Home motion"), "the Home motion block exists");
  assert.match(home, /#panelHome > \.card \{[^}]*animation: receipt-in var\(--motion-enter\) var\(--ease\) backwards/, "cards enter with the shared receipt-in");
  const delays = [...home.matchAll(/animation-delay: (\d+)ms/g)].map((match) => Number(match[1]));
  assert.ok(delays.length >= HOME_SECTIONS.length - 1, "each card after the first has its own delay");
  assert.ok(Math.max(...delays) + 270 < 1000, "the whole entrance finishes inside a second");
  assert.match(home, /\.home-row:hover \{[^}]*transform: translateY\(-2px\)/, "a row lifts under the cursor");
  assert.match(home, /\.home-open:active \{[^}]*transform: scale\(0\.97\)/, "an Open link presses");
  assert.match(home, /\[data-enter="true"\] \{[^}]*animation: receipt-in/, "a changed row or state enters rather than cutting in");
  assert.match(home, /\.week-day\[data-today="true"\][^{]*\{[^}]*animation: breathe var\(--motion-calm\)/, "today breathes on the week rail");
  assert.match(home, /\.week-day\[data-overdue="true"\][^{]*\{[^}]*animation: breathe var\(--motion-urgent\)/, "an overdue marker breathes at the urgent pace");
  assert.match(pageJs, /class="flow-path"/, "a waiting row carries the shared flowing connector");
  for (const name of [...home.matchAll(/animation: ([a-z-]+) /g)].map((match) => match[1])) {
    assert.match(systemCss, new RegExp(`@keyframes ${name} `), `${name} is a shared keyframe`);
  }
  assert.match(pageJs, /sectionPulse\(/, "the orbs are driven by the data, not by a timer");
  assert.match(pageJs, /function paintIfChanged\(/, "a section only re-enters when what it shows changed");
});

test("reduced motion: every Home effect has a static fallback that keeps all content visible", () => {
  const home = css.slice(css.indexOf("/* V5-UX-B01 Home motion"));
  // The page's own floor, for the one thing the shared floor does not stop: a
  // hover transform that would still jump without its transition.
  assert.match(home, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.home-row:hover[^}]*transform: none/);
  assert.match(home, /:root\[data-motion="reduced"\] #panelHome \.home-row:hover[^{]*\{[^}]*transform: none/);
  assert.match(systemCss, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/, "the shared floor stops every animation");

  // Force the fallback: drop every animation and transition declaration, which
  // is exactly what the floor does, and measure what each Home rule leaves.
  const rules = [...home.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
  const motionRules = rules.filter((rule) => /#panelHome|\.home-|\.week-|\[data-enter/.test(rule.selector));
  assert.ok(motionRules.length >= 6);
  for (const { selector, body } of motionRules) {
    const settled = body.split(";").map((part) => part.trim()).filter((part) => part && !/^(animation|transition)/.test(part));
    for (const declaration of settled) {
      assert.doesNotMatch(declaration, /^opacity:\s*0(?:\.0+)?$/, `${selector} leaves content invisible without motion`);
      assert.doesNotMatch(declaration, /^visibility:\s*hidden/, `${selector} hides content`);
      assert.doesNotMatch(declaration, /^display:\s*none/, `${selector} removes content`);
      assert.doesNotMatch(declaration, /^transform:.*scale\(0\)/, `${selector} collapses content`);
    }
  }
  // The entrance keyframe starts hidden, so it may only run with a backwards
  // fill: with the animation removed the card is simply where it rests.
  assert.match(systemCss, /@keyframes receipt-in \{ from \{ opacity: 0;[^}]*\} to \{ opacity: 1; transform: none; \} \}/);

  // The count-up is script, so the script honours both the setting and the OS.
  assert.match(pageJs, /document\.documentElement\.dataset\.motion === "reduced"/);
  assert.match(pageJs, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(pageJs, /countFrames\([^)]*\{ reduced: motionReduced\(\) \}\)/, "the count-up asks before it animates");
});
