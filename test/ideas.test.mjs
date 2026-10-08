import { hasArtifactPage } from "./artifact-pages-fixture.mjs";
// V5-UX-B04 — Ideas and Events browse/detail.
//
// Ideas are real records: a loop of kind `idea` (add-loop parks one), read with
// `loop-board` and, one at a time, `read-loop` — both already pinned for Tasks.
// Events use CARR's tenant-scoped industry-event read and versioned writes.
// These tests pin both halves, the URL memory, and motion's reduced-motion floor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  IDEA_BOARD_ARGS, filterIdeas, ideaDetailRows, ideaReadState, ideasHref, ideasPhase,
  normalizeIdea, parseIdeasState, validIdeaBoard,
  eventReadState, eventPhase, eventWriteRequest, eventWriteOutcome, eventChangedFields,
  EVENT_LIST_LIMIT,
} from "../js/ideas-model.js";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

// The summary row loop-board returns (mcp-server/src/tools.js, `summary: true`).
const summaryRow = (overrides = {}) => ({
  number: "12", kind: "idea", owner: "joe", label: "Referral lunch series for Baldwin County dentists",
  blocker_class: null, since_text: "since Aug", due_on: null, version: 3, ...overrides,
});

/* ------------------------------------------------------------------ the list */

test("the board read asks for open ideas in the compact summary shape", () => {
  assert.deepEqual(IDEA_BOARD_ARGS, { kind: "idea", status: "open", limit: 300, summary: true });
});

test("a board answer without a loops array is refused, not shown as no ideas", () => {
  assert.equal(validIdeaBoard({ loops: [] }), true);
  assert.equal(validIdeaBoard({ loops: "none" }), false);
  assert.equal(validIdeaBoard(null), false);
});

test("a summary row becomes an idea; a row with no number is dropped because it cannot be opened", () => {
  assert.deepEqual(normalizeIdea(summaryRow()), {
    number: "12", label: "Referral lunch series for Baldwin County dentists", owner: "joe",
    since_text: "since Aug", due_on: null, version: 3,
  });
  assert.equal(normalizeIdea(summaryRow({ label: "" })).label, "Untitled idea");
  assert.equal(normalizeIdea(summaryRow({ due_on: "2026-10-02T00:00:00.000Z" })).due_on, "2026-10-02");
  assert.equal(normalizeIdea(summaryRow({ number: null })), null);
  assert.equal(normalizeIdea(summaryRow({ kind: "open_loop" })), null, "only ideas belong on this page");
  assert.equal(normalizeIdea("idea"), null);
});

test("the filter matches words in the label, the number and the owner, case-insensitively", () => {
  const rows = [normalizeIdea(summaryRow()), normalizeIdea(summaryRow({ number: "40", label: "Podcast with Dr. Lee", owner: "dell" }))];
  assert.deepEqual(filterIdeas(rows, "baldwin").map((row) => row.number), ["12"]);
  assert.deepEqual(filterIdeas(rows, "#40").map((row) => row.number), ["40"]);
  assert.deepEqual(filterIdeas(rows, "DELL").map((row) => row.number), ["40"]);
  assert.deepEqual(filterIdeas(rows, "  ").map((row) => row.number), ["12", "40"]);
  assert.deepEqual(filterIdeas(rows, "nothing like it"), []);
});

test("the page states are distinct: loading, ended session, unreadable, empty, no match, ready", () => {
  assert.equal(ideasPhase({ status: "loading" }), "loading");
  assert.equal(ideasPhase({ status: "unauthorized" }), "unauthorized");
  assert.equal(ideasPhase({ status: "error" }), "unavailable");
  assert.equal(ideasPhase({ status: "ready", rows: [], shown: [] }), "empty");
  assert.equal(ideasPhase({ status: "ready", rows: [{}], shown: [] }), "no_match");
  assert.equal(ideasPhase({ status: "ready", rows: [{}], shown: [{}] }), "ready");
});

/* ---------------------------------------------------------------- the detail */

const fullLoop = {
  loop_id: "6b2d…", kind: "idea", number: "12", domain: "marketing", status: "open",
  title: null, body: "Host a quarterly lunch.\nInvite the three referral partners.", owner: "joe",
  since_text: "since Aug", source_note: "Joe, voice memo", due_on: null, version: 3,
  created_at: "2026-08-04T14:12:00.000Z", updated_at: "2026-08-09T10:00:00.000Z",
};

