import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { requireContainingRelease } from "../scripts/containing-release.ts";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { prove, signedInReplyEngine } from "../scripts/prove-reply-action-link.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";

const exec = promisify(execFile);
const reply: unknown = JSON.parse(
  await readFile(new URL("./fixtures/action-link-reply.v2.json", import.meta.url), "utf8"),
);
assert.ok(
  typeof reply === "object" &&
    reply !== null &&
    "ref" in reply &&
    typeof reply.ref === "string" &&
    "card" in reply &&
    typeof reply.card === "object" &&
    reply.card !== null &&
    "id" in reply.card &&
    typeof reply.card.id === "string",
);
const replyRef = reply.ref,
  proposalId = reply.card.id;
const commit = "1".repeat(40),
  foreignRef = "al1_foreign";
const assets = await appAssetSnapshot();
async function fixture() {
  const routes = new Map<string, { body: string | Uint8Array; contentType: string }>(assets);
  routes.set("/app-release", {
    contentType: "application/json",
    body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
  });
  let writes = 0;
  const server = await startWorkerFixture({
    routes,
    env: {
      CARR: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === "/auth/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic-csrf" });
          if (url.pathname === "/mcp") {
            const rpc: unknown = await request.json();
            assert.ok(
              typeof rpc === "object" &&
                rpc !== null &&
                "id" in rpc &&
                "params" in rpc &&
                typeof rpc.params === "object" &&
                rpc.params !== null &&
                "name" in rpc.params &&
                "arguments" in rpc.params &&
                typeof rpc.params.arguments === "object" &&
                rpc.params.arguments !== null &&
                "ref" in rpc.params.arguments,
            );
            if (!["resolve-action-link", "resolve-action-link-v2"].includes(String(rpc.params.name))) writes++;
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      rpc.params.arguments.ref === replyRef ? reply : { error: "action_link_not_found" },
                    ),
                  },
                ],
              },
            });
          }
          return new Response(null);
        },
      },
    },
  });
  return { ...server, writes: () => writes };
}

test("reply proof uses real page exact values foreign refusal and no write", async () => {
  const server = await fixture();
  try {
    const result = await prove({
      origin: server.origin,
      commit,
      ref: replyRef,
      proposalId: proposalId,
      foreignRef,
      engine: chromium,
    });
    assert.equal(result.status, "passed");
    assert.equal(server.writes(), 0);
    await assert.rejects(
      prove({
        origin: server.origin,
        commit,
        ref: replyRef,
        proposalId: `${proposalId.slice(0, -1)}2`,
        foreignRef,
        engine: chromium,
      }),
      /exact displayed proposal identity/,
    );
  } finally {
    await server.close();
  }
});

