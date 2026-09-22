import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  HOME_SECTIONS, NOT_IN_RELEASE, SECTION_TITLE, homeSections, needLabel, teamReviewRows, unavailableCopy,
} from "../js/business-workspace-model.js";
import { migratePreferences } from "../js/shell.js";
import { acceptsResponse, quickAddRecordNames, validWorkspacePayload } from "../js/workspace-command-center-model.js";
import { quickAddRecords } from "../js/task-records-model.js";
import { parseQuickAdd } from "../js/visual-system.js";
import { createFixtureClient } from "../js/fixture-client.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFile(`${ROOT}${file}`, "utf8");

const html = await read("business-workspace.html");
const pageJs = await read("js/business-workspace.js");
const shellJs = await read("js/shell.js");
const css = await read("css/business-workspace.css");
const systemCss = await read("css/system.css");
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

test("the three not-in-this-release blocks are literal in the page, not rendered from data", () => {
  for (const title of NOT_IN_RELEASE) {
    assert.ok(html.includes(`<h3>${title}</h3>`), `the page states "${title}" itself`);
    assert.ok(!pageJs.includes(title), `"${title}" is not written by a renderer`);
  }
  assert.equal([...html.matchAll(/data-state="not_in_release"/g)].length, 3);
  // They are permanent scope statements, so the page never asks CARR about them.
  assert.doesNotMatch(pageJs, /this_week|recent_calls|waiting_on/, "no read is issued for a surface this release does not have");
  assert.match(css, /\.state-block\[data-state="not_in_release"\]/, "the permanent state is drawn as its own state");
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
  for (const section of homeSections(null).filter((item) => !item.fromRead)) assert.equal(section.state, "static");
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
