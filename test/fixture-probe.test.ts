import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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

test("late readiness after Closing is discarded and reaped", { timeout: 60000 }, async (t) => {
  const spawn = cp.spawn;
  let deliverReady: (() => void) | undefined;
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    const child = spawn(...args);
    const emit = child.emit;
    child.emit = function (event: string | symbol, ...values: unknown[]) {
      const message = values[0];
      if (event === "message" && typeof message === "object" && message !== null && "origin" in message) {
        deliverReady = () => emit.call(child, event, ...values);
        markHeld();
        return true;
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const probe = fixtureProbe({
    server: {
      args: [
        "--input-type=module",
        "-e",
        `import { createServer } from "node:http";
const server = createServer((_, response) => response.end());
server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));`,
      ],
    },
  });
  t.after(() => probe.close());
  await probe.started;
  await Promise.race([held, probe.ready]);
  assert.equal(Boolean(probe.ownership), false);
  const rejection = assert.rejects(probe.ready, /closed/);
  const closed = probe.close();
  await rejection;
  assert.ok(deliverReady);
  deliverReady();
  await closed;
  await assert.rejects(probe.ready, /closed/);
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

for (const [label, stage, payload] of [
  ["reviewer completed false", "completed", { completed: false }],
  ["started false", "started", { started: false }],
  ["missing fields", "started", {}],
  ["non-object", "started", null],
  ["invalid origin", "ready", { origin: "garbage", fixturePid: 1 }],
  ["wrong type", "started", { started: "true" }],
  ["extra phase", "started", { started: true, completed: true }],
  ["invalid readiness", "ready", { origin: "http://127.0.0.1:1", fixturePid: "1" }],
  ["completed before ready", "started", { completed: true }],
  ["ready before started", "started", { origin: "http://127.0.0.1:1", fixturePid: 1 }],
  ["duplicate started", "ready", { started: true }],
  ["duplicate ready", "completed", { origin: "http://127.0.0.1:1", fixturePid: 1 }],
] as const) {
  test(`IPC protocol refuses ${label} and reaps its probe`, { timeout: 60000 }, async (t) => {
    const spawn = cp.spawn;
    t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
      const child = spawn(...args);
      const emit = child.emit;
      child.emit = function (event: string | symbol, ...values: unknown[]) {
        if (event === "message") {
          const message = values[0];
          if (
            typeof message === "object" &&
            message !== null &&
            ((stage === "started" && "started" in message) || (stage === "ready" && "origin" in message))
          )
            values[0] = payload;
        }
        return emit.call(this, event, ...values);
      };
      if (stage === "completed")
        t.mock.method(child, "send", () => {
          queueMicrotask(() => child.emit("message", payload));
          return true;
        });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const probe = fixtureProbe({ scenario: "early-ready", expected: "impossible assertion" });
    t.after(() => probe.close());
    await assert.rejects(probe.exercise("adapter"), /protocol/);
    if (stage === "started") await assert.rejects(probe.started, /protocol/);
    await probe.close();
    assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
  });
}

test("IPC protocol refuses completion while Ready and reaps its fixture", { timeout: 60000 }, async (t) => {
  const spawn = cp.spawn;
  let child: ReturnType<typeof cp.spawn> | undefined;
  t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    child = spawn(...args);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const probe = fixtureProbe();
  t.after(() => probe.close());
  const { origin, fixturePid } = await probe.ready;
  assert.ok(child);
  child.emit("message", { completed: true });
  await assert.rejects(probe.exercise("adapter"), /protocol unexpected completed in Ready/);
  await probe.close();
  await assert.rejects(fetch(origin));
  for (const pid of [probe.pid, fixturePid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("IPC protocol failure during Closing cannot become exercise success", { timeout: 60000 }, async (t) => {
  const spawn = cp.spawn;
  let child: ReturnType<typeof cp.spawn> | undefined;
  t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    child = spawn(...args);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const probe = fixtureProbe({ scenario: "early-ready" });
  t.after(() => probe.close());
  await probe.ready;
  const closed = probe.close();
  assert.ok(child);
  child.emit("message", { completed: false });
  await closed;
  await assert.rejects(probe.exercise("adapter"), /protocol/);
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });
});
