import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { chromium as driver } from "playwright";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { prove } from "../scripts/prove-home-working-week.ts";
import { workingWeekAssets } from "./fixtures/home-working-week.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { assertProofDeadlineCleanup } from "./proof-browser-harness.mjs";

const exec = promisify(execFile);
const commit = "1".repeat(40);
test("working week proof passes current-source fixture and rejects near-miss labels and old releases", async () => {
  const assets = await workingWeekAssets();
  for (const mode of ["pass", "near-miss", "older", "unreachable"] as const) {
    const changed = new Map(
      [...assets].map(([path, value]) => [
        path,
        {
          ...value,
          body:
            mode === "near-miss" && path.startsWith("/js/ui-")
              ? Buffer.from(
                  value.body.toString().replace(/children:([a-zA-Z_$][\w$]*)\.label/g, 'children:"Incorrect label"'),
                )
              : value.body,
        },
      ]),
    );
    const server = await startWorkerFixture({
      assets: changed,
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({
              service: "doctorcre-app",
              environment: "production",
              source_commit: mode === "older" ? "2".repeat(40) : commit,
            }),
          },
        ],
      ]),
      env: {
        APP_ENV: "fixture",
        GIT_SHA: mode === "older" ? "2".repeat(40) : commit,
        CARR: { fetch: async () => new Response("synthetic") },
      },
    });
    try {
      if (mode === "pass") {
        const result = await exec(process.execPath, [
          "scripts/prove-home-working-week.ts",
          "--origin",
          server.origin,
          "--expected-commit",
          commit,
          "--fixture",
        ]);
        assert.equal(JSON.parse(result.stdout).status, "passed");
      } else if (mode === "near-miss") {
        await assert.rejects(
          exec(process.execPath, [
            "scripts/prove-home-working-week.ts",
            "--origin",
            server.origin,
            "--expected-commit",
            commit,
            "--fixture",
          ]),
          (error) => error instanceof Error && "code" in error && error.code === 1,
        );
      } else {
        await assert.rejects(
          prove({
            origin: server.origin,
            expectedCommit: commit,
            fixture: mode !== "unreachable",
            ...(mode === "unreachable" ? { cdpUrl: "http://127.0.0.1:1" } : {}),
          }),
          (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
        );
      }
    } finally {
      await server.close();
    }
  }
});

for (const mode of ["late launch", "stalled evaluation"] as const) {
  test(`working week proof cleans up ${mode}`, async (t) => {
    const server = await startWorkerFixture({
      assets: await workingWeekAssets(),
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
          },
        ],
      ]),
      env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
    });
    t.after(() => server.close());
    await assertProofDeadlineCleanup(t, {
      entry: "scripts/prove-home-working-week.ts",
      args: ["--origin", server.origin, "--expected-commit", commit, "--fixture"],
      mode,
    });
  });
}

test("real CDP deadline closes delayed page and preserves the original tab", async (t) => {
  const fixture = await ownedCdpFixture();
  t.after(() => fixture.close());
  const { context, page: originalTab, endpoint: cdpUrl } = fixture;
  assert.ok(originalTab);
  const before = context.pages().length;
  const connect = driver.connectOverCDP.bind(driver);
  let delayedTab: import("playwright").Page | undefined;
  t.mock.method(driver, "connectOverCDP", async (...args: Parameters<typeof connect>) => {
    const browser = await connect(...args);
    const borrowed = browser.contexts()[0];
    assert.ok(borrowed);
    const newPage = borrowed.newPage.bind(borrowed);
    t.mock.method(borrowed, "newPage", async () => {
      delayedTab = await newPage();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return delayedTab;
    });
    return browser;
  });
  const server = await startWorkerFixture({
    routes: new Map([
      [
        "/app-release",
        {
          contentType: "application/json",
          body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
        },
      ],
    ]),
  });
  t.after(() => server.close());
  await assert.rejects(prove({ origin: server.origin, expectedCommit: commit, cdpUrl, timeoutMs: 1200 }), {
    exitCode: 78,
  });
  assert.ok(delayedTab, "newPage acquired a real tab before its delayed return");
  assert.equal(delayedTab.isClosed(), true);
  const fresh = await connect(cdpUrl);
  try {
    const remainingContext = fresh.contexts()[0];
    assert.ok(remainingContext);
    assert.equal(remainingContext.pages().length, before);
    assert.equal(originalTab.isClosed(), false);
    assert.equal(await originalTab.evaluate(() => 1), 1);
  } finally {
    await fresh.close();
  }
  t.diagnostic(
    `exit 78; tabs before ${before}; tabs after ${context.pages().length}; delayed tab closed; original tab usable`,
  );
});
