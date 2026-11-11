import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { launch } from "@puppeteer/browsers";
import { chromium } from "playwright";
import { hideProfileMarker } from "./cdp-negative-corpus.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { ownedBrowserProcesses } from "./proof-browser-harness.mjs";
import { unreachableCdpEndpoint } from "./unreachable-cdp-fixture.ts";

test("fixture refuses an unreachable advertised endpoint and disposes its process", async () => {
  const endpoint = new URL(await unreachableCdpEndpoint());
  endpoint.protocol = "ws:";
  endpoint.pathname = "/devtools/browser/negative";
  let pid: number | undefined;
  await assert.rejects(
    ownedCdpFixture({
      launcher: () => {
        const child = launch({
          executablePath: process.execPath,
          args: [
            "-e",
            `process.stderr.write(${JSON.stringify(`DevTools listening on ${endpoint.href}\n`)});setInterval(()=>{},1000)`,
          ],
        });
        pid = child.nodeProcess.pid;
        return child;
      },
    }),
    /Connecting/,
  );
  assert.ok(pid);
  const ownedPid = pid;
  assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
});

for (const stage of ["Starting", "AwaitingEndpoint", "Connecting"] as const) {
  test(`fixture abort during ${stage} drains every acquisition`, async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    let disconnected = false;
    await assert.rejects(
      ownedCdpFixture({
        signal: controller.signal,
        launcher: async () => {
          if (stage === "Starting") {
            controller.abort();
            await delay(30);
          }
          const child = launch({
            executablePath: process.execPath,
            args: [
              "-e",
              stage === "Connecting"
                ? 'process.stderr.write("DevTools listening on ws://127.0.0.1:1234/devtools/browser/test\\n");setInterval(()=>{},1000)'
                : "setInterval(()=>{},1000)",
            ],
          });
          pid = child.nodeProcess.pid;
          if (stage === "AwaitingEndpoint") setTimeout(() => controller.abort(), 50);
          return child;
        },
        connect: async () => {
          controller.abort();
          await delay(40);
          disconnected = true;
          throw Error("connection cancelled");
        },
      }),
      new RegExp(stage),
    );
    assert.ok(pid);
    const ownedPid = pid;
    assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
    assert.equal(disconnected, stage === "Connecting");
  });
}

test("cleanup budget reports a stalled connection and disposes its late completion", async () => {
  let release: () => void = () => {};
  let pid: number | undefined;
  let disconnected = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    ownedCdpFixture({
      timeoutMs: 3000,
      cleanupTimeoutMs: 50,
      launcher: (options) => {
        const child = launch(options);
        pid = child.nodeProcess.pid;
        return child;
      },
      connect: async (endpoint, options) => {
        const browser = await chromium.connectOverCDP(endpoint, options);
        const close = browser.close.bind(browser);
        browser.close = async () => {
          await close();
          disconnected = true;
        };
        await waiting;
        return browser;
      },
    }),
    /cleanup deadline/,
  );
  assert.ok(pid);
  const ownedPid = pid;
  assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
  release();
  await delay(100);
  assert.equal(disconnected, true);
});

for (const mode of ["chunked stderr", "early readiness", "malformed endpoint", "early exit", "timeout"] as const) {
  test(`fixture ${mode}`, async () => {
    let pid: number | undefined;
    const script =
      mode === "early exit"
        ? "process.exit(7)"
        : mode === "timeout"
          ? "setInterval(()=>{},1000)"
          : mode === "chunked stderr"
            ? 'process.stderr.write("DevTools list");setTimeout(()=>process.stderr.write("ening on ws://127.0.0.1:1234/devtools/browser/test\\n"),20);setInterval(()=>{},1000)'
            : `process.stderr.write('DevTools listening on ${mode === "malformed endpoint" ? "https://example.com/bad" : "ws://127.0.0.1:1234/devtools/browser/test"}\\n');setInterval(()=>{},1000)`;
    await assert.rejects(
      ownedCdpFixture({
        timeoutMs: 250,
        launcher: async () => {
          const child = launch({ executablePath: process.execPath, args: ["-e", script] });
          pid = child.nodeProcess.pid;
          if (mode === "early readiness") await delay(80);
          return child;
        },
        connect: async (endpoint) => {
          assert.equal(endpoint, "ws://127.0.0.1:1234/devtools/browser/test");
          throw Error("handshake reached");
        },
      }),
      mode === "chunked stderr" || mode === "early readiness" ? /Connecting.*handshake reached/s : /AwaitingEndpoint/,
    );
    assert.ok(pid);
    const ownedPid = pid;
    assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
  });
}

test("fixture late launch disposes the late process", async () => {
  let pid: number | undefined;
  await assert.rejects(
    ownedCdpFixture({
      timeoutMs: 30,
      launcher: async () => {
        await delay(80);
        const child = launch({ executablePath: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
        pid = child.nodeProcess.pid;
        return child;
      },
    }),
    /Starting/,
  );
  assert.ok(pid);
  const ownedPid = pid;
  assert.throws(() => process.kill(ownedPid, 0), /ESRCH/);
});

test("live fixture acquires without profile file and closes idempotently", async () => {
  const fixture = await ownedCdpFixture({
    launcher: async (options) => {
      const child = launch(options);
      await child.waitForLineOutput(/^DevTools listening on (.*)$/, 30000);
      const profile = options.args?.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
      assert.ok(profile);
      hideProfileMarker(profile);
      return child;
    },
  });
  const marker = hideProfileMarker(fixture.profile);
  assert.equal(existsSync(marker), false);
  const observer = await chromium.connectOverCDP(fixture.endpoint);
  assert.equal(
    await observer
      .contexts()[0]
      ?.pages()[0]
      ?.evaluate(() => 2 + 2),
    4,
  );
  await observer.close();
  const pid = fixture.pid;
  await Promise.all([fixture.close(), fixture.close()]);
  assert.equal(existsSync(fixture.profile), false);
  assert.deepEqual(ownedBrowserProcesses(fixture.profile), []);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("fixture late connection is disconnected before cleanup finishes", async () => {
  let disconnected = false;
  await assert.rejects(
    ownedCdpFixture({
      timeoutMs: 2500,
      connect: async (endpoint, options) => {
        const browser = await chromium.connectOverCDP(endpoint, options);
        const close = browser.close.bind(browser);
        browser.close = async () => {
          await close();
          disconnected = true;
        };
        await delay(2700);
        return browser;
      },
    }),
    /Connecting/,
  );
  assert.equal(disconnected, true);
});

test("ready fixture disposes after owned process death", async () => {
  const fixture = await ownedCdpFixture();
  process.kill(fixture.pid, "SIGKILL");
  await fixture.closed;
  assert.equal(existsSync(fixture.profile), false);
  assert.equal(fixture.browser.isConnected(), false);
  assert.deepEqual(ownedBrowserProcesses(fixture.profile), []);
});
