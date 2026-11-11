import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium as driver } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { startFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "../scripts/proof-browser.mjs";
import { signedInReplyEngine } from "../scripts/prove-reply-action-link.ts";
import { prove } from "../scripts/prove-tour-stop-drag.ts";
import { fixtureDeal, tourDragRoutes } from "./tour-stop-drag-proof-fixture.ts";

const commit = "1".repeat(40);
const exec = promisify(execFile);
for (const mode of ["pass", "near-miss", "legacy", "unreachable"] as const)
  test(`Tour proof shared CDP CLI ${mode}`, async (t) => {
    const routes = await tourDragRoutes(mode === "near-miss" ? mode : "pass");
    if (mode === "legacy")
      routes.set("/tours/route-editor.html", { contentType: "text/html", body: "<h1>Synthetic legacy Tour</h1>" });
    const server = await startFixture({ routes });
    t.after(() => server.close());
    const portServer = await startFixture();
    const port = new URL(portServer.origin).port;
    await portServer.close();
    const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
    t.after(() => browser.close());
    const endpoint = `http://127.0.0.1:${port}`;
    const initial = await driver.connectOverCDP(endpoint);
    t.after(() => initial.close());
    const context = initial.contexts()[0];
    assert.ok(context);
    const sentinel = await context.newPage();
    const before = context.pages().length;
    const args = [
      "scripts/prove-tour-stop-drag.ts",
      "--origin",
      server.origin,
      "--expected-commit",
      commit,
      "--cdp-url",
      mode === "unreachable" ? "http://127.0.0.1:1" : endpoint,
      "--tour-url",
      `${server.origin}/${mode === "legacy" ? "tours/route-editor.html" : `deals?deal=${fixtureDeal}`}`,
      "--timeout-ms",
      "10000",
    ];
    if (mode === "pass") {
      const result = JSON.parse((await exec(process.execPath, args)).stdout);
      assert.equal(result.observations.length, 4);
      assert.equal(result.writes, 0);
    } else
      await assert.rejects(exec(process.execPath, args), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, mode === "near-miss" ? 1 : 78, String(error.stderr));
        if (mode === "legacy") assert.match(String(error.stderr), /No qualified Tour.*legacy/);
        return true;
      });
    const fresh = await driver.connectOverCDP(endpoint);
    assert.equal(fresh.contexts()[0]?.pages().length, before);
    assert.equal(sentinel.isClosed(), false);
    await fresh.close();
    assert.equal(browser.isConnected(), true);
  });

for (const scenario of ["late page", "late launch", "stalled evaluation"] as const)
  test(`Tour proof deadline cleans ${scenario} without closing shared tabs`, async (t) => {
    const server = await startFixture({ routes: await tourDragRoutes() });
    t.after(() => server.close());
    const portServer = await startFixture();
    const port = new URL(portServer.origin).port;
    await portServer.close();
    const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
    t.after(() => browser.close());
    const endpoint = `http://127.0.0.1:${port}`;
    const initial = await driver.connectOverCDP(endpoint);
    t.after(() => initial.close());
    const initialContext = initial.contexts()[0];
    assert.ok(initialContext);
    const sentinel = await initialContext.newPage();
    const before = initialContext.pages().length;
    const ready = Promise.withResolvers<void>();
    const engine = signedInReplyEngine(endpoint, {
      async connectOverCDP(...args) {
        const connection = await driver.connectOverCDP(...args);
        if (scenario === "late launch") {
          ready.resolve();
          await delay(1300);
        }
        const context = connection.contexts()[0];
        assert.ok(context);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          if (scenario === "late page") {
            ready.resolve();
            await delay(1300);
          }
          if (scenario === "stalled evaluation")
            page.goto = async () => {
              ready.resolve();
              await new Promise<void>((resolve) => page.once("close", () => resolve()));
              throw Error("closed stalled navigation");
            };
          return page;
        };
        return connection;
      },
    });
    const result = assert.rejects(
      prove({
        origin: server.origin,
        expectedCommit: commit,
        tourUrl: `${server.origin}/deals?deal=${fixtureDeal}`,
        engine,
        timeoutMs: 1000,
      }),
      { exitCode: 78 },
    );
    await ready.promise;
    await result;
    const fresh = await driver.connectOverCDP(endpoint);
    assert.equal(fresh.contexts()[0]?.pages().length, before);
    assert.equal(sentinel.isClosed(), false);
    await fresh.close();
    assert.equal(browser.isConnected(), true);
  });
