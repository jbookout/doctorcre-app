import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium as driver } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { prove } from "../scripts/prove-vendor-meetings.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";
import { assertProofDeadlineCleanup } from "./proof-browser-harness.mjs";

const exec = promisify(execFile);
const commit = "1".repeat(40);
const recordings = JSON.parse(
  await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
);
const assets = await appAssetSnapshot();
async function fixture(t: import("node:test").TestContext, mode = "ready", source = commit) {
  const snapshot = new Map(
    [...assets].map(([path, value]) => [
      path,
      {
        ...value,
        body:
          mode === "near-miss" && path === "/js/ui-vendor-meetings.js"
            ? Buffer.from(
                value.body
                  .toString()
                  .replaceAll("Meeting reason not recorded", "Wrong reason")
                  .replaceAll("row.reason ||", '"Wrong reason" ||'),
              )
            : value.body,
      },
    ]),
  );
  const server = await startWorkerFixture({
    assets: snapshot,
    env: {
      APP_ENV: "production",
      GIT_SHA: source,
      CARR: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/v1/business/")) return Response.json(directoryFixture(request.url));
          if (url.pathname === "/mcp") {
            const body = await request.json();
            const payload = body.params.name === "read-vendor-meetings" ? recordings[body.params.arguments.view] : {};
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          }
          return new Response("signed in");
        },
      },
    },
  });
  t.after(() => server.close());
  return server;
}
test("proof CLI passes exact values and rejects near-miss rendered values", async (t) => {
  const server = await fixture(t);
  const result = await exec(process.execPath, [
    "scripts/prove-vendor-meetings.ts",
    "--origin",
    server.origin,
    "--expected-commit",
    commit,
    "--fixture",
  ]);
  assert.equal(JSON.parse(result.stdout).status, "passed");
  t.diagnostic("CLI fixture pass exit 0");
  const broken = await fixture(t, "near-miss");
  await assert.rejects(
    exec(process.execPath, [
      "scripts/prove-vendor-meetings.ts",
      "--origin",
      broken.origin,
      "--expected-commit",
      commit,
      "--fixture",
    ]),
    (error) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal(error.code, 1);
      return true;
    },
  );
  t.diagnostic("CLI near-miss failure exit 1");
});

test("proof release gate admits equality and descendants and refuses old unrelated and unknown releases", async (t) => {
  const root = temporaryDirectory("vendor-meetings-ancestry-", t);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Synthetic");
  await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(root + "/file", "one");
  await git("add", "file");
  await git("commit", "-qm", "one");
  const first = await git("rev-parse", "HEAD");
  await writeFile(root + "/file", "two");
  await git("commit", "-qam", "two");
  const second = await git("rev-parse", "HEAD");
  await git("checkout", "--orphan", "unrelated");
  await git("commit", "-qm", "unrelated");
  const unrelated = await git("rev-parse", "HEAD");
  const previous = process.cwd();
  try {
    process.chdir(root);
    for (const [expected, released, passes] of [
      [first, first, true],
      [first, second, true],
      [second, first, false],
      [first, unrelated, false],
      [first, "f".repeat(40), false],
    ] satisfies [string, string, boolean][]) {
      const server = await fixture(t, "ready", released);
      if (passes)
        assert.equal(
          (await prove({ origin: server.origin, expectedCommit: expected, fixture: true })).status,
          "passed",
        );
      else
        await assert.rejects(prove({ origin: server.origin, expectedCommit: expected, fixture: true }), {
          exitCode: 78,
        });
    }
  } finally {
    process.chdir(previous);
  }
});
test("containing release with unreachable CDP is insufficient evidence", async (t) => {
  const server = await fixture(t);
  await assert.rejects(
    prove({ origin: server.origin, expectedCommit: commit, cdpUrl: "http://127.0.0.1:1", timeoutMs: 3000 }),
    { exitCode: 78 },
  );
});

for (const mode of ["late launch", "stalled evaluation"])
  test(`proof deadline cleans ${mode}`, async (t) => {
    const server = await fixture(t);
    await assertProofDeadlineCleanup(t, {
      entry: "scripts/prove-vendor-meetings.ts",
      args: ["--origin", server.origin, "--expected-commit", commit, "--fixture"],
      mode,
      timeoutMs: 3000,
    });
  });

test("real CDP deadline closes delayed page and preserves the original tab", async (t) => {
  const root = temporaryDirectory("vendor-meetings-cdp-", t);
  const context = await driver.launchPersistentContext(root, {
    headless: true,
    args: [...CHROMIUM_SAFETY_ARGS, "--remote-debugging-port=0"],
  });
  t.after(() => context.close());
  const originalTab = context.pages()[0];
  assert.ok(originalTab);
  const before = context.pages().length;
  const port = (await readFile(join(root, "DevToolsActivePort"), "utf8")).split("\n")[0];
  const cdpUrl = `http://127.0.0.1:${port}`;
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
  const server = await fixture(t);
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