test("a fresh read-loop answer opens the idea; a miss, an ambiguity and a wrong kind are each named", () => {
  assert.deepEqual(ideaReadState({ loop: fullLoop }), { state: "ready", loop: fullLoop });
  assert.deepEqual(ideaReadState({ error: "not_found" }), { state: "not_found" });
  assert.deepEqual(ideaReadState({ error: "ambiguous_number", candidates: [] }), { state: "ambiguous" });
  assert.deepEqual(ideaReadState({ loop: { ...fullLoop, kind: "open_loop" } }), { state: "not_found" }, "a number that names a task is not this idea");
  assert.deepEqual(ideaReadState(null), { state: "unavailable" });
});

test("the detail distinguishes a recorded value from one that was never recorded", () => {
  const rows = ideaDetailRows(fullLoop);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(byLabel.Number.text, "#12");
  assert.equal(byLabel.Owner.text, "Joe");
  assert.equal(byLabel.Domain.text, "Marketing");
  assert.equal(byLabel.Reference.text, "Joe, voice memo");
  assert.equal(byLabel.Due.known, false, "no due date is 'not recorded', never a blank or 'none'");
  assert.equal(byLabel.Due.text, "not recorded");
  assert.equal(byLabel.Opened.known, true);
  assert.match(byLabel.Opened.text, /Aug 4, 2026/);
});

/* ------------------------------------------------------------------ the URL */

test("the address remembers the tab, the search and the open idea", () => {
  assert.deepEqual(parseIdeasState(""), { tab: "ideas", q: "", idea: null });
  const state = parseIdeasState("?tab=events&q=lunch&idea=12");
  assert.deepEqual(state, { tab: "events", q: "lunch", idea: "12" });
  assert.equal(ideasHref({ tab: "ideas", q: "lunch", idea: "12" }), "/ideas-events?tab=ideas&q=lunch&idea=12");
  assert.equal(ideasHref({ tab: "ideas", q: "", idea: null }), "/ideas-events?tab=ideas");
  assert.deepEqual(parseIdeasState("?tab=nope&idea=%3Cscript%3E"), { tab: "ideas", q: "", idea: null }, "an idea number is digits only");
});

/* --------------------------------------------------------------- the events */

test("the event read distinguishes zero records from a failed or malformed read and sorts dates", () => {
  assert.deepEqual(eventReadState({ ok: true, events: [], count: 0 }), { status: "ready", rows: [] });
  assert.equal(eventPhase({ status: "ready", rows: [] }), "empty");
  assert.equal(eventPhase({ status: "error", rows: [] }), "unavailable");
  assert.equal(eventPhase({ status: "unauthorized", rows: [] }), "unauthorized");
  assert.equal(eventReadState({ ok: true, count: 0 }).status, "error");
  assert.equal(eventReadState({ ok: false, events: [], count: 0 }).status, "error");
  const events = [
    { id: "later", title: "Later", starts_at: "2026-11-12T15:00:00Z", ends_at: "2026-11-12T19:00:00Z", source: "Association calendar", owner_partner: "dell", version: 2 },
    { id: "sooner", title: "Sooner", starts_at: "2026-10-02T15:00:00Z", ends_at: "2026-10-02T19:00:00Z", source: "Organizer site", owner_partner: "joe", version: 1 },
  ];
  assert.deepEqual(eventReadState({ ok: true, events, count: 2 }).rows.map(row => row.id), ["sooner", "later"]);
  assert.equal(eventPhase({ status: "ready", rows: events }), "ready");
});

test("a full event page is explicitly partial because CARR provides no next page", () => {
  assert.equal(EVENT_LIST_LIMIT, 100, "request the producer's maximum before declaring a list complete");
  const event = (index) => ({ id: `event-${index}`, title: `Event ${index}`,
    starts_at: "2026-10-02T15:00:00Z", ends_at: "2026-10-02T19:00:00Z",
    source: "Organizer", owner_partner: "joe", version: 1 });
  const belowLimit = eventReadState({ ok: true, events: Array.from({ length: 99 }, (_, i) => event(i)), count: 99 });
  assert.equal(eventPhase(belowLimit), "ready");
  const atLimit = eventReadState({ ok: true, events: Array.from({ length: 100 }, (_, i) => event(i)), count: 100 });
  assert.equal(eventPhase(atLimit), "partial");
  assert.equal(atLimit.rows.length, 100, "a partial answer still shows all returned events");
  assert.equal(eventPhase(eventReadState({ ok: true, events: [], count: 0 })), "empty");
});

