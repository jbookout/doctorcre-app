import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AskRequest } from "../src/ui/queued-asks.ts";
import { launchProofBrowser, proofFetch } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

type MountComposer = (
  host: HTMLElement,
  client: { askSession(): Promise<{ actor: string }>; submitDocRequest(request: AskRequest): Promise<unknown> },
  conversation: string,
) => Promise<() => void>;
// Each evaluation uses synthetic state installed by the first evaluation in this isolated page.
type ProofWindow = Window & {
  corruptProof: {
    prefix: string;
    key: string;
    frozen: AskRequest;
    calls: AskRequest[];
    dispose?: () => void;
    accept?: () => void;
  };
};
export async function prove({
  origin,
  timeoutMs = 30000,
  revision,
}: {
  origin: string;
  timeoutMs?: number;
  revision: string;
}) {
  const base = new URL(origin);
  assert.ok(["http:", "https:"].includes(base.protocol) && base.origin === origin, "Supply an origin without a path");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, "Invalid timeout");
  const signal = AbortSignal.timeout(timeoutMs);
  const releaseResponse = await proofFetch(`${origin}/app-release`, { redirect: "error", signal });
  assert.equal(releaseResponse.status, 200, "Release unavailable or sign-in required");
  const release = await releaseResponse.json();
  assert.equal(release.service, "doctorcre-app", "Wrong release application");
  assert.match(release.source_commit, /^[a-f0-9]{40}$/, "Release revision missing");
  const required = revision;
  assert.match(required, /^[a-f0-9]{40}$/, "Required revision missing");
  await requireContainingRelease(required, release.source_commit, { signal });
  const browser = await launchProofBrowser(
    chromium,
    { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs },
    { signal },
  );
  const modules = new Set<string>(),
    failedAssets: string[] = [],
    denied: string[] = [];
  let requests = 0;
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(timeoutMs);
    const page = await context.newPage();
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (++requests > 100) {
        denied.push("request budget exceeded");
        return route.abort();
      }
      if (request.method() === "GET" && url.origin === origin && url.pathname === "/__queued_asks_proof")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><body><main id="probe"></main></body></html>',
        });
      if (request.method() === "GET" && url.origin === origin && /^\/js\/[\w.-]+\.js$/.test(url.pathname))
        return route.continue();
      denied.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    page.on("response", (response) => {
      if (response.url().includes("/js/")) {
        modules.add(response.url());
        if (response.status() !== 200) failedAssets.push(response.url());
      }
    });
    await page.goto(`${origin}/__queued_asks_proof`);
    const assertions = [];
    for (const width of [390, 1280])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.evaluate(async () => {
          const modulePath = "/js/ui-host.generated.js";
          const api: { mountAskComposer: MountComposer } = await import(modulePath);
          const mount = api.mountAskComposer;
          if (typeof mount !== "function") throw Error("mountAskComposer export missing");
          const conversation = "11111111-1111-4111-8111-111111111111",
            key = "22222222-2222-4222-8222-222222222222";
          const prefix = `doctorcre:asks:v1:corrupt-proof:${conversation}:`;
          localStorage.clear();
          localStorage.setItem(`${prefix}bad-before`, "{");
          const request = { idempotency_key: key, conversation_id: conversation, body: "Synthetic valid frozen ask" };
          localStorage.setItem(prefix + key, JSON.stringify({ kind: "queued", request }));
          localStorage.setItem(`${prefix}bad-after`, "{");
          localStorage.setItem(`${prefix}draft`, JSON.stringify({ text: "Current synthetic draft", version: 1 }));
          const calls: AskRequest[] = [];
          // This isolated page installs the synthetic state before reading it.
          (window as unknown as ProofWindow).corruptProof = { prefix, key, frozen: request, calls };
          const host = document.querySelector<HTMLElement>("#probe");
          if (!host) throw Error("Proof host missing");
          // This isolated page installs the synthetic state before reading it.
          (window as unknown as ProofWindow).corruptProof.dispose = await mount(
            host,
            {
              askSession: async () => ({ actor: "corrupt-proof" }),
              submitDocRequest: (request) => {
                calls.push(request);
                return new Promise((resolve) => {
                  // This isolated page installs the synthetic state before reading it.
                  (window as unknown as ProofWindow).corruptProof.accept = () =>
                    resolve({
                      ok: true,
                      contract: "doc-request.v1",
                      status: "accepted",
                      ...request,
                      request_msg_id: request.idempotency_key,
                    });
                });
              },
            },
            conversation,
          );
        });
        await page.getByText("Synthetic valid frozen ask", { exact: true }).waitFor();
        await page.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
        // This isolated page installs the synthetic state before reading it.
        await page.waitForFunction(() => (window as unknown as ProofWindow).corruptProof.calls.length === 1);
        assert.equal(await page.locator("#askText").inputValue(), "Current synthetic draft");
        // This isolated page installs the synthetic state before reading it.
        await page.evaluate(() => (window as unknown as ProofWindow).corruptProof.accept?.());
        await page.getByText("Received by Dr. CRE. An answer is still pending.", { exact: true }).waitFor();
        const state = await page.evaluate(() => {
          // This isolated page installs the synthetic state before reading it.
          const p = (window as unknown as ProofWindow).corruptProof;
          return {
            calls: p.calls,
            frozen: p.frozen,
            before: localStorage.getItem(`${p.prefix}bad-before`),
            after: localStorage.getItem(`${p.prefix}bad-after`),
          };
        });
        assert.deepEqual(state.calls, [state.frozen]);
        assert.equal(state.before, "{");
        assert.equal(state.after, "{");
        // This isolated page installs the synthetic state before reading it.
        await page.evaluate(() => (window as unknown as ProofWindow).corruptProof.dispose?.());
        assertions.push(
          `${width} ${theme}: valid request accepted once; draft and corrupt bytes retained; notice shown`,
        );
      }
    assert.deepEqual(failedAssets, [], "Protected or missing module assets");
    assert.deepEqual(denied, [], "Unexpected network request denied");
    return { origin, release, requiredRevision: required, modules: [...modules].sort(), assertions };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.length === 3 && process.argv[2] === "--help") {
  console.log(
    "Usage: node scripts/prove-queued-asks-corrupt-entry-isolation.ts --origin <origin> [--timeout-ms <1..120000, default 30000>] --revision <required ancestor SHA>",
  );
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i],
        value = args[i + 1];
      assert.ok(
        flag && ["--origin", "--timeout-ms", "--revision"].includes(flag) && value,
        "Unknown or missing argument",
      );
      options[flag] = value;
    }
    assert.ok(options["--origin"] && options["--revision"], "Origin and revision are required");
    console.log(
      JSON.stringify(
        await prove({
          origin: options["--origin"],
          timeoutMs: options["--timeout-ms"] === undefined ? 30000 : Number(options["--timeout-ms"]),
          revision: options["--revision"],
        }),
      ),
    );
  } catch (error) {
    console.error(`queued-asks proof failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode =
      (error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number"
        ? error.exitCode
        : undefined) || (error instanceof Error && error.name === "TimeoutError" ? 78 : 1);
  }
}
