// V5-UX-C15 — one test per checkable-done clause, plus the static page rules.
//
// The refusal reasons below deliberately carry the shape of CARR's own /health
// body, runbook path included, because the clause that matters most here is
// that none of it can reach a rendered sentence (CR-AC-26).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  APP_READ_ID, INTEGRATION_GAPS, PROVIDER_LINKS, REFUSAL_SENTENCE, SNAPSHOT_KEY, SNAPSHOT_READ_KEYS,
  appChip, readSnapshot, snapshotFromReads, statusChips, statusHeadline, writeSnapshot,
} from "../js/status-model.js";
import { READS } from "../js/control-room-model.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("status.html");
const pageJs = await read("js/status.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));

const LEAKY = "database probe failed: connection refused. Runbook: DNA/runbooks/database-down.md";
const CLOCK = "2026-09-17T15:04:00.000Z";

const answered = (observed_at = CLOCK) => ({ state: "read", observed_at, payload: { ok: true } });
const refused = (reason = LEAKY) => ({ state: "unknown", reason });
const allAnswered = () => Object.fromEntries(READS.map((id) => [id, answered()]));

const release = { state: "read", observed_at: CLOCK, payload: { service: "doctorcre-app", environment: "staging", source_commit: "a".repeat(40) } };

/* ------------------------------------------------------------------ headline */

test("scenario 1: the app answered and every read answered", () => {
  const model = statusHeadline({ release, reads: allAnswered() });
  assert.equal(model.scenario, 1);
  assert.equal(model.headline, "DoctorCRE is serving and the record layer answered.");
  assert.deepEqual(model.silent, []);
  assert.equal(model.lastKnown, false);
});

test("scenario 2: the app answered and one collector did not, by name, with the retry action", () => {
  const model = statusHeadline({ release, reads: { ...allAnswered(), incidents: refused() } });
  assert.equal(model.scenario, 2);
  assert.equal(model.headline, "DoctorCRE is serving; the record layer did not answer for: Incidents.");
  assert.deepEqual(model.silent, ["incidents"]);
  assert.match(model.action, /^Retry in a minute; if it persists, open the incident queue when the record layer returns\.$/);
});

test("scenario 3: the app did not answer and a snapshot exists, timestamped and captioned", () => {
  const snapshot = snapshotFromReads({ [APP_READ_ID]: answered(), ...allAnswered() }, Date.parse(CLOCK));
  const model = statusHeadline({ release: refused(), reads: allAnswered(), snapshot });
  assert.equal(model.scenario, 3);
  assert.equal(model.headline, "The DoctorCRE app itself did not answer.");
  assert.equal(model.lastKnown, true);
  assert.equal(model.lastKnownTitle, "Last known");
  assert.equal(model.saved_at, snapshot.saved_at, "the Last known block always carries saved_at");
  assert.match(model.lastKnownAsOf, /^as of \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(model.action, "Check the provider status pages below.");
});

test("scenario 4: the app did not answer and nothing is stored on this device", () => {
  const model = statusHeadline({ release: refused(), reads: allAnswered(), snapshot: null });
  assert.equal(model.scenario, 4);
  assert.equal(model.lastKnown, false);
  assert.equal(model.emptyChipText, "unknown (no answer and nothing stored on this device)");
  assert.equal(model.action, "Check the provider status pages below.");
});

/* ----------------------------------------------- the record layer's own words */

test("a CARR refusal never reaches a rendered sentence", () => {
  const reads = { ...allAnswered(), work: refused(), census: refused() };
  const model = statusHeadline({ release, reads });
  const chips = statusChips({ release, reads });
  const rendered = [model.headline, model.action, ...chips.map((chip) => chip.text)].join(" ");
  assert.doesNotMatch(rendered, /Runbook/);
  assert.doesNotMatch(rendered, /DNA\//);
  assert.doesNotMatch(rendered, /connection refused/);
  assert.ok(rendered.includes(REFUSAL_SENTENCE), "the app states its own fixed sentence instead");
});

/* ------------------------------------------------------------------- coverage */

test("one collector outage leaves every other chip untouched and produces no zero", () => {
  const reads = { ...allAnswered(), census: refused() };
  const chips = statusChips({ release, reads });
  assert.equal(chips.length, 5, "the four record-layer reads plus the app read");
  assert.equal(chips[0].id, APP_READ_ID);
  assert.match(chips[0].text, /^app: read at \d{1,2}:\d{2} (AM|PM)$/);
  const census = chips.find((chip) => chip.id === "census");
  assert.equal(census.state, "unknown");
  assert.equal(census.text, `Work census: unknown (${REFUSAL_SENTENCE})`);
  for (const chip of chips.filter((candidate) => candidate.id !== "census")) {
    assert.equal(chip.state, "read", `${chip.id} was collateral damage`);
    assert.match(chip.text, /read at \d{1,2}:\d{2} (AM|PM)$/);
  }
  assert.ok(chips.every((chip) => !/\b0\b/.test(chip.text)), "no chip states a zero");
});

test("the app chip states the app's own refusal, not the record layer's", () => {
  const chip = appChip(refused());
  assert.equal(chip.state, "unknown");
  assert.equal(chip.text, "app: unknown (the app did not answer)");
});

/* ------------------------------------------------------------------- snapshot */

test("the snapshot holds no payload rows", () => {
  const snapshot = snapshotFromReads({
    [APP_READ_ID]: answered(),
    ...allAnswered(),
    incidents: refused(),
  }, Date.parse(CLOCK));
  assert.equal(snapshot.saved_at, CLOCK);
  assert.equal(snapshot.reads.length, 5);
  for (const row of snapshot.reads) {
    assert.deepEqual(Object.keys(row).sort(), [...SNAPSHOT_READ_KEYS].sort(), `${row.id} carries a key it may not`);
  }
  const stored = JSON.stringify(snapshot);
  for (const leak of ["title", "human_ref", "count", "items", "payload", "ref", "severity"]) {
    assert.ok(!stored.includes(`"${leak}"`), `the snapshot leaked ${leak}`);
  }
  assert.equal(snapshot.reads.find((row) => row.id === "incidents").coverage_word, "unknown");
  assert.equal(snapshot.reads.find((row) => row.id === "incidents").reason, REFUSAL_SENTENCE);
  assert.equal(snapshot.reads.find((row) => row.id === "work").coverage_word, "read");
});

test("readSnapshot returns null on garbage and on a throwing storage, and round-trips a real one", () => {
  const store = new Map();
  const storage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) };
  assert.equal(readSnapshot(storage), null, "an empty device has no snapshot");

  store.set(SNAPSHOT_KEY, "{not json");
  assert.equal(readSnapshot(storage), null);
  store.set(SNAPSHOT_KEY, JSON.stringify({ schema: "something-else", saved_at: CLOCK, reads: [] }));
  assert.equal(readSnapshot(storage), null);
  store.set(SNAPSHOT_KEY, JSON.stringify({ schema: "doctorcre-status-snapshot.v1", saved_at: "not a time", reads: [] }));
  assert.equal(readSnapshot(storage), null);

  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSnapshot(throwing), null);
  assert.equal(writeSnapshot(throwing, snapshotFromReads({}, Date.parse(CLOCK))), false, "a refusing store is not an error");
  assert.equal(readSnapshot(null), null);

  const snapshot = snapshotFromReads({ [APP_READ_ID]: answered(), ...allAnswered() }, Date.parse(CLOCK));
  assert.equal(writeSnapshot(storage, snapshot), true);
  const back = readSnapshot(storage);
  assert.equal(back.saved_at, CLOCK);
  assert.equal(back.reads.length, 5);
  for (const row of back.reads) assert.deepEqual(Object.keys(row), [...SNAPSHOT_READ_KEYS]);
});

