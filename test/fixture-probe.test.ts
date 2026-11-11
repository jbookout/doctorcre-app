import assert from "node:assert/strict";
import test from "node:test";
import { ExerciseClock, fixtureProbe } from "./fixture-probe.ts";

test("exercise clock waits for Ready and cancels once at its boundary", () => {
  let expire: (() => void) | undefined;
  let armed = 0;
  let cancelled = 0;
  const clock = new ExerciseClock(
    () => cancelled++,
    (callback) => {
      armed++;
      expire = callback;
      return () => {
        expire = undefined;
      };
    },
  );
  assert.equal(armed, 0);
  clock.start();
  assert.equal(armed, 1);
  expire?.();
  clock.close();
  assert.equal(cancelled, 1);
  clock.start();
  assert.equal(armed, 1);
});

for (const scenario of ["early-exit", "never-ready"] as const) {
  test(`${scenario} fails in acquisition and reaps the probe`, { timeout: 60000 }, async () => {
    const probe = fixtureProbe({ scenario, acquisitionMs: scenario === "early-exit" ? 30000 : 1000 });
    await assert.rejects(probe.ready, /acquisition/);
    await probe.close();
    assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
  });
}

test("parent abort while Starting and repeated close settle once", { timeout: 60000 }, async () => {
  const controller = new AbortController();
  const probe = fixtureProbe({ scenario: "never-ready", signal: controller.signal });
  controller.abort();
  await assert.rejects(probe.ready, /parent abort/);
  await Promise.all([probe.close(), probe.close()]);
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
});

test("early ready is retained until the caller awaits it", { timeout: 60000 }, async (t) => {
  const probe = fixtureProbe({ scenario: "early-ready" });
  t.after(() => probe.close());
  const ready = await probe.ready;
  assert.equal(ready.origin, "http://127.0.0.1:1");
  assert.equal(await probe.ready, ready);
});

test("late readiness after Closing is discarded and reaped", { timeout: 60000 }, async () => {
  const probe = fixtureProbe({ scenario: "late-ready" });
  await probe.started;
  const rejection = assert.rejects(probe.ready, /closed/);
  await probe.close();
  await rejection;
  const owned = probe.ownership;
  assert.ok(owned);
  await assert.rejects(fetch(owned.origin));
  assert.throws(() => process.kill(owned.fixturePid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
});

test("held readiness cannot expire the exercise budget", { timeout: 60000 }, async (t) => {
  let expire: (() => void) | undefined;
  let armed = 0;
  const probe = fixtureProbe({
    scenario: "late-ready",
    scheduleExercise: (callback) => {
      armed++;
      expire = callback;
      return () => {
        expire = undefined;
      };
    },
  });
  t.after(() => probe.close());
  await probe.started;
  expire?.();
  assert.equal(armed, 0);
  await probe.ready;
  const result = assert.rejects(probe.exercise("timeout"), /exercise timeout/);
  await Promise.resolve();
  assert.equal(armed, 1);
  expire?.();
  await result;
});

test("cleanup watchdog reports failure and kills an uncooperative probe", { timeout: 60000 }, async () => {
  const probe = fixtureProbe({ scenario: "ignore-close" });
  await probe.ready;
  await assert.rejects(probe.close(), /cleanup watchdog/);
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
});

test("parent abort after Ready closes its real fixture and port", { timeout: 60000 }, async () => {
  const controller = new AbortController();
  const probe = fixtureProbe({ signal: controller.signal });
  const { origin, fixturePid } = await probe.ready;
  controller.abort();
  await probe.close();
  await assert.rejects(fetch(origin));
  assert.throws(() => process.kill(fixturePid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
});

test("parent abort during Exercising cancels the timer and reaps its fixture", { timeout: 60000 }, async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const probe = fixtureProbe({
    signal: controller.signal,
    scheduleExercise: () => () => {
      cancelled++;
    },
  });
  const { origin, fixturePid } = await probe.ready;
  const result = assert.rejects(probe.exercise("timeout"), /parent abort/);
  await Promise.resolve();
  controller.abort();
  await result;
  assert.equal(cancelled, 1);
  await assert.rejects(fetch(origin));
  assert.throws(() => process.kill(fixturePid, 0), { code: "ESRCH" });
});
