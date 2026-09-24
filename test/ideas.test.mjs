// V5-UX-B04 — Ideas and Events browse/detail.
//
// Ideas are real records: a loop of kind `idea` (add-loop parks one), read with
// `loop-board` and, one at a time, `read-loop` — both already pinned for Tasks.
// Events have NO record-layer read today, so the Events tab is an honest absent
// state that sends no request. These tests pin both halves, the URL memory,
// and the motion rule 9293d609 with its reduced-motion fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  EVENTS_ABSENT, IDEA_BOARD_ARGS, filterIdeas, ideaDetailRows, ideaReadState, ideasHref, ideasPhase,
  normalizeIdea, parseIdeasState, validIdeaBoard,
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
  assert.equal(byLabel.Source.text, "Joe, voice memo");
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
  assert.equal(ideasHref({ tab: "ideas", q: "lunch", idea: "12" }), "/ideas?tab=ideas&q=lunch&idea=12");
  assert.equal(ideasHref({ tab: "ideas", q: "", idea: null }), "/ideas?tab=ideas");
  assert.deepEqual(parseIdeasState("?tab=nope&idea=%3Cscript%3E"), { tab: "ideas", q: "", idea: null }, "an idea number is digits only");
});

/* -------------------------------------------------------------- the events gap */

test("Events is an honest absent state: it names the missing read and sends no request", async () => {
  assert.match(EVENTS_ABSENT, /no record-layer read returns events/i);
  const js = await read("js/ideas.js");
  assert.doesNotMatch(js, /eventBoard|listEvents|read-events|eventsRead/, "no invented events read");
  const html = await read("ideas.html");
  assert.match(html, /id="eventsPanel"/);
});

/* ------------------------------------------------------------------ the page */

test("the Ideas page is routed, shipped, read-only and reads only pinned verbs", async () => {
  const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
  const carr = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.equal(routes.routes["/ideas"], "ideas.html");
  for (const verb of ["loop-board", "read-loop"]) assert.ok(carr.mcp_operations.includes(verb), verb);
  assert.match(await read("scripts/artifact.mjs"), /"ideas\.html"/);
  assert.match(await read("scripts/check-repository.mjs"), /"ideas\.html"/);
  assert.match(await read("SUMMARY.md"), /ideas\.html/);
  const js = await read("js/ideas.js");
  assert.match(js, /client\.loopBoard\(IDEA_BOARD_ARGS\)/);
  assert.match(js, /client\.readLoop\(/);
  assert.doesNotMatch(js, /addLoop|updateLoop|closeLoop|idempotency_key/, "browse only: no write is reachable");
  assert.match(js, /mountNotificationBadge\(/);
  assert.match(js, /resolveDealroomBoot/);
  assert.match(js, /history\.(pushState|replaceState)/);
});

test("the Ideas page carries the shared shell, tabs, a detail popup and the Events panel", async () => {
  const html = await read("ideas.html");
  assert.match(html, /<html lang="en" data-theme="dark" data-density="comfortable" data-motion="full">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/ideas\.css">/);
  assert.match(html, /id="navUnreadBadge" hidden/);
  assert.match(html, /id="docReading">Doc is reading: Ideas</);
  assert.match(html, /<div class="tabs" id="ideaTabs" role="tablist"/);
  assert.match(html, /role="tab"[^>]*>Ideas</);
  assert.match(html, /role="tab"[^>]*>Events</);
  assert.match(html, /<dialog id="ideaDialog" class="dialog"/);
  assert.match(html, /id="ideaSearch"[^>]*type="search"/);
  assert.match(html, /<script type="module" src="\/js\/ideas\.js"><\/script>/);
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
