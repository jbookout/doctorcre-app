import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { chromium } from "playwright";
import { proofFetch, readAppRelease } from "./app-release-reader.mjs";

type ProofPage = Pick<Page, "setDefaultTimeout" | "evaluate" | "goto" | "locator" | "close"> & {
  route(pattern: string, handler: Parameters<Page["route"]>[1]): Promise<unknown>;
};
type Connection = { contexts(): { newPage(): Promise<ProofPage> }[]; close(): Promise<unknown> };
type ProofOptions = {
  origin?: string | undefined;
  expectedCommit?: string | undefined;
  cdpUrl?: string | undefined;
  timeoutMs?: number;
  engine?: { connectOverCDP(url: string, options: { timeout: number }): Promise<Connection> };
  ancestryCwd?: string;
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unavailable = (message: string) => Object.assign(new Error(message), { exitCode: 78 });

export async function prove({
  origin,
  expectedCommit,
  cdpUrl,
  timeoutMs = 30000,
  engine = chromium,
  ancestryCwd,
}: ProofOptions = {}) {
  let base: URL;
  try {
    base = new URL(origin || "http://localhost");
  } catch {
    throw unavailable("Origin required");
  }
  if (
    !(
      base.href === `${base.origin}/` &&
      !base.username &&
      !base.password &&
      (base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))
    )
  )
    throw unavailable("Origin required");
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000))
    throw unavailable("Bounded deadline required");
  const controller = new AbortController(),
    deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw unavailable("Total proof deadline exceeded");
    return ms;
  };
  let page: ProofPage | undefined,
    connection: Connection | undefined,
    pendingConnection: Promise<Connection> | undefined,
    pendingPage: Promise<ProofPage> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const release = () =>
    readAppRelease(base, async (url) => {
      const response = await proofFetch(url, { signal: controller.signal });
      return { type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
    });
  const work = async () => {
    const before = await release();
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || "") || /^0+$/.test(expectedCommit || ""))
      throw unavailable("Expected merge commit required");
    assert.ok(expectedCommit);
    if (before.source_commit !== expectedCommit) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = execFile(
            "git",
            ["merge-base", "--is-ancestor", expectedCommit, before.source_commit],
            { cwd: ancestryCwd, timeout: remaining(), signal: controller.signal, killSignal: "SIGKILL" },
            (error) => (error ? reject(error) : resolve()),
          );
          child.on("error", reject);
        });
      } catch {
        throw unavailable("Release containment is unproved");
      }
    }
    if (!cdpUrl) throw unavailable("Existing signed-in browser required");
    pendingConnection = Promise.resolve()
      .then(() => engine.connectOverCDP(cdpUrl, { timeout: remaining() }))
      .catch(() => {
        throw unavailable("Existing signed-in browser unavailable");
      });
    connection = await pendingConnection;
    controller.signal.throwIfAborted();
    const context = connection.contexts()[0];
    if (!context) throw unavailable("Existing signed-in context required");
    pendingPage = Promise.resolve()
      .then(() => context.newPage())
      .catch(() => {
        throw unavailable("Existing signed-in page unavailable");
      });
    page = await pendingPage;
    controller.signal.throwIfAborted();
    page.setDefaultTimeout(remaining());
    let calls = 0,
      registryFailure: Error | undefined;
    let verbWrites: Map<string, boolean> | undefined;
    let registryRead: Promise<Map<string, boolean>> | undefined;
    const activePage = page;
    const readRegistry = () =>
      (registryRead ||= activePage
        .evaluate(async () => {
          const { createMcpRequests } = await import(String("/js/mcp-requests.mjs"));
          return createMcpRequests()("list-verbs", { names_only: true });
        })
        .then((outcome: unknown) => {
          if (!object(outcome)) throw unavailable("Verb metadata unreadable");
          const registry: unknown = outcome.payload;
          if (
            outcome.kind !== "payload" ||
            outcome.isError ||
            !object(registry) ||
            registry.ok !== true ||
            !Array.isArray(registry.verbs) ||
            !registry.verbs.length ||
            registry.count !== registry.verbs.length ||
            !registry.verbs.every(
              (verb: unknown) =>
                object(verb) && typeof verb.name === "string" && verb.name && typeof verb.write === "boolean",
            ) ||
            new Set(registry.verbs.map((verb: unknown) => (object(verb) ? verb.name : undefined))).size !==
              registry.verbs.length
          )
            throw unavailable("Verb metadata unreadable");
          return new Map(
            registry.verbs.map((verb: unknown) => {
              assert.ok(object(verb) && typeof verb.name === "string" && typeof verb.write === "boolean");
              return [verb.name, verb.write];
            }),
          );
        }));
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== base.origin) return route.abort();
      if (req.method() === "POST") {
        if (url.pathname !== "/mcp") return route.abort();
        calls++;
        try {
          const body: unknown = req.postDataJSON();
          if (!object(body) || !object(body.params) || typeof body.params.name !== "string")
            throw unavailable("Unknown RPC request");
          const name = body.params.name;
          if (body.method !== "tools/call") throw unavailable("Unknown RPC request");
          if (name !== "list-verbs") {
            verbWrites ||= await readRegistry();
            if (verbWrites.get(name) !== false) throw unavailable("Write or unknown verb refused");
          }
        } catch (error) {
          registryFailure = unavailable(messageOf(error));
          return route.abort();
        }
      } else if (!["GET", "HEAD"].includes(req.method())) return route.abort();
      return route.continue();
    });
    await page.goto(new URL("/leads", base).href, { timeout: remaining() }).catch(() => {
      throw unavailable("Natural lead page unavailable");
    });
    const detail: unknown = await page
      .evaluate(async () => {
        const { createLeadBoardClient } = await import(String("/js/leads-client.js"));
        const client = createLeadBoardClient();
        if (!(await client.getActor())) return null;
        const board = await client.getWorkspace();
        for (const lead of board.leads.slice(0, 20)) {
          const { detail } = await client.getLeadDetail(lead);
          if (detail?.research?.evidence.some((item: { source: string }) => item.source.trim())) return detail;
        }
        return null;
      })
      .catch(() => {
        throw unavailable("Signed-in business read unavailable");
      });
    if (registryFailure) throw registryFailure;
    if (!detail) throw unavailable("No eligible natural subject in first 20 loaded leads");
    assert.ok(
      object(detail) &&
        typeof detail.id === "string" &&
        object(detail.research) &&
        Array.isArray(detail.research.evidence),
    );
    const research = detail.research;
    const evidence = detail.research.evidence.map((item: unknown) => {
      assert.ok(object(item) && typeof item.source === "string" && typeof item.flag_id === "string");
      return { source: item.source, flag_id: item.flag_id };
    });
    const button = page.locator(`[data-open="${detail.id}"]`).first();
    await button.waitFor({ timeout: remaining() }).catch(() => {
      throw unavailable("Natural subject is not visible");
    });
    await button.click();
    const panel = page.locator("#sourcedResearch");
    await panel.waitFor();
    const finding: unknown = evidence.find(
      (item) => object(item) && typeof item.source === "string" && item.source.trim(),
    );
    assert.ok(object(finding) && typeof finding.source === "string");
    const source = finding.source;
    const beforeCalls = calls;
    await panel.getByLabel("Finding source", { exact: true }).selectOption(`source:${source}`);
    assert.deepEqual(
      await panel.locator("li").evaluateAll((nodes) => nodes.map((n) => n.dataset.flagId)),
      evidence.filter((item) => item.source === source).map((item) => item.flag_id),
    );
    assert.equal(
      await panel.locator(":scope > p").nth(0).textContent(),
      new Map([
        ["needs_review", "Needs review"],
        ["needs_research", "Needs research"],
        ["verified", "Verified"],
      ]).get(String(research.state)),
      "server state preserved",
    );
    assert.equal(
      await panel.locator(":scope > p").nth(1).textContent(),
      detail.research.next_step,
      "server guidance preserved",
    );
    assert.equal(
      await panel.getByRole("status").textContent(),
      `${evidence.filter((item) => item.source === source).length} of ${evidence.length} loaded findings`,
      "matching count",
    );
    await panel.getByLabel("Finding source", { exact: true }).selectOption("all");
    assert.deepEqual(
      await panel.locator("li").evaluateAll((nodes) => nodes.map((n) => n.dataset.flagId)),
      evidence.map((item) => item.flag_id),
    );
    assert.equal(
      await panel.getByRole("status").textContent(),
      `${evidence.length} of ${evidence.length} loaded findings`,
    );
    assert.equal(calls, beforeCalls, "selection performs no RPC");
    const after = await release();
    assert.deepEqual(after, before, "stable release");
    return { status: "passed", before, after, subject: detail.id, source, count: evidence.length };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(unavailable("Total proof deadline exceeded"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw unavailable("Total proof deadline exceeded");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    const acquiredPage = page || (await pendingPage?.catch(() => undefined));
    await acquiredPage?.close().catch(() => {});
    const acquiredConnection = connection || (await pendingConnection?.catch(() => undefined));
    await acquiredConnection?.close().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2),
    value = (flag: string) => args[args.indexOf(flag) + 1];
  try {
    const receipt = await prove({
      origin: args.includes("--origin") ? value("--origin") : undefined,
      expectedCommit: args.includes("--expected-commit") ? value("--expected-commit") : undefined,
      cdpUrl: args.includes("--cdp-url") ? value("--cdp-url") : undefined,
      timeoutMs: Number(args.includes("--timeout-ms") ? value("--timeout-ms") : 30000),
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.log(
      JSON.stringify({
        status: object(error) && error.exitCode === 78 ? "insufficient_evidence" : "assertion_failure",
        error: messageOf(error),
      }),
    );
    process.exitCode = object(error) && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