test("the event form sends sourced, timezone-bearing data and preserves the read version for edits", () => {
  const fields = { title: " Gulf Coast Forum ", organizer: " Dental Association ", kind: "conference",
    starts_at: "2026-10-02T09:00", ends_at: "2026-10-02T17:00", location: " Mobile ",
    is_virtual: false, url: "https://example.org/forum", relevance_note: "Meet practice owners",
    attendance_intent: "considering", owner_partner: "joe", status: "planned", source: " Organizer calendar " };
  const add = eventWriteRequest(fields);
  assert.equal(add.ok, true);
  assert.equal(add.args.title, "Gulf Coast Forum");
  assert.equal(add.args.source, "Organizer calendar");
  assert.match(add.args.starts_at, /Z$/);
  assert.equal(Date.parse(add.args.ends_at) > Date.parse(add.args.starts_at), true);
  const edit = eventWriteRequest(fields, { id: "event-1", version: 7 });
  assert.equal(edit.ok, true);
  assert.equal(edit.args.event_id, "event-1");
  assert.equal(edit.args.base_version, 7);
  assert.equal(eventWriteRequest({ ...fields, ends_at: fields.starts_at }).ok, false);
  assert.equal(eventWriteRequest({ ...fields, source: " " }).ok, false);
});

test("refused writes and version conflicts leave the draft available for correction", () => {
  assert.equal(eventWriteOutcome({ payload: { error: "industry_event_version_conflict" } }), "conflict");
  assert.equal(eventWriteOutcome({ payload: { error: "industry_event_text_invalid" } }), "refused");
  assert.equal(eventWriteOutcome({ status: 403 }), "unauthorized");
  assert.equal(eventWriteOutcome({ status: 502 }), "unknown");
});

test("a version conflict names the server fields that changed before a draft can be reapplied", () => {
  const before = { title: "Forum", source: "Organizer", owner_partner: "joe", version: 1 };
  const latest = { ...before, title: "Forum moved", owner_partner: "dell", version: 2 };
  assert.deepEqual(eventChangedFields(before, latest), [
    { field: "title", label: "Event name", value: "Forum moved" },
    { field: "owner_partner", label: "Owner", value: "dell" },
  ]);
  assert.equal(before.title, "Forum", "a conflict does not mutate the partner's original view or draft");
});

/* ------------------------------------------------------------------ the page */

