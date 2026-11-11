import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium as driver } from "playwright";
import { parseNeeds, parseVendorNeeds } from "../src/ui/deal-client-needs-model.ts";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function prove({
  origin,
  vendor,
  deal,
  client,
  expectedProducerCommit,
  producerOrigin = "https://api.doctorcre.com",
  producerRepository,
  expectedCommit,
  cdpUrl,
  fixture = false,
  timeoutMs = 30000,
  screenshotDir,
}: {
  origin: string;
  vendor: string;
  deal: string;
  client: string;
  expectedProducerCommit: string;
  producerOrigin?: string;
  producerRepository?: string;
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
    const producerResponse = await proofFetch(new URL("/release", producerOrigin), { signal: controller.signal });
    const producer = await producerResponse.json();
    if (!producerResponse.ok || !/^[a-f0-9]{40}$/.test(producer.git_sha ?? ""))
      throw insufficient("Producer release unavailable");
    await requireContainingRelease(expectedProducerCommit, producer.git_sha, {
      signal: controller.signal,
      ...(producerRepository ? { cwd: producerRepository } : {}),
    });
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
          "read-deal-client-needs-v1",
          "get-deal-room",
          "deal-room-board",
          "deal-room",
          "standing-context",
          "self",
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
    await activePage.goto(`${origin}/deals?deal=${encodeURIComponent(deal)}`, { timeout: remaining() });
    const read = async (verb: string, args: Record<string, unknown>) =>
      activePage.evaluate(
        async ({ verb, args }) => {
          const modulePath = "/js/mcp-requests.mjs";
          const { createMcpRequests } = await import(modulePath);
          const result = await createMcpRequests()(verb, args, { timeoutMs: 10000 });
          if (result.kind !== "payload" || result.isError) throw Error("Read unavailable");
          return result.payload;
        },
        { verb, args },
      );
    const snapshot = parseNeeds(await read("read-deal-client-needs-v1", { deal, limit: 50, offset: 0 }), {
      deal,
      client,
      offset: 0,
    });
    const approved = snapshot.rows.find((n) => n.state === "approved" && n.vendor_id === vendor);
    const excluded = snapshot.rows.find(
      (n) => ["withdrawn", "edited_lapsed"].includes(n.state) && n.vendor_id === vendor,
    );
    if (!approved || !excluded) throw insufficient("No qualifying approved and withdrawn or lapsed recorded needs");
    let offset = 0;
    let found = false;
    const ids = new Set<string>();
    for (let count = 0; count < 20; count++) {
      const matches = parseVendorNeeds(
        await read("read-vendor-client-needs-v1", { vendor, limit: 50, offset }),
        vendor,
        offset,
      );
      for (const n of matches.rows) {
        ids.add(n.id);
        if (n.id === approved.id) {
          assert.deepEqual(n, approved);
          found = true;
        }
      }
      if (matches.next_offset === null) break;
      if (count === 19) throw insufficient("Vendor match pagination exceeds proof budget");
      offset = matches.next_offset;
    }
    assert.equal(found, true);
    assert.equal(ids.has(excluded.id), false);
    const section = activePage.getByRole("region", { name: "Client needs", exact: true });
    const row = section.locator(`[data-client-need="${approved.id}"]`);
    await row.waitFor({ timeout: remaining() });
    const reviewable = snapshot.rows.find(
      (n) =>
        ["draft", "edited_lapsed"].includes(n.state) &&
        n.restriction === "allowed" &&
        !n.identity_restricted &&
        Date.parse(n.fresh_until) > Date.now(),
    );
    if (!reviewable) throw insufficient("No reviewable saved revision to cancel");
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await activePage.setViewportSize({ width, height: 900 });
        await activePage.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
        for (const [field, value] of Object.entries({
          Client: `${approved.client_name} (${approved.client_id})`,
          Deal: `${approved.deal_name} (${approved.deal_id})`,
          Vendor: `${approved.vendor_ref} (${approved.vendor_id})`,
          Need: approved.id,
          Revision: String(approved.revision),
          "Approval revision": String(approved.approved_revision),
          Applicability: approved.applicability,
          Restriction: approved.restriction,
          Source: approved.source_ref,
          "Source revision": approved.source_revision,
          "Observed at": approved.observed_at,
          "Fresh until": approved.fresh_until,
        }))
          assert.equal(await row.locator(`[data-need-field="${field}"]`).textContent(), value);
        await section
          .locator(`[data-client-need="${reviewable.id}"]`)
          .getByRole("button", { name: "Review for approval" })
          .click({ timeout: remaining() });
        const review = section.getByRole("region", { name: "Review need revision" });
        await review.waitFor({ timeout: remaining() });
        assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (screenshotDir)
          await activePage.screenshot({ path: `${screenshotDir}/${width}-${theme}.png`, fullPage: true });
        await review.getByRole("button", { name: "Cancel review" }).click({ timeout: remaining() });
        observations.push({ width, theme, approvedNeed: approved.id, excludedNeed: excluded.id });
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
        deal: { type: "string" },
        client: { type: "string" },
        "expected-producer-commit": { type: "string" },
        "producer-origin": { type: "string" },
        "producer-repository": { type: "string" },
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
          deal: values.deal || "",
          client: values.client || "",
          expectedProducerCommit: values["expected-producer-commit"] || "",
          ...(values["producer-origin"] ? { producerOrigin: values["producer-origin"] } : {}),
          ...(values["producer-repository"] ? { producerRepository: values["producer-repository"] } : {}),
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
