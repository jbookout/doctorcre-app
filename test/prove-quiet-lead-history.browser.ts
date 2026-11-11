import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { startFixture } from "../scripts/fixture-http.mjs";
import { prove } from "../scripts/prove-quiet-lead-history.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { assertProofDeadlineCleanup } from "./proof-browser-harness.mjs";

const run = promisify(execFile),
  commit = "1".repeat(40);
const entry = fileURLToPath(new URL("../scripts/prove-quiet-lead-history.ts", import.meta.url));
const release = (source_commit: string) =>
  JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit });
async function server(t: TestContext, source = commit) {
  const fixture = await startFixture({
    routes: new Map([["/app-release", { contentType: "application/json", body: release(source) }]]),
  });
  t.after(() => fixture.close());
  return fixture;
}
const args = (origin: string) => [entry, "--fixture", "--origin", origin, "--expected-commit", commit];
async function code(call: Promise<{ stdout: string }>, expected: number, t?: TestContext) {
  try {
    const result = await call;
    assert.equal(expected, 0, result.stdout);
    t?.diagnostic(result.stdout.trim());
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error && typeof error.stdout === "string");
    assert.equal(error.code, expected, error.stdout || error.message);
    t?.diagnostic(`exit ${error.code} ${error.stdout.trim()}`);
    return JSON.parse(error.stdout);
  }
}
test("actual CLI fixture succeeds and wrong visible ID and near-miss count fail", async (t) => {
  const fixture = await server(t);
  assert.equal((await code(run(process.execPath, args(fixture.origin)), 0, t)).writes, 0);
  for (const fault of ["id", "count"]) {
    const root = temporaryDirectory("history-negative-", t),
      preload = join(root, "preload.mjs");
    await writeFile(
      preload,
      `import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
      const launch = chromium.launch.bind(chromium);
      chromium.launch = async options => {
        const browser = await launch(options), newPage = browser.newPage.bind(browser);
        browser.newPage = async (...args) => {
          const page = await newPage(...args);
          await page.addInitScript(fault => new MutationObserver(() => {
            if (fault === 'id') for (const n of document.querySelectorAll('[data-quiet-lead]')) n.dataset.quietLead = 'wrong';
            else for (const n of document.querySelectorAll('#quietFollowUps p[role="status"]')) {
              if (n.textContent.startsWith('Showing 1–')) n.textContent = n.textContent.replace('Showing 1–', 'Showing 11–');
            }
          }).observe(document, { subtree: true, childList: true, characterData: true }), ${JSON.stringify(fault)});
          return page;
        }; return browser;
      };`,
    );
    await code(run(process.execPath, ["--import", preload, ...args(fixture.origin)]), 1, t);
  }
});
for (const kind of ["equal", "descendant", "older", "unrelated", "unknown"])
  test(`actual CLI release ${kind}`, async (t) => {
    const cwd = temporaryDirectory("history-git-", t);
    const git = async (...args: string[]) =>
      (
        await run("git", args, {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        })
      ).stdout.trim();
    await git("init", "-q");
    await writeFile(join(cwd, "fixture.txt"), "synthetic");
    await git("add", "fixture.txt");
    const tree = await git("write-tree");
    const older = await git("commit-tree", tree, "-m", "older");
    const expected = await git("commit-tree", tree, "-p", older, "-m", "expected");
    const descendant = await git("commit-tree", tree, "-p", expected, "-m", "descendant");
    const unrelated = await git("commit-tree", tree, "-m", "unrelated");
    const fixture = await server(t, { equal: expected, descendant, older, unrelated, unknown: "0".repeat(40) }[kind]);
    await code(
      run(process.execPath, [entry, "--fixture", "--origin", fixture.origin, "--expected-commit", expected], { cwd }),
      ["equal", "descendant"].includes(kind) ? 0 : 78,
      t,
    );
  });
test("unreachable CDP is insufficient evidence", async (t) => {
  const fixture = await server(t);
  await code(
    run(process.execPath, [
      entry,
      "--origin",
      fixture.origin,
      "--expected-commit",
      commit,
      "--cdp-url",
      "http://127.0.0.1:1",
    ]),
    78,
    t,
  );
});
test("registry refusal and no eligible subjects exit 78", async (t) => {
  const fixture = await server(t),
    root = temporaryDirectory("history-refusal-", t);
  const snapshot = JSON.parse(
    await readFile(new URL("./fixtures/quiet-lead-owner-pages/recordings.json", import.meta.url), "utf8"),
  );
  const path = join(root, "empty.json");
  await writeFile(path, JSON.stringify({ ...snapshot, proposals: [] }));
  await code(run(process.execPath, [...args(fixture.origin), "--recording", path]), 78, t);
  const preload = join(root, "registry.mjs");
  await writeFile(
    preload,
    `import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async options => {
      const browser = await launch(options), newPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await newPage(...args);
        await page.addInitScript(() => {
          const request = window.fetch;
          window.fetch = (url, options) => JSON.parse(options?.body || '{}').params?.name === 'list-verbs'
            ? Promise.resolve(new Response('{}', { status: 403 })) : request(url, options);
        }); return page;
      }; return browser;
    };`,
  );
  await code(run(process.execPath, ["--import", preload, ...args(fixture.origin)]), 78, t);
});
for (const mode of ["late launch", "stalled evaluation"])
  test(`deadline cleanup ${mode}`, async (t) => {
    const fixture = await server(t);
    await assertProofDeadlineCleanup(t, { entry, args: args(fixture.origin).slice(1), mode, timeoutMs: 2000 });
  });
test("stalled evaluation cleanup waits for slow page acquisition", async (t) => {
  const fixture = await server(t);
  await assertProofDeadlineCleanup(t, {
    entry,
    args: args(fixture.origin).slice(1),
    mode: "stalled evaluation",
    timeoutMs: 2000,
    acquisitionDelayMs: 2200,
  });
});
test("changing release and stalled release are insufficient evidence", async (t) => {
  const fixture = await server(t);
  let reads = 0;
  await assert.rejects(
    prove({
      origin: fixture.origin,
      fixture: true,
      expectedCommit: commit,
      ancestry: async () => true,
      readRelease: async () => ({ source_commit: ++reads === 1 ? commit : "2".repeat(40) }),
    }),
    { exitCode: 78 },
  );
  await assert.rejects(prove({ expectedCommit: commit, timeoutMs: 20, readRelease: () => new Promise(() => {}) }), {
    exitCode: 78,
  });
});
test("late newPage closes before CDP disconnect and fresh connection sees no added tab", async (t) => {
  const { chromium } = await import("playwright");

  const ownedFixture = await ownedCdpFixture();
  t.after(() => ownedFixture.close());
  const owned = ownedFixture.browser;
  const endpoint = ownedFixture.endpoint;
  t.after(() => owned.close());
  const existing = ownedFixture.page;
  let created: Page | undefined;
  const engine = {
    connectOverCDP: async () => {
      const browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0];
      assert.ok(context);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        created = await newPage();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return created;
      };
      return browser;
    },
  };
  await assert.rejects(
    prove({
      expectedCommit: commit,
      cdpUrl: endpoint,
      engine,
      timeoutMs: 1000,
      readRelease: async () => ({ source_commit: commit }),
    }),
    { exitCode: 78 },
  );
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const fresh = await chromium.connectOverCDP(endpoint);
  try {
    assert.ok(created, "page creation actually executed");
    assert.equal(fresh.contexts()[0]?.pages().length, 1);
    assert.equal(existing.isClosed(), false);
  } finally {
    await fresh.close();
  }
});
