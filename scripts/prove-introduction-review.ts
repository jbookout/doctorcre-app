import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { signedInReplyEngine } from "./prove-reply-action-link.ts";

type Engine = ReturnType<typeof signedInReplyEngine>;
type ProofPage = Awaited<ReturnType<Awaited<ReturnType<Engine["launch"]>>["newPage"]>>;
const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });

export async function observeIntroduction(page: ProofPage) {
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector("#networkIntroductions [data-node]")) ||
      !document.querySelector("#networkNotice")?.hasAttribute("hidden"),
  );
  const expected: unknown = await page.evaluate(async () => {
    const { createLiveClient } = await import(String("/js/live-client.js"));
    const { validNetwork } = await import(String("/js/relationship-network-model.js"));
    const snapshot = await createLiveClient().getRelationshipNetwork();
    if (!validNetwork(snapshot) || Date.parse(snapshot.valid_until) <= Date.now()) return null;
    const offer = snapshot.suggestions[0];
    if (!offer) return null;
    return {
      id: offer.id,
      people: [offer.from, offer.via, offer.to].map((id) => {
        const node = snapshot.nodes.find((n: { id: string }) => n.id === id);
        return node
          ? { id: node.id, label: `${node.name} (${node.ref ?? node.id.slice(6)})` }
          : { id: "direct", label: "Direct offered path; no separate introducer recorded" };
      }),
      detail: offer.detail,
    };
  });
  if (
    !expected ||
    typeof expected !== "object" ||
    !("id" in expected) ||
    typeof expected.id !== "string" ||
    !("people" in expected) ||
    !("detail" in expected)
  )
    throw insufficient("A current offered introduction and signed-in session are required");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#networkIntroductions [data-node]")?.click());
  await page.waitForFunction(() => Boolean(document.querySelector("[data-review-introduction]")));
  await page.evaluate(
    (id) =>
      [...document.querySelectorAll<HTMLButtonElement>("[data-review-introduction]")]
        .find((node) => node.dataset.reviewIntroduction === id)
        ?.click(),
    expected.id,
  );
  await page.waitForFunction(() => Boolean(document.querySelector(".introduction-review[open]")));
  const observed = await page.evaluate(() => {
    const panel = document.querySelector(".introduction-review[open]");
    return {
      people: [...(panel?.querySelectorAll("[data-identity]") || [])].map((node) => ({
        id: node.getAttribute("data-identity"),
        label: node.textContent,
      })),
      detail: panel?.querySelector("[data-evidence]")?.textContent,
      state: panel?.getAttribute("data-state"),
      overflow: panel ? panel.scrollWidth > panel.clientWidth : true,
    };
  });
  assert.deepEqual(observed.people, expected.people);
  assert.equal(observed.detail, expected.detail);
  assert.equal(observed.state, "reviewing");
  assert.equal(observed.overflow, false);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>(".introduction-review [data-close]")?.click());
  assert.equal(await page.locator(".introduction-review[open]").count(), 0);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-close-card]")?.click());
  return { status: "passed", people: observed.people, evidence: "read-only review and cancel; persistence unverified" };
}

export async function prove({
  origin,
  expectedCommit,
  cdpUrl,
  engine,
  timeoutMs = 30000,
}: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  engine?: Engine | undefined;
  timeoutMs?: number;
}) {
  const url = new URL(origin);
  assert.ok(["https:", "http:"].includes(url.protocol) && url.origin === origin && !url.username && !url.password);
  assert.match(expectedCommit, /^[0-9a-f]{40}$/);
  assert.ok(!/^0+$/.test(expectedCommit));
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  const lifetime = new AbortController();
  const timeout = setTimeout(() => lifetime.abort(insufficient("Total proof deadline exceeded")), timeoutMs);
  const aborted = new Promise<never>((_, reject) =>
    lifetime.signal.addEventListener("abort", () => reject(lifetime.signal.reason), { once: true }),
  );
  let acquisition: ReturnType<Engine["launch"]> | undefined;
  let containingRelease = false;
  try {
    const work = async () => {
      const read = async (target: URL) => {
        const response = await proofFetch(target, { signal: lifetime.signal, cache: "no-store" });
        if (!response.ok) throw insufficient("Release unavailable");
        return { type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
      };
      const release = await readAppRelease(origin, read);
      await requireContainingRelease(expectedCommit, release.source_commit, { signal: lifetime.signal });
      containingRelease = true;
      if (!cdpUrl && !engine) throw insufficient("Supply an authorized signed-in loopback CDP session");
      acquisition = (engine || signedInReplyEngine(cdpUrl || "")).launch({ timeout: timeoutMs });
      const browser = await acquisition;
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      const page = await browser.newPage();
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      let writes = 0;
      await page.route("**/*", async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        if (target.origin !== origin) return route.abort();
        if (["GET", "HEAD"].includes(request.method())) return route.fallback();
        if (target.pathname === "/mcp") {
          if (request.postDataJSON().params?.name === "link-parties") writes++;
          return route.fulfill({
            json: {
              jsonrpc: "2.0",
              id: request.postDataJSON().id,
              result: { isError: true, content: [{ type: "text", text: '{"error":"proof_unrelated_rpc_refused"}' }] },
            },
          });
        }
        writes++;
        return route.abort();
      });
      const observations = [];
      await page.goto(`${origin}/relationships?mode=live`);
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          if (lifetime.signal.aborted) throw lifetime.signal.reason;
          if (!("setViewportSize" in page) || typeof page.setViewportSize !== "function")
            throw insufficient("Viewport control unavailable");
          await page.setViewportSize({ width: 1440, height: 1000 });
          if ((await page.locator("html").getAttribute("data-theme")) !== theme)
            await page.getByRole("button", { name: "Dark mode", exact: true }).click();
          assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
          await page.setViewportSize({ width, height: 1000 });
          observations.push({ width, theme, ...(await observeIntroduction(page)) });
        }
      assert.equal(writes, 0);
      assert.deepEqual(await readAppRelease(origin, read), release);
      return { status: "passed", release, observations };
    };
    return await Promise.race([work(), aborted]);
  } catch (error) {
    if (!containingRelease || !(error instanceof assert.AssertionError))
      throw error instanceof Error ? Object.assign(error, { exitCode: 78 }) : insufficient(String(error));
    throw error;
  } finally {
    clearTimeout(timeout);
    lifetime.abort();
    await acquisition?.then(
      (browser) => browser.close(),
      () => {},
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        "expected-commit": { type: "string" },
        "cdp-url": { type: "string" },
        "timeout-ms": { type: "string", default: "30000" },
      },
    });
    assert.ok(values.origin && values["expected-commit"]);
    console.log(
      JSON.stringify(
        await prove({
          origin: values.origin,
          expectedCommit: values["expected-commit"],
          cdpUrl: values["cdp-url"],
          timeoutMs: Number(values["timeout-ms"]),
        }),
      ),
    );
  } catch (error) {
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
    console.log(
      JSON.stringify({
        status: process.exitCode === 78 ? "insufficient_evidence" : "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
