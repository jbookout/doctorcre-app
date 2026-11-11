import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { validateLeadDetail, validateLeadWorkspace } from "../js/leads-client.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "../scripts/proof-browser.mjs";
import { prove } from "../scripts/prove-research-source.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import recording from "./fixtures/research-source/recordings.json" with { type: "json" };
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { unreachableCdpEndpoint } from "./unreachable-cdp-fixture.ts";

validateLeadWorkspace(recording);
validateLeadDetail(recording.detail, recording.detail.id);

import registryRecording from "./fixtures/walk-verb-registry.json" with { type: "json" };

const registry = registryRecording.response;
const assets = await appAssetSnapshot();
async function fixture(t: TestContext, mode: string) {
  const history = temporaryDirectory("research-source-history-", t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: history, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  const commit = async (text: string) => {
    await writeFile(resolve(history, "revision"), text);
    git("add", "revision");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      text,
    );
    return git("rev-parse", "HEAD");
  };
  const older = await commit("older"),
    expectedCommit = await commit("expected"),
    descendant = await commit("descendant");
  git("checkout", "--orphan", "unrelated");
  const unrelated = await commit("unrelated");
  const released =
    new Map([
      ["older", older],
      ["descendant", descendant],
      ["unrelated", unrelated],
      ["unknown", "f".repeat(40)],
    ]).get(mode) || expectedCommit;
  const snapshot = new Map(
    [...assets].map(([path, value]) => [
      path,
      {
        ...value,
        body:
          mode === "failure" && path === "/js/ui-lead-research.js"
            ? value.body.toString().replaceAll("data-flag-id", "data-wrong-id")
            : value.body,
      },
    ]),
  );
  const server = await startWorkerFixture({
    assets: snapshot,
    env: {
      APP_ENV: "production",
      GIT_SHA: released,
      CARR: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/mcp") {
            const body: unknown = await request.json();
            assert.ok(body && typeof body === "object" && "id" in body && "params" in body);
            assert.ok(body.params && typeof body.params === "object" && "name" in body.params);
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      body.params?.name === "lead-board"
                        ? recording
                        : body.params?.name === "list-verbs"
                          ? mode === "metadata"
                            ? {}
                            : mode === "write"
                              ? {
                                  ...registry,
                                  verbs: registry.verbs.map((verb) =>
                                    verb.name === "lead-board" ? { ...verb, write: true } : verb,
                                  ),
                                }
                              : registry
                          : { error: "fixture_read_unavailable" },
                    ),
                  },
                ],
              },
            });
          }
          return Response.json({ actor: { slug: "example-partner" }, csrf_token: "synthetic-test-token" });
        },
      },
    },
  });
  t.after(() => server.close());
  return { origin: server.origin, expectedCommit, ancestryCwd: history };
}
for (const mode of ["equal", "descendant", "older", "unrelated", "unknown", "failure", "session"])
  test(`proof ${mode}`, async (t) => {
    const options = await fixture(t, mode);
    if (["older", "unrelated", "unknown", "session"].includes(mode)) {
      await assert.rejects(
        prove(options),
        (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
      );
      return;
    }
    if (mode === "equal" || mode === "failure") {
      const browserFixture = await ownedCdpFixture();
      t.after(() => browserFixture.close());
      const browser = browserFixture.browser;
      t.after(() => browser.close());
      const args = [
        "scripts/prove-research-source.ts",
        "--origin",
        options.origin,
        "--expected-commit",
        options.expectedCommit,
        "--cdp-url",
        browserFixture.endpoint,
      ];
      if (mode === "failure")
        await assert.rejects(
          promisify(execFile)(process.execPath, args),
          (error) => error instanceof Error && "code" in error && error.code === 1,
        );
      else assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args)).stdout).status, "passed");
      assert.ok(browser.isConnected(), "proof disconnect preserves acquired test browser");
      assert.equal((await browser.newContext()).pages().length, 0);
      return;
    }
    const browser = await chromium.launch();
    t.after(() => browser.close());
    await browser.newContext();
    const engine = { connectOverCDP: async () => browser };
    assert.equal((await prove({ ...options, engine, cdpUrl: "fixture" })).status, "passed");
  });
for (const mode of ["late connection", "stalled evaluation"])
  test(`proof deadline cleans ${mode}`, async (t) => {
    const options = await fixture(t, "equal");
    let closed = 0,
      pageClosed = 0;
    const page = {
      setDefaultTimeout() {},
      route: async () => {},
      goto: async () => null,
      evaluate: async () => {
        await new Promise(() => {});
        throw Error("unreachable");
      },
      locator: () => {
        throw Error("not reached");
      },
      close: async () => {
        pageClosed++;
      },
    };
    const connection = { contexts: () => [{ newPage: async () => page }], close: async () => closed++ };
    const engine = {
      connectOverCDP: async () => {
        if (mode === "late connection") await new Promise((resolve) => setTimeout(resolve, 150));
        return connection;
      },
    };
    await assert.rejects(
      prove({ ...options, engine, cdpUrl: "fixture", timeoutMs: 100 }),
      (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(closed, 1);
    assert.equal(pageClosed, mode === "late connection" ? 0 : 1);
  });

async function borrowedBrowser(t: TestContext) {
  const browserFixture = await ownedCdpFixture();
  t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  t.after(() => browser.close());
  const cdpUrl = browserFixture.endpoint;
  const { chromium: cdp } = await import("playwright");
  const connection = await cdp.connectOverCDP(cdpUrl);
  t.after(() => connection.close());
  return { browser, connection, cdp, cdpUrl };
}

test("proof CLI returns 78 when the context retires during page acquisition", async (t) => {
  const options = await fixture(t, "equal");
  const { browser, cdpUrl } = await borrowedBrowser(t);
  const scratch = temporaryDirectory("research-source-retired-context-", t);
  const preload = resolve(scratch, "retire.mjs");
  const playwrightUrl = import.meta.resolve("playwright");
  await writeFile(
    preload,
    `
    import { chromium } from ${JSON.stringify(playwrightUrl)};
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        await connection.close();
        return newPage();
      };
      return connection;
    };
  `,
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "--import",
      preload,
      "scripts/prove-research-source.ts",
      "--origin",
      options.origin,
      "--expected-commit",
      options.expectedCommit,
      "--cdp-url",
      cdpUrl,
    ]),
    (error) => {
      assert.ok(error instanceof Error && "code" in error && "stdout" in error && typeof error.stdout === "string");
      assert.equal(error.code, 78);
      assert.equal(JSON.parse(error.stdout).status, "insufficient_evidence");
      return true;
    },
  );
  assert.ok(browser.isConnected(), "borrowed browser remains connected");
});

