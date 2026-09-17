import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canDispatch, classifyPriority, contrastRatio, createFeedback, feedbackLabel, orderWork, parseQuickAdd,
  preferenceAttributes, readTokens, resolvePreferences, transitionFeedback,
} from "../js/visual-system.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const contract = JSON.parse(await read("contracts/visual-system.v1.json"));
const css = await read("css/system.css");
const pages = Object.fromEntries(await Promise.all(Object.entries(contract.prototypes).map(async ([key, file]) => [key, await read(file)])));
const prototypeJs = await read("js/design-prototype.js");

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

test("touch targets, focus and the modal/nonmodal distinction are in the stylesheet", () => {
  assert.match(css, /--touch: 44px/);
  assert.match(css, /\.btn \{[^}]*min-height: var\(--touch\)/);
  assert.match(css, /\.move-menu button \{[^}]*min-height: var\(--touch\)/);
  assert.match(css, /:focus-visible \{ outline: 3px solid var\(--focus\)/);
  assert.match(css, /\.side-panel \{ position: sticky/);
  assert.match(css, /\.dialog::backdrop/);
  assert.equal(contract.accessibility.touch_target_px, 44);
});

// --------------------------------------------------------------- prototypes
test("each prototype page is labelled synthetic, keyboard operable, reachable from the others and free of network calls", () => {
  for (const [key, html] of Object.entries(pages)) {
    assert.match(html, /<a class="skip" href="#main">/, `${key} skip link`);
    assert.match(html, /class="prototype-banner" role="note"/, `${key} banner`);
    assert.match(html, /Synthetic examples/, `${key} synthetic label`);
    assert.match(html, /aria-live="polite"/, `${key} live region`);
    assert.match(html, /data-pref="theme"[\s\S]*data-value="light"/, `${key} theme control`);
    assert.match(html, /data-pref="motion"[\s\S]*data-value="reduced"/, `${key} motion pause`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/, `${key} uses the shared system`);
    assert.match(html, /id="receiptDock"/, `${key} command feedback dock`);
    assert.doesNotMatch(html, /Demo (Avery|Okafor|Lin|Reyes) (?!\w)/, `${key} names are fictional`);
  }
  assert.match(pages.index, /href="\/design\/business"/);
  assert.match(pages.index, /href="\/design\/operations"/);
  assert.match(pages.business, /href="\/design"/);
  assert.match(pages.operations, /href="\/design"/);
  assert.doesNotMatch(prototypeJs, /fetch\(|XMLHttpRequest|WebSocket|\/mcp|\/api\//, "the prototype never reaches CARR");
  assert.match(prototypeJs, /Demo /, "fixtures are visibly synthetic");
});

test("the business prototype offers a Move menu beside every card, a completion dialog, a pinnable record panel and Quick Add", () => {
  const html = pages.business;
  assert.match(html, /<dialog id="completionDialog" class="dialog"/);
  assert.match(html, /value="cancel">Cancel, keep phase</);
  assert.match(html, /<aside id="recordPanel" class="side-panel glass"[^>]*data-pinned="false"/);
  assert.match(html, /id="panelPin" aria-pressed="false"/);
  assert.match(html, /id="quickAddInput"/);
  assert.match(html, /id="scopeSwitch"[\s\S]*data-scope="team" aria-pressed="true"/);
  assert.match(html, /No record was read or changed/);
  assert.doesNotMatch(html, /leaderboard|workload ranking|top performer/i, "no partner ranking");
  assert.match(prototypeJs, /"data-move": card\.id, "aria-haspopup": "menu"/);
  assert.match(prototypeJs, /ArrowDown|ArrowUp/);
  assert.match(prototypeJs, /event\.key === "Escape"/);
  assert.doesNotMatch(prototypeJs, /draggable|dragstart/, "no drag path at all in the prototype; the Move menu is the path");
});

test("the Control Room prototype separates category from health, work state from contact state, fact from hypothesis", () => {
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
  assert.doesNotMatch(html, /saved you \d|\d-day streak|score: \d/i, "no invented gamification");
  assert.match(prototypeJs, /aria-current/);
  assert.match(prototypeJs, /"data-time"|data-time/);
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

test("Quick Add infers owner, date and record from a sentence and asks only for what it could not see", () => {
  const now = Date.parse("2026-09-16T14:00:00Z");
  const full = parseQuickAdd("Send survey window to @dell by friday for Demo Pace Pediatrics", now);
  assert.deepEqual(full, { action: "Send survey window to", owner: "dell", due: "2026-09-18", related: "Demo Pace Pediatrics", questions: [], complete: true });
  const iso = parseQuickAdd("Call the CPA by 2026-09-30 @joe", now);
  assert.equal(iso.due, "2026-09-30");
  assert.equal(iso.owner, "joe");
  assert.equal(iso.action, "Call the CPA");
  const bare = parseQuickAdd("research exhibitor pricing", now);
  assert.deepEqual(bare.questions, ["Who owns this?"]);
  assert.equal(bare.complete, false);
  assert.equal(parseQuickAdd("", now).action, null);
  assert.deepEqual(parseQuickAdd("", now).questions, ["Who owns this?", "What is the action?"]);
});

test("contrast arithmetic matches the WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#777777", "#ffffff"), 4.48);
  assert.equal(contrastRatio("#fff", "#fff"), 1);
  assert.throws(() => contrastRatio("navy", "#fff"), TypeError);
});