test("reply proof release containment covers equal descendant older unrelated and unknown without history dependencies", async () => {
  const cwd = temporaryDirectory("reply-proof-git-");
  const git = (...args: string[]) => exec("git", args, { cwd });
  try {
    await git("init", "-q");
    await git("config", "user.name", "Synthetic");
    await git("config", "user.email", "synthetic@example.test");
    await git("commit", "--allow-empty", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("commit", "--allow-empty", "-qm", "descendant");
    const child = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "--orphan", "unrelated");
    await git("commit", "--allow-empty", "-qm", "unrelated");
    const unrelated = (await git("rev-parse", "HEAD")).stdout.trim();
    await requireContainingRelease(base, base, { cwd });
    await requireContainingRelease(base, child, { cwd });
    for (const [expected, observed] of [
      [child, base],
      [base, unrelated],
      [base, "f".repeat(40)],
    ]) {
      assert.ok(expected !== undefined && observed !== undefined);
      await assert.rejects(requireContainingRelease(expected, observed, { cwd }), { exitCode: 78 });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reply CLI containing release with unreachable CDP exits 78", async () => {
  const server = await fixture();
  try {
    await assert.rejects(
      exec(process.execPath, [
        "scripts/prove-reply-action-link.ts",
        "--origin",
        server.origin,
        "--commit",
        commit,
        "--ref",
        replyRef,
        "--proposal-id",
        proposalId,
        "--foreign-ref",
        foreignRef,
        "--cdp-url",
        "http://127.0.0.1:1",
        "--timeout-ms",
        "1500",
      ]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 78,
    );
  } finally {
    await server.close();
  }
});

function stalledPage() {
  return {
    route: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    locator: () => ({
      count: () => new Promise<number>(() => {}),
      getAttribute: async () => null,
      textContent: async () => null,
    }),
    evaluate: async () => {
      throw Error("not reached");
    },
    getByText: () => {
      throw Error("not reached");
    },
    getByRole: () => {
      throw Error("not reached");
    },
    close: async () => {},
  };
}

for (const phase of ["late launch", "stalled evaluation"])
  test(`reply proof deadline closes owned browser for ${phase}`, async () => {
    const server = await fixture();
    let alive = 0;
    const engine = {
      async launch() {
        if (phase === "late launch") await new Promise((resolve) => setTimeout(resolve, 250));
        alive++;
        return {
          async close() {
            alive = 0;
          },
          async newPage() {
            return stalledPage();
          },
        };
      },
    };
    try {
      await assert.rejects(
        prove({
          origin: server.origin,
          commit,
          ref: replyRef,
          proposalId: proposalId,
          foreignRef,
          engine,
          timeoutMs: 100,
        }),
        { exitCode: 78 },
      );
      assert.equal(alive, 0);
    } finally {
      await server.close();
    }
  });

test("borrowed CDP closes late acquired tab before disconnect without touching existing pages", async () => {
  const order: string[] = [];
  let finish: ((page: ReturnType<typeof stalledPage>) => void) | undefined;
  const existing = {
    close() {
      throw Error("must not close existing tab");
    },
  };
  const adapter = await signedInReplyEngine("http://127.0.0.1:9222", {
    connectOverCDP: async () => ({
      contexts: () => [
        {
          pages: () => [existing],
          newPage: () =>
            new Promise<ReturnType<typeof stalledPage>>((resolve) => {
              finish = resolve;
            }),
        },
      ],
      close: async () => {
        order.push("disconnect");
      },
    }),
  }).launch({ timeout: 1000 });
  const pending = adapter.newPage();
  const close = adapter.close();
  assert.ok(finish);
  finish({
    ...stalledPage(),
    close: async () => {
      order.push("tab");
    },
  });
  await pending;
  await close;
  assert.equal(order.at(-1), "disconnect");
  assert.ok(order.indexOf("tab") < order.indexOf("disconnect"));
});

test("closed CDP page acquisition refuses as insufficient evidence", async () => {
  const adapter = await signedInReplyEngine("http://127.0.0.1:9222", {
    connectOverCDP: async () => ({
      contexts: () => [
        {
          newPage: async () => {
            throw Error("context closed");
          },
        },
      ],
      close: async () => {},
    }),
  }).launch({ timeout: 1000 });
  try {
    await assert.rejects(adapter.newPage(), { exitCode: 78 });
  } finally {
    await adapter.close();
  }
});

test("reply CLI fixture pass and near miss fail; real CDP late page leaves existing tabs intact", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const browserFixture = await ownedCdpFixture();
  t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  const endpoint = browserFixture.endpoint;
  let connection: Browser | undefined;
  try {
    connection = await chromium.connectOverCDP(endpoint);
    const context = connection.contexts()[0];
    assert.ok(context);
    const existing = context.pages()[0] || (await context.newPage());
    const before = context.pages().length;
    const cli = [
      "scripts/prove-reply-action-link.ts",
      "--origin",
      server.origin,
      "--commit",
      commit,
      "--ref",
      replyRef,
      "--proposal-id",
      proposalId,
      "--foreign-ref",
      foreignRef,
      "--cdp-url",
      endpoint,
    ];
    const result = await exec(process.execPath, cli, { timeout: 45000 });
    assert.equal(JSON.parse(result.stdout).status, "passed");
    const wrong = [...cli];
    wrong[wrong.indexOf("--proposal-id") + 1] = `${proposalId.slice(0, -1)}2`;
    await assert.rejects(
      exec(process.execPath, wrong, { timeout: 45000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
    );
    const delayed = {
      async connectOverCDP(url: string, options: { timeout?: number }) {
        const connected = await chromium.connectOverCDP(url, options);
        const c = connected.contexts()[0];
        assert.ok(c);
        const create = c.newPage.bind(c);
        c.newPage = async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return create();
        };
        return connected;
      },
    };
    await assert.rejects(
      prove({
        origin: server.origin,
        commit,
        ref: replyRef,
        proposalId: proposalId,
        foreignRef,
        timeoutMs: 100,
        engine: signedInReplyEngine(endpoint, delayed),
      }),
      { exitCode: 78 },
    );
    const fresh = await chromium.connectOverCDP(endpoint);
    try {
      const freshContext = fresh.contexts()[0];
      assert.ok(freshContext);
      assert.equal(freshContext.pages().length, before);
      assert.equal(existing.isClosed(), false);
    } finally {
      await fresh.close();
    }
  } finally {
    await connection?.close();
    await browser.close();
  }
});

test("reply browser launch failure exits without leaking its fixture server", async () => {
  const directory = temporaryDirectory("reply-proof-no-browser-");
  try {
    await assert.rejects(
      exec(
        process.execPath,
        ["--test", "--test-name-pattern=^reply CLI fixture pass", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, NODE_TEST_CONTEXT: undefined, CI: "true", PLAYWRIGHT_BROWSERS_PATH: directory },
          timeout: 10000,
        },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        /Executable doesn't exist|ENOENT/.test(error.stdout),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
