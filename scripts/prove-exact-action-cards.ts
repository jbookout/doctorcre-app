import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Locator, Page, Route } from "playwright";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { signedInReplyEngine } from "./prove-reply-action-link.ts";

type Target = { ref: string; id: string; kind: "reply_draft" | "post_call_review" | "feedback_event" };
type Engine = {
  launch(options: { timeout: number; args: string[] }): Promise<{
    newPage(): Promise<
      Pick<Page, "evaluate"> & {
        route(pattern: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
        goto(url: string): Promise<unknown>;
        waitForFunction(predicate: () => unknown): Promise<unknown>;
        locator(selector: string): Pick<Locator, "count" | "getAttribute" | "textContent">;
      }
    >;
    close(): Promise<void>;
  }>;
};
const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function proveExact({
  origin,
  commit,
  targets,
  foreignRef,
  engine,
  timeoutMs = 30000,
}: {
  origin: string;
  commit: string;
  targets: Target[];
  foreignRef: string;
  engine?: Engine | undefined;
  timeoutMs?: number;
}) {
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(insufficient("Total proof deadline exceeded")), timeoutMs);
  const abort = new Promise<never>((_, reject) =>
    lifetime.signal.addEventListener("abort", () => reject(lifetime.signal.reason), { once: true }),
  );
  let acquired: ReturnType<Engine["launch"]> | undefined;
  let browser: Awaited<ReturnType<Engine["launch"]>> | undefined;
  try {
    const work = async () => {
      const read = async (url: URL) => {
        const response = await proofFetch(url, { signal: lifetime.signal, cache: "no-store" });
        return { type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
      };
      const release = await readAppRelease(origin, read);
      await requireContainingRelease(commit, release.source_commit, { signal: lifetime.signal });
      if (!engine) throw insufficient("Authorized browser session unavailable; supply --cdp-url");
      assert.deepEqual([...new Set(targets.map((t) => t.kind))].sort(), [
        "feedback_event",
        "post_call_review",
        "reply_draft",
      ]);
      const launch = {
        launch(options: { timeout?: number; args?: string[] }) {
          acquired = engine.launch({
            timeout: options.timeout || timeoutMs,
            args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])],
          });
          return acquired;
        },
      };
      browser = await launchProofBrowser(
        launch,
        { timeout: timeoutMs, args: [...CHROMIUM_SAFETY_ARGS] },
        { signal: lifetime.signal },
      );
      const page = await browser.newPage();
      let violation = false;
      await page.route("**/*", async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        if (["GET", "HEAD"].includes(req.method())) return route.continue();
        const rpc: unknown = req.postDataJSON();
        if (
          typeof rpc === "object" &&
          rpc !== null &&
          "params" in rpc &&
          typeof rpc.params === "object" &&
          rpc.params !== null &&
          "name" in rpc.params &&
          rpc.params.name === "resolve-action-link-v2"
        )
          return route.continue();
        // Shell reads are outside the proof; refuse them without issuing a mutation.
        if (typeof rpc === "object" && rpc !== null && "id" in rpc)
          return route.fulfill({
            json: {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { isError: true, content: [{ type: "text", text: '{"error":"proof_unrelated_read_refused"}' }] },
            },
          });
        violation = true;
        return route.abort();
      });
      for (const target of targets) {
        await page.goto(`${origin}/a/${encodeURIComponent(target.ref)}?mode=live`);
        await page.waitForFunction(
          () =>
            Boolean(document.querySelector("[data-exact-card-id]")) ||
            Boolean(document.querySelector('#actionLink [role="status"]')?.textContent !== "Opening draft…"),
        );
        const independent: unknown = await page.evaluate(async (ref) => {
          const { createMcpRequests } = await import(String("/js/mcp-requests.mjs"));
          const { parseExactCard, parseDraft } = await import(String("/js/ui-action.generated.js"));
          const result = await createMcpRequests()("resolve-action-link-v2", { ref }, { timeoutMs: 10000 });
          if (result.kind !== "payload" || result.isError) return null;
          const parsed = parseExactCard(result.payload, ref) || parseDraft(result.payload, ref);
          return parsed ? { id: parsed.id, kind: parsed.kind } : null;
        }, target.ref);
        if (!independent) throw insufficient("Registered exact-card read unavailable");
        assert.deepEqual(independent, { id: target.id, kind: target.kind });
        const node = page.locator("[data-exact-card-id]");
        assert.equal(await node.getAttribute("data-exact-card-id"), target.id);
        assert.equal(await node.getAttribute("data-exact-card-kind"), target.kind);
      }
      await page.goto(`${origin}/a/${encodeURIComponent(foreignRef)}?mode=live`);
      await page.waitForFunction(
        () => document.querySelector('#actionLink [role="status"]')?.textContent !== "Opening draft…",
      );
      if (await page.locator('#actionLink a[href^="/auth/login"]').count())
        throw insufficient("Partner session unavailable");
      assert.equal(await page.locator("[data-exact-card-id],.action-link-message").count(), 0);
      assert.equal(
        await page.locator('#actionLink [role="status"]').textContent(),
        "This draft is unavailable for your account.",
      );
      assert.equal(violation, false);
      assert.deepEqual(await readAppRelease(origin, read), release);
      return { status: "passed", release, assertions: ["three-exact-card-ids", "foreign-refused", "read-only"] };
    };
    return await Promise.race([work(), abort]);
  } finally {
    clearTimeout(timer);
    lifetime.abort(insufficient("Proof finished"));
    if (browser) await browser.close();
    else if (acquired)
      await acquired.then(
        (value) => value.close(),
        () => {},
      );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        commit: { type: "string" },
        "reply-ref": { type: "string" },
        "reply-id": { type: "string" },
        "call-ref": { type: "string" },
        "call-id": { type: "string" },
        "feedback-ref": { type: "string" },
        "feedback-id": { type: "string" },
        "foreign-ref": { type: "string" },
        "cdp-url": { type: "string" },
        "timeout-ms": { type: "string", default: "30000" },
      },
    });
    assert.ok(
      values.origin &&
        values.commit &&
        values["reply-ref"] &&
        values["reply-id"] &&
        values["call-ref"] &&
        values["call-id"] &&
        values["feedback-ref"] &&
        values["feedback-id"] &&
        values["foreign-ref"],
    );
    const url = new URL(values.origin),
      timeoutMs = Number(values["timeout-ms"]);
    assert.ok(
      url.href === `${url.origin}/` &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) &&
        timeoutMs > 0 &&
        timeoutMs <= 30000,
    );
    console.log(
      JSON.stringify(
        await proveExact({
          origin: url.origin,
          commit: values.commit,
          targets: [
            { kind: "reply_draft", ref: values["reply-ref"], id: values["reply-id"] },
            { kind: "post_call_review", ref: values["call-ref"], id: values["call-id"] },
            { kind: "feedback_event", ref: values["feedback-ref"], id: values["feedback-id"] },
          ],
          foreignRef: values["foreign-ref"],
          timeoutMs,
          engine: values["cdp-url"] ? signedInReplyEngine(values["cdp-url"]) : undefined,
        }),
      ),
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number"
        ? error.exitCode
        : 1;
    console.log(
      JSON.stringify({
        status: code === 78 ? "insufficient_evidence" : "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = code;
  }
}