/* -------------------------------------------------------------- scope and links */

test("the integration gaps are the literal word unknown with a named reason", () => {
  assert.equal(INTEGRATION_GAPS.length, 3);
  for (const gap of INTEGRATION_GAPS) {
    assert.equal(gap.word, "unknown");
    assert.equal(gap.reason, "no producer yet");
  }
  assert.deepEqual(INTEGRATION_GAPS.map((gap) => gap.title), [
    "Truthful health and scoped degradation (V5-A01)",
    "Backup, restore and degraded-operation posture (V5-F08)",
    "Supervisor and job health (V5-F07)",
  ]);
});

test("the provider links are anchors this page never fetches", () => {
  assert.deepEqual(PROVIDER_LINKS.map((link) => link.href), [
    "https://www.cloudflarestatus.com/", "https://neonstatus.com/", "https://www.githubstatus.com/",
  ]);
  for (const link of PROVIDER_LINKS) {
    assert.ok(!pageJs.includes(`fetch("${link.href}`), `${link.id} must never be fetched`);
    assert.ok(!pageJs.includes(link.href), `${link.id} belongs in the model, not in a page fetch`);
  }
  assert.match(pageJs, /target="_blank" rel="noopener"/);
});

/* --------------------------------------------------------------- static page */

test("the route is pinned and the contract moved on additively", () => {
  assert.equal(routes.routes["/status"], "status.html");
  assert.equal(routes.version, "1.11.0");
});

test("the page is read-only: no command dock, no Doc mount, no write verb", () => {
  assert.match(html, /<title>Status · DoctorCRE<\/title>/);
  assert.doesNotMatch(html, /doc-fab|docChat|docTranscript/, "Doc needs CARR and cannot be the fallback");
  assert.doesNotMatch(html, /command-dock|commandDock|receipt-dock/, "there is no command dock here");
  assert.doesNotMatch(pageJs, /mountDocDock|mountCommandDock/);
  for (const write of ["addLoop", "patchDealField", "closeIncident", "adjudicate", "updateDeal", "setNextStep"]) {
    assert.ok(!pageJs.includes(write), `the status page must not ${write}`);
  }
  assert.doesNotMatch(html, /<form\b/, "nothing on this page is submitted");
  assert.equal([...html.matchAll(/aria-live="polite" role="status"/g)].length, 1, "one status live region");
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.match(pageJs, /formatClock/, "clocks come from the shared formatter");
  for (const match of html.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>").matchAll(/\b\d{1,2}:\d{2}\b(.{0,4})/g)) {
    assert.match(match[1], /^\s*(AM|PM)/, `"${match[0]}" prints without AM or PM`);
  }
});

test("the page reaches nothing but its own origin", () => {
  for (const match of pageJs.matchAll(/fetch\(`?([^`")]*)/g)) {
    assert.match(match[1], /^[/$]/, `${match[1]} is not a same-origin path`);
  }
});
