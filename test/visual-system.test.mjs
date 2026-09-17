import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canDispatch, classifyPriority, contrastRatio, createFeedback, feedbackLabel, formatCalendarDate,
  formatClock, formatDueStamp, orderWork, parseQuickAdd, parseTypedDate, preferenceAttributes,
  readTokens, resolvePreferences, transitionFeedback, weekdayName,
} from "../js/visual-system.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const contract = JSON.parse(await read("contracts/visual-system.v1.json"));
const css = await read("css/system.css");
const pages = Object.fromEntries(await Promise.all(Object.entries(contract.prototypes).map(async ([key, file]) => [key, await read(file)])));
const prototypeJs = await read("js/design-prototype.js");
const docDockJs = await read("js/doc-dock.js");
const workInventoryHtml = await read("work-inventory.html");
const tasksHtml = await read("tasks.html");

// Every surface the review covered: the three prototype pages and the product
// surfaces that share the shell. A site-wide rule — a refused phrase, a printed
// clock, Doc's one place, a title with a paragraph under it — is a rule about
// the product, not about one page, so every shipped surface built on the shell
// is checked here.
const SURFACES = {
  "design.html": pages.index,
  "design-business.html": pages.business,
  "design-operations.html": pages.operations,
  "work-inventory.html": workInventoryHtml,
  "tasks.html": tasksHtml,
  "js/design-prototype.js": prototypeJs,
  "js/doc-dock.js": docDockJs,
};

// --------------------------------------------------------------- contract ↔ stylesheet
test("every token the contract names is defined in the dark theme, and every themed token again in the light theme", () => {
  const dark = readTokens(css, ":root {");
  const light = readTokens(css, ':root[data-theme="light"]');
  const named = Object.entries(contract.tokens).filter(([group]) => group !== "themed_in_both").flatMap(([, list]) => list);
  for (const token of named) assert.ok(dark[token], `dark theme is missing ${token}`);
  for (const token of contract.tokens.themed_in_both) {
    assert.ok(light[token], `light theme is missing ${token}`);
    assert.notEqual(light[token], dark[token], `${token} is themed but identical in both themes`);
  }
});

test("both themes clear the contrast floor on every pair the contract lists", () => {
  for (const selector of [":root {", ':root[data-theme="light"]']) {
    const tokens = readTokens(css, selector);
    for (const [fg, bg] of contract.contrast_floor.pairs) {
      const ratio = contrastRatio(tokens[fg], tokens[bg]);
      assert.ok(ratio >= contract.contrast_floor.ratio, `${selector} ${fg} on ${bg} is ${ratio}:1`);
    }
  }
});

test("every component selector and state the contract names exists in the stylesheet", () => {
  for (const [name, component] of Object.entries(contract.components)) {
    for (const selector of [...component.selectors, ...component.states]) {
      assert.ok(css.includes(selector), `${name}: ${selector} is not styled`);
    }
  }
});

