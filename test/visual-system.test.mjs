import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canDispatch, classifyPriority, contrastRatio, createFeedback, feedbackLabel, formatCalendarDate,
  formatClock, formatDueStamp, orderWork, parseQuickAdd, preferenceAttributes,
  readTokens, resolvePreferences, transitionFeedback, weekdayName,
} from "../js/visual-system.js";

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

test("Quick add fills owner, due and related from the sentence and never leaves them unknown when the sentence holds them", () => {
  const now = Date.parse("2026-09-16T14:00:00Z");
  const records = ["Demo Gulf Breeze Dental", "Demo Pace Pediatrics", "Demo Crestview Derm"];
  const placeholder = parseQuickAdd("Call Dr. Patel Friday 10 AM about the Demo Crestview Derm LOI", { now, viewer: "joe", records });
  assert.equal(placeholder.owner, "joe", "the viewer owns what the viewer captures");
  assert.equal(placeholder.ownerDefaulted, true);
  assert.equal(placeholder.due, "2026-09-18");
  assert.equal(placeholder.dueTime, "10:00 AM");
  assert.equal(placeholder.dueLabel, "Fri, Sep 18, 2026 · 10:00 AM");
  assert.equal(placeholder.related, "Demo Crestview Derm", "the sentence names a record on the board");
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

const tokensCss = await readFile(new URL('../css/tokens.css', import.meta.url), 'utf8');
test('both token themes meet the contrast floor', () => {
  for (const selector of [':root {', ':root[data-theme="light"]']) {
    const tokens = readTokens(tokensCss, selector);
    for (const [foreground, background] of [["--fg", "--ground"], ["--fg", "--surface-2"], ["--fg-muted", "--ground"], ["--fg-muted", "--surface-2"], ["--fg-quiet", "--ground"], ["--fg-quiet", "--surface-1"], ["--accent-ink", "--ground"], ["--accent-ink", "--surface-2"], ["--status-info-ink", "--ground"], ["--status-ok-ink", "--ground"], ["--status-warn-ink", "--ground"], ["--status-danger-ink", "--ground"], ["--status-hold-ink", "--ground"], ["--on-accent", "--accent"]]) {
      assert.ok(contrastRatio(tokens[foreground], tokens[background]) >= 4.5, `${selector}: ${foreground} on ${background}`);
    }
  }
});

test('only css/tokens.css declares palette or type tokens', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(new URL('../css/', import.meta.url))) {
    if (!name.endsWith('.css') || name === 'tokens.css') continue;
    const source = await readFile(new URL(`../css/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /--(?:surface-\d|hairline(?:-strong)?|fg(?:-muted|-quiet)?|accent(?:-ink|-hover)?|font-size-\d|font-text)\s*:/, `css/${name} redeclares a V2 token`);
  }
});