test("proof deadline closes a late CDP page before disconnecting and preserves existing tabs", async (t) => {
  const options = await fixture(t, "equal");
  const { browser, connection, cdp, cdpUrl } = await borrowedBrowser(t);
  const context = connection.contexts()[0];
  assert.ok(context);
  const existing = context.pages()[0] || (await context.newPage());
  await existing.goto("about:blank#existing");
  const newPage = context.newPage.bind(context);
  const acquisitions: Promise<Page>[] = [];
  context.newPage = () => {
    const acquisition = newPage().then(async (page) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return page;
    });
    acquisitions.push(acquisition);
    return acquisition;
  };
  const engine = { connectOverCDP: async () => connection };
  await assert.rejects(
    prove({ ...options, engine, cdpUrl, timeoutMs: 1000 }),
    (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
  );
  assert.equal(acquisitions.length, 1, "page acquisition started before deadline");
  await Promise.allSettled(acquisitions);
  const fresh = await cdp.connectOverCDP(cdpUrl);
  try {
    const freshContext = fresh.contexts()[0];
    assert.ok(freshContext);
    const pages = freshContext.pages();
    assert.equal(pages.length, 1, "only the existing tab remains");
    assert.equal(pages[0]?.url(), "about:blank#existing");
    assert.ok(browser.isConnected(), "borrowed browser remains connected");
  } finally {
    await fresh.close();
  }
});

for (const field of ["count", "state", "guidance"])
  test(`proof CLI rejects a near-miss displayed ${field}`, async (t) => {
    const options = await fixture(t, "equal");
    const { cdpUrl } = await borrowedBrowser(t);
    const scratch = temporaryDirectory("research-source-near-miss-", t);
    const preload = resolve(scratch, "corrupt-display.mjs");
    const source = recording.detail.research.evidence.find((item) => item.source.trim())?.source;
    assert.ok(source);
    const expectedCount = `${recording.detail.research.evidence.filter((item) => item.source === source).length} of ${recording.detail.research.evidence.length} loaded findings`;
    const expected = new Map([
      ["count", expectedCount],
      ["state", "Needs review"],
      ["guidance", recording.detail.research.next_step],
    ]).get(field);
    const displayed = field === "count" ? `1${expected}` : `No longer ${expected}`;
    await writeFile(
      preload,
      `
    import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      await context.addInitScript(({ expected, displayed }) => {
        new MutationObserver(() => {
          for (const element of document.querySelectorAll('#sourcedResearch > p')) {
            if (element.textContent === expected) element.textContent = displayed;
          }
        }).observe(document, { childList: true, subtree: true });
      }, ${JSON.stringify({ expected, displayed })});
      return connection;
    };
  `,
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        "--import",
        preload,
        "scripts/prove-research-source.ts",
        "--origin",
        options.origin,
        "--expected-commit",
        options.expectedCommit,
        "--cdp-url",
        cdpUrl,
      ]),
      (error) => {
        assert.ok(error instanceof Error && "code" in error && "stdout" in error && typeof error.stdout === "string");
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).status, "assertion_failure");
        return true;
      },
    );
  });

for (const acquisition of ["unreachable", "connection rejection", "page rejection"])
  test(`proof CLI returns 78 for ${acquisition}`, async (t) => {
    const options = await fixture(t, "equal");
    const scratch = temporaryDirectory("research-source-acquisition-", t);
    const preload = resolve(scratch, "reject-acquisition.mjs");
    await writeFile(
      preload,
      `
    import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
    ${
      acquisition === "unreachable"
        ? ""
        : `chromium.connectOverCDP = async () => {
      ${acquisition === "connection rejection" ? "throw Error('retired connection');" : "return { contexts: () => [{ newPage: async () => { throw Error('retired page'); } }], close: async () => {} };"}
    };`
    }
  `,
    );
    const cdpUrl = await unreachableCdpEndpoint();
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        "--import",
        preload,
        "scripts/prove-research-source.ts",
        "--origin",
        options.origin,
        "--expected-commit",
        options.expectedCommit,
        "--cdp-url",
        cdpUrl,
      ]),
      (error) => {
        assert.ok(error instanceof Error && "code" in error && "stdout" in error && typeof error.stdout === "string");
        assert.equal(error.code, 78);
        assert.equal(JSON.parse(error.stdout).status, "insufficient_evidence");
        return true;
      },
    );
  });

for (const mode of ["metadata", "write"])
  test(`proof refuses ${mode} before business RPC`, async (t) => {
    const options = await fixture(t, mode);
    const { cdpUrl } = await borrowedBrowser(t);
    await assert.rejects(
      prove({ ...options, cdpUrl, timeoutMs: 3000 }),
      (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
    );
  });