test("motion is a state channel with a shape per state, a named duration, and a floor that stops it", () => {
  for (const [state, spec] of Object.entries(contract.motion_states.states)) {
    assert.match(css, new RegExp(`\\.orb\\[data-state="${state}"\\]`), `orb state ${state}`);
    if (spec.duration !== "none") assert.match(css, new RegExp(`\\.orb\\[data-state="${state}"\\][^}]*animation:[^;]*var\\(${spec.duration}\\)`), `${state} animates at ${spec.duration}`);
    else assert.doesNotMatch(css, new RegExp(`\\.orb\\[data-state="${state}"\\][^}]*animation`), `${state} must not animate`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  assert.match(css, /:root\[data-motion="reduced"\] \*[^{]*\{ animation: none !important/);
  for (const token of contract.tokens.motion) assert.ok(css.includes(`${token}:`), `motion token ${token}`);
});

test("motion runs slow and waiting is a ring, not a spinner", () => {
  const tokens = readTokens(css, ":root {");
  const seconds = (value) => (value.endsWith("ms") ? Number.parseFloat(value) / 1000 : Number.parseFloat(value));
  // Roughly 1.5x the durations reviewed on 2026-09-16, with the original
  // proportions kept: calm 3.5s, attention 2s, urgent 1s, flow 8s, enter
  // 180ms, move 250ms.
  for (const [token, before] of [["--motion-calm", 3.5], ["--motion-attention", 2], ["--motion-urgent", 1], ["--motion-flow", 8], ["--motion-enter", 0.18], ["--motion-move", 0.25]]) {
    const after = seconds(tokens[token]);
    assert.ok(Math.abs(after - before * 1.5) < before * 0.1, `${token} is ${tokens[token]}, not about 1.5x ${before}s`);
  }
  assert.doesNotMatch(css, /@keyframes spin\b/, "the spinner is gone");
  assert.doesNotMatch(css, /animation: spin /, "nothing spins");
  assert.match(css, /@keyframes ring-draw/);
  assert.match(css, /\.ring \{[^}]*animation: ring-draw var\(--motion-ring\)/, "the waiting ring draws over --motion-ring");
  assert.match(css, /\.btn\[aria-busy="true"\]::after \{[^}]*animation: ring-draw var\(--motion-ring\)/, "a busy button draws the same ring");
  assert.equal(seconds(tokens["--motion-ring"]), 3, "the ring cycle is about 3 seconds");
  assert.match(css, /:root\[data-motion="reduced"\] \.toast \{ animation: none/, "a reduced-motion toast disappears without animation");
});

test("touch targets, focus and the modal/nonmodal distinction are in the stylesheet", () => {
  assert.match(css, /--touch: 44px/);
  assert.match(css, /\.btn \{[^}]*min-height: var\(--touch\)/);
  assert.match(css, /\.tab \{[^}]*min-height: var\(--touch\)/, "a tab is a full touch target");
  assert.match(css, /\.doc-fab \{[^}]*width: 56px; height: 56px/, "the floating Doc icon is over the 44px floor");
  assert.match(css, /:focus-visible \{ outline: 3px solid var\(--focus\)/);
  assert.match(css, /\.side-panel \{ position: sticky/);
  assert.match(css, /\.dialog::backdrop/);
  assert.equal(contract.accessibility.touch_target_px, 44);
});

// --------------------------------------------------------------- site-wide review rules
test("no refused phrase appears on any surface", () => {
  // Joe's 2026-09-16 review refused these outright: a title that tells a
  // partner what the software thinks they owe, and the words that came with it.
  const banned = [
    "nothing needs you", "one thing is broken", "nothing is stuck", "needs you now", "needs you",
    "why here", "team book", "joe and dell", "tuesday, needs you", "ask doc",
  ];
  for (const [name, source] of Object.entries(SURFACES)) {
    const lower = source.toLowerCase();
    for (const phrase of banned) assert.ok(!lower.includes(phrase), `${name} still contains the refused phrase "${phrase}"`);
    assert.doesNotMatch(source, /\bTODO\b/, `${name} prints TODO; the word is "To do"`);
  }
});

test("every clock time is 12-hour with AM or PM", () => {
  // An ISO timestamp is a machine key, not a printed time, so it is removed
  // before the scan. Everything else that looks like a clock must carry AM/PM.
  const stripIso = (source) => source.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>");
  for (const [name, source] of Object.entries(SURFACES)) {
    for (const match of stripIso(source).matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b(.{0,4})/g)) {
      assert.match(match[1], /^\s*(AM|PM)/, `${name} prints "${match[0].trim()}" without AM or PM`);
    }
  }
});

test("Doc is one floating icon and one chat on every surface, and never a per-tile button", () => {
  for (const [name, html] of Object.entries(SURFACES)) {
    if (!name.endsWith(".html")) continue;
    assert.match(html, /<button class="doc-fab" type="button" id="docFab"/, `${name} floating Doc icon`);
    assert.match(html, /class="doc-chat glass" id="docChat"/, `${name} Doc chat window`);
    assert.match(html, /id="docReading">Doc is reading: /, `${name} names the page Doc is reading`);
    assert.match(html, /id="docMic"[^>]*aria-pressed="false"/, `${name} dictation toggle`);
    assert.match(html, /Dictate with Quill/, `${name} dictation label`);
    assert.doesNotMatch(html, /<button[^>]*>\s*Ask Doc\b/, `${name} still has a per-tile Ask Doc button`);
    assert.doesNotMatch(html, /class="side-panel glass doc-panel"/, `${name} still has the old top-of-page Doc panel`);
    // The floating button is the one Doc entry: the bottom navigation must not
    // duplicate it.
    const mobileNav = /<nav class="mobile-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] || "";
    assert.doesNotMatch(mobileNav, />Doc</, `${name} duplicates Doc in the mobile navigation`);
  }
  assert.doesNotMatch(prototypeJs, /"data-doc"/, "no per-tile Ask Doc wiring remains");
  assert.match(docDockJs, /Prototype reply/, "Doc's prototype answers are marked as prototype answers");
  assert.doesNotMatch(docDockJs, /fetch\(|getUserMedia|SpeechRecognition|MediaRecorder/, "dictation is a prototype toggle: no audio and no network");
});

test("each surface is built from tabs and popups, and no title carries a description paragraph", () => {
  const tabsByPage = {
    "design-business.html": ["Home", "Work", "Pipeline", "Doc history"],
    "design-operations.html": ["Dashboard", "Atlas", "Model Room", "Sessions"],
    "design.html": ["Tokens", "Components", "States", "Rules"],
  };
  for (const [name, labels] of Object.entries(tabsByPage)) {
    const html = SURFACES[name];
    assert.match(html, /<div class="tabs" id="\w+" role="tablist"/, `${name} tab strip`);
    for (const label of labels) assert.match(html, new RegExp(`role="tab"[^>]*>${label}<`), `${name} tab ${label}`);
    assert.match(html, /role="tabpanel"/, `${name} tab panels`);
  }
  for (const [name, html] of Object.entries(SURFACES)) {
    if (!name.endsWith(".html")) continue;
    assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/, `${name} still has a description paragraph under a title`);
  }
  assert.match(prototypeJs, /role="tab"/, "tabs are wired");
  assert.match(prototypeJs, /ArrowRight|ArrowLeft/, "the tab strip is arrow-key operable");
});

// --------------------------------------------------------------- prototypes
test("each prototype page is labelled synthetic, keyboard operable, reachable from the others and free of network calls", () => {
  for (const [key, html] of Object.entries(pages)) {
    assert.match(html, /<a class="skip" href="#main">/, `${key} skip link`);
    assert.match(html, /class="prototype-banner" role="note"/, `${key} banner`);
    assert.match(html, /Synthetic examples/, `${key} synthetic label`);
    assert.ok(html.split("\n").filter((line) => line.includes("prototype-banner")).length === 1, `${key} banner is one line`);
    assert.match(html, /aria-live="polite"/, `${key} live region`);
    assert.match(html, /data-pref="theme" data-on="light"/, `${key} theme icon`);
    assert.match(html, /data-pref="motion" data-on="reduced"/, `${key} motion icon`);
    assert.match(html, /data-pref="density" data-on="compact"/, `${key} density icon`);
    assert.doesNotMatch(html, /data-pref="theme"[^>]*>\s*<button[^>]*>Dark/, `${key} must not print theme words`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/, `${key} uses the shared system`);
    assert.match(html, /id="receiptDock"/, `${key} command feedback dock`);
    assert.match(html, /<span class="brand-mark" aria-hidden="true">D<\/span>/, `${key} uses the D monogram`);
    assert.doesNotMatch(html, /<span class="brand-mark">C<\/span>/, `${key} must not use the C mark`);
    assert.doesNotMatch(html, /Demo (Avery|Okafor|Lin|Reyes) (?!\w)/, `${key} names are fictional`);
  }
  assert.match(pages.index, /href="\/design\/business"/);
  assert.match(pages.index, /href="\/design\/operations"/);
  assert.match(pages.business, /href="\/design"/);
  assert.match(pages.operations, /href="\/design"/);
  assert.doesNotMatch(prototypeJs, /fetch\(|XMLHttpRequest|WebSocket|\/mcp|\/api\//, "the prototype never reaches CARR");
  assert.match(prototypeJs, /Demo /, "fixtures are visibly synthetic");
});

test("a link to another surface opens in a new browser tab", () => {
  for (const [name, html] of Object.entries(SURFACES)) {
    if (!name.endsWith(".html")) continue;
    for (const match of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      assert.match(match[0], /rel="noopener"/, `${name}: ${match[0]} opens a new tab without rel=noopener`);
    }
  }
  assert.match(prototypeJs, /target: "_blank", rel: "noopener"/, "popup links to other surfaces open a new tab safely");
});

test("the business prototype lists its actual items, opens popups for them, and offers a completion dialog with a calendar picker", () => {
  const html = pages.business;
  assert.match(html, /<dialog id="detailDialog" class="dialog"/, "one detail popup per page");
  assert.match(html, /<dialog id="completionDialog" class="dialog"/);
  assert.match(html, /value="cancel">Cancel, keep phase</);
  assert.match(html, /<aside id="recordPanel" class="side-panel glass"[^>]*data-pinned="false"/);
  assert.match(html, /id="panelPin" aria-pressed="false"/);
  assert.match(html, /id="completionDate" type="date"/, "the completion dialog uses a real calendar picker");
  assert.doesNotMatch(html, /completionDateTyped/, "and no separate typed-date box");
  assert.match(html, /id="quickAddDate" type="date"/, "quick add uses a real calendar picker");
  assert.doesNotMatch(html, /Or type the date/, "the typed-date fallback is gone from the page");
  assert.doesNotMatch(html, /quickAddDateTyped/, "and no separate typed-date box");
  assert.match(html, /<h2 id="quickTitle">Quick add<\/h2>/, "Quick add is spaced and cased as words");
  assert.match(html, /placeholder="Call Dr\. Patel Friday 10 AM about the Crestview LOI"/);
  assert.match(html, /<h2 id="workTitle">Activity<\/h2>/, "the team review title is short");
  assert.match(html, /id="scopeSwitch"[\s\S]*data-scope="team" aria-pressed="true"/);
  assert.match(html, /No record was read or changed/);
  assert.doesNotMatch(html, /leaderboard|workload ranking|top performer/i, "no partner ranking");
  assert.doesNotMatch(html, /Open Work<\/a>/, "the Needs-action tile lists its items instead of linking away");
  assert.doesNotMatch(html, /state-picker/, "the state gallery lives on /design only");
  assert.doesNotMatch(html, /Calendar · Clients · Vendors · More/, "the placeholder tile is gone");
  assert.doesNotMatch(html, />Original</, "the word original is gone from the change list");
  assert.doesNotMatch(html, /class="meter-bar"/, "the pipeline tile has no progress bar");
  // Tiles are rendered from the fixture, and every row is the button that
  // opens that item's popup.
  assert.match(prototypeJs, /class: "tile-row", type: "button", "data-item"/);
  assert.match(prototypeJs, /openWorkItem|answerForm/);
  assert.match(prototypeJs, /Waiting on: Demo Crestview landlord/, "waiting is written in plain words");
  assert.match(prototypeJs, /Counter due Thu 2:00 PM/);
  assert.match(prototypeJs, /data-filter/, "the board chips are wired");
  assert.match(prototypeJs, /boardFilter\.delete/, "a chip really filters the board");
  assert.match(prototypeJs, /showToast/, "the handover confirmation is a toast");
  assert.match(prototypeJs, /toast\.remove\(\), 4100/, "the toast is fully gone after about 4 seconds");
  assert.match(prototypeJs, /STATUS_WORDS = \{ todo: "To do"/, "the todo status prints as To do");
});

test("Kanban cards move by drag with a highlighted target, and the same move runs on the keyboard", () => {
  assert.match(prototypeJs, /draggable: "true"/, "cards are draggable");
  assert.match(prototypeJs, /addEventListener\("dragstart"/);
  assert.match(prototypeJs, /addEventListener\("dragover"/);
  assert.match(prototypeJs, /addEventListener\("drop"/);
  assert.match(prototypeJs, /section\.dataset\.drop = /, "the drop target is highlighted");
  // The keyboard equivalent: lift, choose, drop, cancel, all announced.
  assert.match(prototypeJs, /event\.key === "Enter" \|\| event\.key === " "/, "Enter or Space lifts the card");
  assert.match(prototypeJs, /lifted = id/);
  assert.match(prototypeJs, /ArrowRight" \|\| event\.key === "ArrowDown"/, "arrow keys choose the column");
  assert.match(prototypeJs, /event\.key === "Escape"/, "Escape cancels");
  assert.match(prototypeJs, /announce\(`\$\{record\.name\} lifted from/, "the lift is announced");
  assert.match(pages.business, /id="dragLive" aria-live="assertive"/, "moves are announced through a live region");
  assert.match(pages.operations, /id="modelLive" aria-live="assertive"/);
  // The Move menu is retired: the keyboard path is the non-drag path now.
  assert.doesNotMatch(css, /\.move-menu/, "the Move menu styling is gone");
  assert.doesNotMatch(prototypeJs, /move-menu|aria-haspopup": "menu"/, "the Move menu wiring is gone");
  for (const [name, html] of Object.entries(SURFACES)) {
    if (!name.endsWith(".html")) continue;
    assert.doesNotMatch(html, /<button[^>]*>\s*Move\s*<\/button>/, `${name} still has a Move button`);
  }
  assert.ok(!JSON.stringify(contract.components).includes("move-menu"), "the contract no longer names a Move menu");
  assert.match(contract.components.kanban.move_rule, /Enter or Space lifts it/);
  assert.match(contract.accessibility.requirements[0], /keyboard move/);
});

test("the Control Room prototype briefs from popups and reports repairs instead of asking to approve them", () => {
  const html = pages.operations;
  assert.match(html, /id="layerSwitch"[\s\S]*data-layer="infra"/);
  assert.match(html, /class="atlas-index" id="atlasIndex"/, "flat list alternative to the scene");
  assert.match(html, /id="atlasBack"/);
  assert.match(html, /class="certainty" data-level="fact"/);
  assert.match(html, /class="certainty" data-level="hypothesis"/);
  assert.match(html, /class="work-state" data-state="working"/);
  assert.match(html, /class="contact-state" data-state="delayed"/);
  assert.match(html, /data-coverage="unavailable"/, "missing telemetry is unknown, not zero");
  assert.match(html, /Acknowledging is not resolving/);
  assert.match(html, /id="approvalChange"/);
  assert.match(html, /id="modelKanban"/, "the Model Room has its own board");
  assert.match(html, /id="modelHistory"/, "and a ticket history list");
  assert.doesNotMatch(html, /Who works on what/, "the Model Room title was retitled");
  assert.doesNotMatch(html, /saved you \d|\d-day streak|score: \d/i, "no invented gamification");
  // Each dashboard tile is a briefing button; the narrative lives in the popup.
  assert.match(prototypeJs, /DASHBOARD_TILES/);
  assert.match(prototypeJs, /"data-briefing"/);
  assert.match(prototypeJs, /Detected and repaired/, "repairs are briefed, not approved");
  assert.match(prototypeJs, /repaired 9:14 AM/);
  assert.match(prototypeJs, /What was broken/);
  assert.match(prototypeJs, /How it is better now/);
  assert.match(prototypeJs, /MODEL_COLUMNS = \["Assigned", "In progress", "Blocked", "Done"\]/);
  const repaired = prototypeJs.slice(prototypeJs.indexOf('id: "repaired"'), prototypeJs.indexOf('id: "changed"'));
  assert.doesNotMatch(repaired, /Approve|Decline/, "a repair briefing carries no approve or decline control");
  assert.match(prototypeJs, /aria-current/);
  assert.match(prototypeJs, /"data-time"|data-time/);
});

test("the outcome simulator names itself before it names a value", () => {
  for (const key of ["business", "operations"]) {
    assert.match(pages[key], /<label for="outcomeSimulator">Next command outcome<\/label>/, `${key} simulator title`);
    const select = /<select id="outcomeSimulator">[\s\S]*?<\/select>/.exec(pages[key])[0];
    assert.match(select, /<option value="confirm">Confirmed by the server<\/option>/);
  }
});

// --------------------------------------------------------------- pure decisions
test("preferences resolve to known values, fall back per key, and honour the system motion request only when nothing is stored", () => {
  assert.deepEqual(resolvePreferences(), { theme: "dark", density: "comfortable", motion: "full" });
  assert.deepEqual(resolvePreferences({ theme: "light", density: "loose", motion: "nope" }), { theme: "light", density: "comfortable", motion: "full" });
  assert.deepEqual(resolvePreferences({}, { prefersReducedMotion: true }), { theme: "dark", density: "comfortable", motion: "reduced" });
  assert.deepEqual(resolvePreferences({ motion: "full" }, { prefersReducedMotion: true }).motion, "full");
  assert.deepEqual(preferenceAttributes(resolvePreferences({ theme: "light" })), { "data-theme": "light", "data-density": "comfortable", "data-motion": "full" });
});

test("command feedback: saving is not confirmed, refusal keeps the operation retryable, timeout is unknown and must reconcile before a retry", () => {
  let record = createFeedback("move:c1:LOI", "Demo → LOI");
  assert.equal(feedbackLabel(record), "Ready");
  assert.ok(canDispatch(record));
  record = transitionFeedback(record, "dispatch");
  assert.equal(record.state, "pending");
  assert.equal(feedbackLabel(record), "Saving");
  assert.ok(!canDispatch(record), "a second click while pending is the same operation");
  assert.equal(transitionFeedback(record, "dispatch").refusedEvent, "dispatch");
  const refused = transitionFeedback(record, "refuse", { reason: "stale version" });
  assert.equal(refused.state, "refused");
  assert.equal(refused.reason, "stale version");
  assert.ok(refused.retryable && canDispatch(refused));
  const unknown = transitionFeedback(record, "timeout");
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.reason, /checking before any retry/);
  assert.ok(!canDispatch(unknown), "unknown cannot be retried blindly");
  assert.equal(transitionFeedback(unknown, "dispatch").refusedEvent, "dispatch");
  const checking = transitionFeedback(unknown, "reconcile");
  assert.equal(checking.state, "checking");
  const confirmed = transitionFeedback(checking, "confirm");
  assert.equal(confirmed.state, "confirmed");
  assert.equal(feedbackLabel(confirmed), "Confirmed");
  const undone = transitionFeedback(confirmed, "undo");
  assert.equal(undone.state, "undone");
  assert.ok(canDispatch(undone));
  assert.throws(() => createFeedback("", "x"), TypeError);
});

test("work ordering puts pins first, then overdue, deadline, blocked, ordinary, with a reason for every elevation and a stable order among equals", () => {
  const now = "2026-09-16T14:00:00Z";
  assert.deepEqual(classifyPriority({ due: "2026-09-15" }, now), { priority: "overdue", reason: "due 1 day ago" });
  assert.deepEqual(classifyPriority({ due: "2026-09-18" }, now), { priority: "deadline", reason: "due in 2 days" });
  assert.deepEqual(classifyPriority({ blocked: true, blockedOn: "signed ETL" }, now), { priority: "blocked", reason: "blocked on signed ETL" });
  assert.deepEqual(classifyPriority({ due: "2026-10-02" }, now), { priority: "ordinary", reason: "" });
  assert.deepEqual(classifyPriority({ due: "not a date" }, now).priority, "ordinary");
  const ordered = orderWork([
    { id: "a", due: "2026-10-02" }, { id: "b", blocked: true }, { id: "c", due: "2026-09-18" },
    { id: "d", due: "2026-09-15" }, { id: "e", due: "2026-10-03", pinned: true }, { id: "f", due: "2026-10-04" },
  ], now);
  assert.deepEqual(ordered.map((item) => item.id), ["e", "d", "c", "b", "a", "f"]);
  assert.equal(ordered[0].priority, "ordinary");
});

test("clock and calendar formatting are 12-hour AM/PM and a readable calendar date", () => {
  assert.equal(formatClock("2026-09-16T14:00:00Z"), "2:00 PM");
  assert.equal(formatClock("2026-09-16T00:07:00Z"), "12:07 AM");
  assert.equal(formatClock("2026-09-16T12:00:00Z"), "12:00 PM");
  assert.equal(formatClock("2026-09-16T09:05:00Z"), "9:05 AM");
  assert.equal(formatClock("2026-09-16T23:59:00Z"), "11:59 PM");
  assert.equal(formatClock("not a time"), null);
  assert.equal(formatCalendarDate("2026-09-16"), "Wed, Sep 16, 2026");
  assert.equal(formatCalendarDate("2026-09-18T00:00:00Z"), "Fri, Sep 18, 2026");
  assert.equal(weekdayName("2026-09-16"), "Wednesday");
  assert.equal(formatDueStamp("2026-09-15", "5:00 PM"), "Tue, Sep 15, 2026 · 5:00 PM");
  assert.equal(formatDueStamp("2026-09-15"), "Tue, Sep 15, 2026");
  assert.equal(formatDueStamp("nope", "5:00 PM"), null);
});

test("a typed date is accepted in the forms a person actually types, and refused when it is not a date", () => {
  const now = Date.parse("2026-09-16T14:00:00Z");
  assert.equal(parseTypedDate("2026-09-18", now), "2026-09-18");
  assert.equal(parseTypedDate("9/18/2026", now), "2026-09-18");
  assert.equal(parseTypedDate("9/18", now), "2026-09-18");
  assert.equal(parseTypedDate("9/18/26", now), "2026-09-18");
  assert.equal(parseTypedDate("Sep 18, 2026", now), "2026-09-18");
  assert.equal(parseTypedDate("September 18", now), "2026-09-18");
  assert.equal(parseTypedDate("Friday", now), "2026-09-18");
  assert.equal(parseTypedDate("next week?", now), null);
  assert.equal(parseTypedDate("2026-02-30", now), null, "a day that does not exist is not a date");
  assert.equal(parseTypedDate("", now), null);
});

test("Quick add fills owner, due and related from the sentence and never leaves them unknown when the sentence holds them", () => {
  const now = Date.parse("2026-09-16T14:00:00Z");
  const records = ["Demo Gulf Breeze Dental", "Demo Pace Pediatrics", "Demo Crestview Derm"];
  const placeholder = parseQuickAdd("Call Dr. Patel Friday 10 AM about the Crestview LOI", { now, viewer: "joe", records });
  assert.equal(placeholder.owner, "joe", "the viewer owns what the viewer captures");
  assert.equal(placeholder.ownerDefaulted, true);
  assert.equal(placeholder.due, "2026-09-18");
  assert.equal(placeholder.dueTime, "10:00 AM");
  assert.equal(placeholder.dueLabel, "Fri, Sep 18, 2026 · 10:00 AM");
  assert.equal(placeholder.related, "Demo Crestview Derm", "a distinctive word matches a record on the board");
  assert.match(placeholder.action, /^Call Dr\. Patel/);
  assert.deepEqual(placeholder.questions, []);
  assert.equal(placeholder.complete, true);

  const named = parseQuickAdd("Send survey window to @dell by friday for Demo Pace Pediatrics", { now, records });
  assert.equal(named.owner, "dell");
  assert.equal(named.ownerDefaulted, false);
  assert.equal(named.due, "2026-09-18");
  assert.equal(named.related, "Demo Pace Pediatrics");

  const iso = parseQuickAdd("Call the CPA by 2026-09-30 @joe", { now });
  assert.equal(iso.due, "2026-09-30");
  assert.equal(iso.owner, "joe");
  assert.equal(iso.action, "Call the CPA");
  assert.equal(iso.dueTime, null);
  assert.equal(iso.dueLabel, "Wed, Sep 30, 2026");

  const viewerIsDell = parseQuickAdd("research exhibitor pricing", { now, viewer: "dell" });
  assert.equal(viewerIsDell.owner, "dell");
  assert.deepEqual(viewerIsDell.questions, [], "an unnamed owner is the viewer, not a question");

  assert.equal(parseQuickAdd("", { now }).action, null);
  assert.deepEqual(parseQuickAdd("", { now }).questions, ["What is the action?"]);
  assert.equal(parseQuickAdd("Call the CPA", Date.parse("2026-09-16T14:00:00Z")).owner, "joe", "a bare number is still accepted as now");
});

test("contrast arithmetic matches the WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#777777", "#ffffff"), 4.48);
  assert.equal(contrastRatio("#fff", "#fff"), 1);
  assert.throws(() => contrastRatio("navy", "#fff"), TypeError);
});
