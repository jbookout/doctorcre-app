import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium as driver } from "playwright";
import { parseVendorMarkets } from "../src/ui/vendor-markets-client.ts";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function prove({
  origin,
  expectedCommit,
  cdpUrl,
  fixture = false,
  timeoutMs = 30000,
  screenshotDir,
}: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string;
  fixture?: boolean;
  timeoutMs?: number;
  screenshotDir?: string;
}) {
  const base = new URL(origin);
  if (base.origin !== origin || !["http:", "https:"].includes(base.protocol)) throw Error("Expected HTTP origin");
  if (fixture && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw Error("Fixtures require loopback");
  if (!/^[a-f0-9]{40}$/.test(expectedCommit) || /^0+$/.test(expectedCommit))
    throw insufficient("Expected merge commit required");
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0 || controller.signal.aborted) throw insufficient("Proof deadline expired");
    return left;
  };
  let browser: Browser | undefined;
  let page: Page | undefined;
  let acquisition: Promise<Browser> | undefined;
  let pageAcquisition: Promise<Page> | undefined;
  let assertionsStarted = false;
  const observations: unknown[] = [];
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: remaining() });
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    if (fixture)
      browser = await launchProofBrowser(
        chromium,
        { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() },
        { signal: controller.signal },
      );
    else {
      if (!cdpUrl) throw insufficient("Existing signed-in CDP session required");
      acquisition = driver.connectOverCDP(cdpUrl, { timeout: remaining() }).then(async (acquired) => {
        if (controller.signal.aborted) {
          await acquired.close();
          throw insufficient("Proof deadline expired");
        }
        return acquired;
      });
      browser = await acquisition;
    }
    const context = browser.contexts()[0] ?? (fixture ? await browser.newContext() : undefined);
    if (!context) throw insufficient("Signed-in browser context required");
    pageAcquisition = (fixture ? browser.newPage() : context.newPage()).then(async (acquired) => {
      if (controller.signal.aborted) {
        await acquired.close();
        throw insufficient("Proof deadline expired");
      }
      return acquired;
    });
    page = await pageAcquisition;
    const activePage = page;
    await activePage.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === "GET") return route.continue();
      if (
        url.pathname === "/mcp" &&
        request.method() === "POST" &&
        [
          "read-vendor-meetings",
          "read-vendor-markets-v1",
          "quiet-follow-ups",
          "read-notifications",
          "notification-count",
          "doc_activity",
        ].includes(request.postDataJSON()?.params?.name)
      )
        return route.continue();
      return route.abort();
    });
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        remaining();
        await activePage.setViewportSize({ width, height: 900 });
        await activePage.addInitScript(
          (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
          theme,
        );
        const read = activePage.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/mcp" &&
            r.request().postDataJSON()?.params?.name === "read-vendor-markets-v1",
          { timeout: remaining() },
        );
        read.catch(() => {});
        await activePage.goto(`${origin}/vendors?vendorView=market`, { timeout: remaining() });
        const envelope: unknown = await (await read).json();
        if (
          !envelope ||
          typeof envelope !== "object" ||
          !("result" in envelope) ||
          !envelope.result ||
          typeof envelope.result !== "object" ||
          !("content" in envelope.result) ||
          !Array.isArray(envelope.result.content)
        )
          throw insufficient("Authorized registry unavailable");
        const content = envelope.result.content.find(
          (c: unknown) => c && typeof c === "object" && "type" in c && c.type === "text",
        );
        if (!content || typeof content.text !== "string") throw insufficient("Registry unavailable");
        const snapshot = parseVendorMarkets(JSON.parse(content.text));
        const section = activePage.getByRole("region", { name: "Vendor directory view" });
        await section.locator('[aria-busy="false"]').waitFor({ timeout: remaining() });
        if (snapshot.state === "empty")
          throw insufficient("No reviewed markets yet; reviewed multi-market and Regional data required");
        if (
          !snapshot.vendors.some((v) => v.market_slugs.length > 1) ||
          !snapshot.markets.some(
            (m) =>
              m.regional_references.length &&
              m.regional_references.some((r) =>
                snapshot.markets.some((x) => x.slug === r.regional_slug && x.vendor_count > 0),
              ),
          )
        )
          throw insufficient("Multi-market and Regional reviewed data required");
        assertionsStarted = true;
        for (const market of snapshot.markets) {
          remaining();
          await section
            .getByLabel("Reviewed market", { exact: true })
            .selectOption(market.slug, { timeout: remaining() });
          const displayed = section.locator(`[data-market-slug="${market.slug}"]`);
          await displayed.waitFor({ timeout: remaining() });
          assert.equal(await displayed.locator("[data-market-count]").textContent(), `${market.vendor_count} vendors`);
          assert.deepEqual(
            (
              await displayed
                .locator("[data-market-vendor]")
                .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-market-vendor")))
            ).sort(),
            market.memberships.map((m) => m.vendor_id).sort(),
          );
          for (const member of market.memberships) {
            const vendor = snapshot.vendors.find((v) => v.id === member.vendor_id);
            assert.ok(vendor);
            const row = displayed.locator(`[data-market-vendor="${vendor.id}"]`);
            assert.equal(
              await row.locator("[data-service-coverage]").textContent(),
              `Service coverage: ${member.service_coverage || "Not recorded"}`,
            );
            assert.equal(
              await row.locator("[data-other-markets]").textContent(),
              `Other market references: ${
                vendor.market_slugs
                  .filter((s) => s !== market.slug)
                  .map((s) => snapshot.markets.find((m) => m.slug === s)?.name)
                  .join(", ") || "None"
              }`,
            );
            assert.deepEqual(
              await row
                .locator("[data-market-person]")
                .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-market-person"))),
              vendor.people.map((p) => p.contact.id),
            );
            assert.deepEqual(
              await row.locator("[data-office-evidence]").allTextContents(),
              vendor.people.map(
                (p) =>
                  `Office location: ${p.office ? `${p.office.street_address}, ${p.office.city}, ${p.office.state}` : "Verified street address not recorded"}`,
              ),
            );
          }
          const regional = section.getByRole("region", { name: "Regional coverage references" });
          assert.equal(await regional.count(), market.kind === "market" ? 1 : 0);
          if (market.kind === "market")
            assert.deepEqual(
              (
                await regional
                  .locator("[data-market-slug]")
                  .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-market-slug")))
              ).sort(),
              market.regional_references.map((r) => r.regional_slug).sort(),
            );
        }
        assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (screenshotDir) await section.screenshot({ path: `${screenshotDir}/markets-${width}-${theme}.png` });
        observations.push({ width, theme, markets: snapshot.markets.length });
      }
    const after = await readAppRelease(origin, { timeoutMs: remaining() });
    if (after.source_commit !== release.source_commit) throw insufficient("Release changed during proof");
    return { status: "passed", scope: fixture ? "synthetic" : "natural", release, observations };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          void page?.close().catch(() => {});
          reject(insufficient("Proof deadline expired"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && (!assertionsStarted || /Timeout|closed|connectOverCDP/.test(error.message)))
      throw Object.assign(error, { exitCode: 78 });
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await page?.close().catch(() => {});
    await Promise.allSettled([acquisition, pageAcquisition]);
    await browser?.close().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        "expected-commit": { type: "string" },
        "cdp-url": { type: "string" },
        fixture: { type: "boolean" },
        "timeout-ms": { type: "string", default: "30000" },
        "screenshot-dir": { type: "string" },
      },
    });
    const timeoutMs = Number(values["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw Error("Deadline must be 1 through 30000ms");
    console.log(
      JSON.stringify(
        await prove({
          origin: values.origin || "",
          expectedCommit: values["expected-commit"] || "",
          timeoutMs,
          fixture: values.fixture ?? false,
          ...(values["cdp-url"] ? { cdpUrl: values["cdp-url"] } : {}),
          ...(values["screenshot-dir"] ? { screenshotDir: values["screenshot-dir"] } : {}),
        }),
      ),
    );
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
