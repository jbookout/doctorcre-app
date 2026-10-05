import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { context, policy } from "./workflow-policy.mjs";
import test from "node:test";

const files = ["ci.yml", "e2e.yml"];
const read = name => readFileSync(new URL("../.github/workflows/" + name, import.meta.url), "utf8");
function replay(source, events) {
  const runs = [];
  for (const [tick, event] of events.entries()) {
    const current = policy(source, event);
    if (!current.triggers) continue;
    // Five seconds per synthetic suite; this is work accounting, not fleet savings.
    for (const run of runs) if (run.status === "running" && tick >= run.start + 5) run.status = "success";
    if (current.cancel && current.group) for (const run of runs) {
      if (run.status === "running" && run.group === current.group) {
        run.status = "superseded"; run.seconds = tick - run.start;
      }
    }
    runs.push({ ...current, start: tick, status: current.runnable.length ? "running" : "skipped",
      seconds: current.runnable.length ? 5 : 0 });
  }
  for (const run of runs) if (run.status === "running") run.status = "success";
  return runs;
}
for (const file of files) {
  const source = read(file);
  test(`${file}: required context identity is retained`, () => {
    assert.deepEqual(policy(source, context()).jobs, [file === "ci.yml" ? "test" : "journeys"]);
  });
  test(`${file}: rapid A/B/C supersedes A/B and C runs every job`, () => {
    const runs = replay(source, [context("pull_request", "opened", 9, 1), context("pull_request", "synchronize", 9, 2), context("pull_request", "synchronize", 9, 3)]);
    assert.deepEqual(runs.map(run => run.status), ["superseded", "superseded", "success"]);
    assert.deepEqual(runs[2].runnable, runs[2].jobs);
    const uncancelled = replay(source.replace(/^concurrency:\n(?:  .+\n)+/m, ""), [context("pull_request", "opened", 9, 1), context("pull_request", "synchronize", 9, 2), context("pull_request", "synchronize", 9, 3)]);
    assert.equal(runs.reduce((sum, r) => sum + r.seconds, 0), 7);
    assert.equal(uncancelled.reduce((sum, r) => sum + r.seconds, 0), 15);
    assert.equal(runs.filter(r => r.runnable.length).length, 3, "supersession saves tail work, not started suites");
  });
  test(`${file}: closed event cancels prior work with zero runnable jobs; reopen recovers`, () => {
    for (const action of ["opened", "synchronize", "edited", "ready_for_review"]) {
      const runs = replay(source, [context("pull_request", action, 9, 1), context("pull_request", "closed", 9, 2)]);
      assert.deepEqual(runs.map(run => run.status), ["superseded", "skipped"]);
      assert.deepEqual(runs[1].runnable, [], "closed must not checkout/install/test/aggregate");
    }
    const reopened = policy(source, context("pull_request", "reopened"));
    assert.deepEqual(reopened.runnable, reopened.jobs);
    const removedGuards = source.replace(/^    if:.*\n/gm, "");
    assert.notDeepEqual(policy(removedGuards, context("pull_request", "closed")).runnable, [], "control removing only the close guard is rejected");
  });
  test(`${file}: workflow/PR identity is stable on close and isolated from other PR/main/manual`, () => {
    const current = policy(source, context());
    assert.ok(current.group);
    assert.equal(policy(source, context("pull_request", "closed")).group, current.group);
    assert.notEqual(policy(source, context("pull_request", "opened", 10)).group, current.group);
    assert.notEqual(policy(source.replace(/^name: .+$/m, "name: Another workflow"), context()).group, current.group);
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      const one = policy(source, context(event, "", 9, 1)), two = policy(source, context(event, "", 9, 2));
      assert.equal(one.cancel, false, `${event} must retain its completed verdict`);
      assert.notEqual(one.group, current.group);
      assert.notEqual(one.group, two.group, "pending non-PR verdicts must not replace each other");
      assert.deepEqual(one.runnable, one.jobs);
    }
  });
  test(`${file}: edits and draft-to-ready retain full validation; completed verdict survives close`, () => {
    for (const action of ["opened", "synchronize", "reopened", "edited", "ready_for_review"]) {
      assert.deepEqual(policy(source, context("pull_request", action)).runnable, policy(source, context()).jobs);
    }
    assert.doesNotMatch(source, /github\.event\.pull_request\.draft|continue-on-error:/);
    const events = [context("pull_request", "opened"), ...Array.from({ length: 5 }, (_, i) => context("push", "", 9, 100 + i)), context("pull_request", "closed", 9, 7)];
    assert.equal(replay(source, events)[0].status, "success", "a close event must not erase completed green evidence");
  });
}