test("the Ideas page is routed and uses the pinned idea and event verbs", async () => {
  const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
  const carr = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.equal(routes.routes["/ideas-events"], "ideas.html");
  assert.equal(carr.version, "1.43.1");
  assert.deepEqual(carr.mcp_operations, [...carr.mcp_operations].sort());
  for (const verb of ["loop-board", "read-loop", "list-industry-events", "add-industry-event", "update-industry-event"]) assert.ok(carr.mcp_operations.includes(verb), verb);
  assert.equal(await hasArtifactPage("ideas.html"), true, "the page ships in the verified artifact");
  assert.match(await read("scripts/check-repository.mjs"), /"ideas\.html"/);
  assert.match(await read("SUMMARY.md"), /ideas\.html/);
  const js = await read("js/ideas.js");
  assert.match(js, /client\.loopBoard\(IDEA_BOARD_ARGS\)/);
  assert.match(js, /client\.readLoop\(/);
  assert.doesNotMatch(js, /addLoop|updateLoop|closeLoop/, "the idea list stays read only");
  assert.match(js, /client\.listIndustryEvents\(/);
  assert.match(js, /mountNotificationBadge\(/);
  assert.match(js, /resolveDealroomBoot/);
  assert.match(js, /history\.(pushState|replaceState)/);
});

test("the Ideas page carries the shared shell, tabs, a detail popup and the Events panel", async () => {
  const html = await read("ideas.html");
  assert.match(html, /<html lang="en" data-theme="dark" data-density="comfortable" data-motion="full">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/ideas\.css">/);
  assert.match(html, /id="appShell"/);
  assert.doesNotMatch(html, /id="docReading"/, "shared Doc presence owns page identity");
  assert.match(html, /<div data-layout-slot="tabs" class="page-views" id="ideaTabs" role="tablist"/);
  assert.match(html, /role="tab"[^>]*>Ideas</);
  assert.match(html, /role="tab"[^>]*>Events</);
  assert.match(html, /<dialog id="ideaDialog" class="dialog"/);
  assert.match(html, /id="ideaSearch"[^>]*type="search"/);
  assert.match(html, /<script type="module" src="\/js\/ideas\.js"><\/script>/);
});

test("Events offers a timeline, sourced cards, and one keyboard-accessible add/edit dialog", async () => {
  const html = await read("ideas.html");
  const js = await read("js/ideas.js");
  assert.match(html, /id="eventTimeline"[^>]*aria-label="Event timeline"/);
  assert.match(html, /<svg[^>]*id="eventTimelineSvg"/);
  assert.match(html, /id="eventState"[^>]*aria-live="polite"/);
  assert.match(html, /id="eventList"/);
  assert.match(html, /id="eventAdd"/);
  assert.match(html, /<dialog id="eventDialog"/);
  for (const name of ["title", "organizer", "kind", "starts_at", "ends_at", "source", "owner_partner"])
    assert.match(html, new RegExp(`name="${name}"`));
  assert.match(js, /client\.listIndustryEvents\(/);
  assert.match(js, /client\.addIndustryEvent\(/);
  assert.match(js, /client\.updateIndustryEvent\(/);
  assert.match(js, /eventWriteOutcome\(/);
  assert.match(html, /id="eventConflict"/);
});

/* ---------------------------------------------------------------- motion */

const css = await read("css/ideas.css");

test("idea tiles enter on a stagger, lift and tilt under the pointer and press down", () => {
  assert.match(css, /\.idea-tile \{[^}]*animation: receipt-in var\(--motion-enter\) var\(--ease\) backwards/);
  assert.match(css, /animation-delay: var\(--stagger, 0ms\)/);
  assert.match(css, /\.idea-tile:hover[^{]*\{[^}]*transform:[^;]*rotateX/, "a depth response on hover");
  assert.match(css, /\.idea-tile:active \{[^}]*transform: (?!none)/, "the full-motion press, not the reduced-motion reset");
  const durations = [...css.matchAll(/var\((--motion-[a-z]+)\)/g)].map((match) => match[1]);
  for (const token of durations) assert.match(token, /^--motion-(calm|attention|urgent|flow|enter|move|ring|toast)$/);
});

test("reduced motion: forcing the fallback leaves every idea visible and removes the tilt", () => {
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(block, /transform: none/);
  assert.match(css, /:root\[data-motion="reduced"\] \.idea-tile:hover/);
  const forced = css
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "")
    .replace(/(?:animation|transition)(?:-[a-z]+)?\s*:[^;}]+;?/g, "");
  for (const [, selector, body] of forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/idea|event/.test(selector) || /\[hidden\]/.test(selector)) continue;
    assert.doesNotMatch(body, /opacity:\s*0(?![.\d])|visibility:\s*hidden|transform:\s*scale\(0\)/, `${selector.trim()} hides content once motion is gone`);
  }
});

test("event motion has a reduced-motion fallback and a narrow-screen layout", () => {
  assert.match(css, /\.event-timeline.*animation:/s);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.event-/);
  assert.match(css, /:root\[data-motion="reduced"\] \.event-/);
});

test("a phone can reach every timeline node when the SVG exceeds the viewport", async () => {
  assert.match(css, /\.event-timeline\s*\{[^}]*overflow-x:\s*auto;/,
    "the rail scrolls horizontally instead of clipping later nodes");
  assert.doesNotMatch(css, /\.event-timeline\s*\{[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.event-timeline\s*\{[^}]*overscroll-behavior-inline:/,
    "touch swipes stay within the timeline");
  assert.match(await read("js/ideas.js"), /Math\.max\(320, rows\.length \* 126/,
    "four nodes still get their full width instead of being compressed into 390 px");
});

test("Ideas search field shrinks inside its card at phone width", async () => {
  const sheet = await read("css/ideas.css");
  const searchRule = sheet.match(/\.idea-search\s*\{[^}]*\}/)?.[0] || "";
  assert.ok(searchRule.includes("min-width: 0"), "the field must start from a zero floor");
  assert.ok(searchRule.includes("max-width: 100%"), "the field cannot exceed its card");
  assert.ok(!searchRule.includes("min(320px"), "a 320px floor overflows a padded phone-width card");
  const inputRule = sheet.match(/\.idea-search input\s*\{[^}]*\}/)?.[0] || "";
  assert.ok(inputRule.includes("width: 100%"), "the input fills the field instead of overflowing");
  assert.ok(inputRule.includes("min-width: 0"), "the input can shrink with the field");
});
