import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureServer } from "./browser-harness.mjs";

const input: unknown = JSON.parse(process.argv[2] ?? "{}");
assert.ok(typeof input === "object" && input !== null);
const options = {
  root: "root" in input && typeof input.root === "string" ? input.root : undefined,
  expected:
    "expected" in input && (typeof input.expected === "string" || input.expected === null) ? input.expected : undefined,
  delayMs: "delayMs" in input && typeof input.delayMs === "number" ? input.delayMs : 0,
  scenario: "scenario" in input && typeof input.scenario === "string" ? input.scenario : undefined,
};
let closing = false;
let server: { origin: string; close: () => Promise<void> } | undefined;
let acquisition: Promise<void>;
let interval: ReturnType<typeof setInterval> | undefined;
const close = async () => {
  closing = true;
  await acquisition;
  clearInterval(interval);
  await server?.close();
  if (process.connected) process.disconnect?.();
};
process.on("SIGTERM", () => {
  if (options.scenario !== "ignore-close") void close();
});
process.on("disconnect", () => {
  void close();
});
process.send?.({ started: true });
acquisition = (async () => {
  if (options.scenario === "early-exit") process.exit(2);
  if (options.scenario === "never-ready") {
    interval = setInterval(() => {}, 1000);
    return;
  }
  if (options.delayMs) await delay(options.delayMs);
  if (options.scenario === "late-ready") await delay(100);
  if (options.scenario === "early-ready" || options.scenario === "ignore-close") {
    process.send?.({ origin: "http://127.0.0.1:1", fixturePid: process.pid });
    return;
  }
  server = await fixtureServer(options.root === undefined ? {} : { root: options.root });
  const fixturePid = Number(execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim());
  assert.ok(Number.isSafeInteger(fixturePid) && fixturePid > 0, "one owned fixture child");
  if (!closing || options.scenario === "late-ready") process.send?.({ origin: server.origin, fixturePid });
})();
await acquisition;
process.on("message", async (message: unknown) => {
  if (
    closing ||
    typeof message !== "object" ||
    message === null ||
    !("command" in message) ||
    message.command !== "assert"
  )
    return;
  try {
    assert.ok(server);
    assert.equal((await fetch(`${server.origin}/unadmitted.txt`)).status, 404);
    const response = await fetch(`${server.origin}/fixture-root-probe.txt`);
    if (options.expected === null) {
      assert.equal(response.status, 404);
      assert.equal((await fetch(`${server.origin}/`)).status, 200);
    } else {
      assert.equal(response.status, 200);
      assert.equal(await response.text(), options.expected);
    }
    const stopped = server.close();
    assert.equal(typeof stopped.then, "function");
    await stopped;
    await assert.rejects(fetch(server.origin));
    await server.close();
    process.send?.({ completed: true });
    await close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await close();
  }
});
