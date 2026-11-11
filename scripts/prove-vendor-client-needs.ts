import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium as driver } from "playwright";
import { parseClientNeeds } from "../src/ui/vendor-client-needs-client.ts";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function prove({
  origin,
  vendor,
  expectedCommit,
  cdpUrl,
  fixture = false,
  timeoutMs = 30000,
  screenshotDir,
}: {
  origin: string;
  vendor: string;
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
  let containingRelease = false;
  const observations: unknown[] = [];
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: remaining() });
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    containingRelease = true;
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
          "read-vendor-client-needs-v1",
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
    await activePage.setViewportSize({ width: 1440, height: 900 });
    const read = activePage.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/mcp" &&
        r.request().postDataJSON()?.params?.name === "read-vendor-client-needs-v1",
      { timeout: remaining() },
    );
    read.catch(() => {});
    await activePage.goto(`${origin}/vendors?record=${encodeURIComponent(vendor)}`, { timeout: remaining() });
    const response = await read;
    if (!response.ok()) throw insufficient("Authorized client needs unavailable");
    const envelope = await response.json();
    const text = envelope?.result?.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text;
    if (typeof text !== "string" || envelope.result.isError) throw insufficient("Client needs source unavailable");
    const snapshot = parseClientNeeds(JSON.parse(text), { vendor, offset: 0, limit: 5 });
    if (!snapshot.rows.length)
      throw insufficient("No approved recorded need exists for this vendor; positive proof unobserved");
    const section = activePage.getByRole("region", { name: "Approved client needs", exact: true });
    await section.locator("[data-need-id]").first().waitFor({ timeout: remaining() });
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await activePage.setViewportSize({ width: 1440, height: 900 });
        await activePage.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
        assert.equal(await activePage.locator("html").getAttribute("data-theme"), theme);
        await activePage.setViewportSize({ width, height: 900 });
        const rows = section.locator("[data-need-id]");
        assert.equal(await rows.count(), snapshot.rows.length);
        for (const [index, need] of snapshot.rows.entries()) {
          const row = rows.nth(index);
          assert.equal(await row.getAttribute("data-need-id"), need.id);
          for (const value of [
            need.client_name,
            need.description,
            need.deal_name,
            need.applicability,
            need.source_ref,
            need.source_revision,
            `Approved · revision ${need.approved_revision}`,
            need.approved_at,
            need.fresh_until,
          ])
            assert.equal(await row.getByText(value, { exact: true }).count(), 1);
          if (!(await row.locator("details").getAttribute("open")))
            await row.locator("summary").click({ timeout: remaining() });
          for (const value of [need.id, need.client_id, need.deal_id, need.vendor_id, need.approved_by])
            assert.equal(await row.getByText(value, { exact: true }).count(), 1);
        }
        assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (screenshotDir)
          await activePage.screenshot({ path: `${screenshotDir}/${width}-${theme}.png`, fullPage: true });
        observations.push({ width, theme, needs: snapshot.rows.length });
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
    if (!containingRelease || !(error instanceof assert.AssertionError))
      throw error instanceof Error ? Object.assign(error, { exitCode: 78 }) : insufficient(String(error));
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
        vendor: { type: "string" },
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
          vendor: values.vendor || "",
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
