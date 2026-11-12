import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { parseOpportunityTiming } from "../src/ui/lead-opportunity-timing.ts";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
type Options = {
  origin: string;
  expectedCommit: string;
  producerOrigin: string;
  expectedProducerCommit?: string;
  producerCwd?: string;
  fixture?: boolean;
  cdpUrl?: string;
  timeoutMs?: number;
  screenshotDir?: string;
  engine?: Pick<typeof chromium, "launch"> & Partial<Pick<typeof chromium, "connectOverCDP">>;
};
export async function prove({
  origin,
  expectedCommit,
  producerOrigin,
  expectedProducerCommit,
  producerCwd,
  fixture = false,
  cdpUrl,
  timeoutMs = 30000,
  screenshotDir,
  engine = chromium,
}: Options) {
  const base = new URL(origin);
  if (base.origin !== origin || !["http:", "https:"].includes(base.protocol))
    throw insufficient("HTTP origin required");
  if (fixture && !["127.0.0.1", "localhost"].includes(base.hostname)) throw insufficient("Fixtures require loopback");
  if (!/^[a-f0-9]{40}$/.test(expectedCommit) || /^0+$/.test(expectedCommit))
    throw insufficient("Expected app merge commit required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw insufficient("Bounded timeout required");
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0 || controller.signal.aborted) throw insufficient("Proof deadline expired");
    return ms;
  };
  let browser: Browser | undefined, page: Page | undefined;
  let acquisition: Promise<Browser> | undefined, pageAcquisition: Promise<Page> | undefined;
  let containing = false;
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: remaining() });
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    if (!producerOrigin) throw insufficient("Producer release origin required");
    const response = await proofFetch(new URL("/release", producerOrigin), { signal: controller.signal });
    const producer = await response.json();
    if (!response.ok || typeof producer.git_sha !== "string")
      throw insufficient("Producer release identity unavailable");
    const producerCommit = expectedProducerCommit || (fixture ? "28ad26f601bdb4714331f122cd68337470509ef6" : "");
    if (!/^[a-f0-9]{40}$/.test(producerCommit) || /^0+$/.test(producerCommit))
      throw insufficient("Expected producer merge commit required");
    await requireContainingRelease(producerCommit, producer.git_sha, {
      signal: controller.signal,
      ...(producerCwd ? { cwd: producerCwd } : {}),
    });
    containing = true;
    if (fixture)
      browser = await launchProofBrowser(
        engine,
        { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() },
        { signal: controller.signal },
      );
    else {
      if (!cdpUrl || !engine.connectOverCDP) throw insufficient("Existing signed-in CDP session required");
      acquisition = engine.connectOverCDP(cdpUrl, { timeout: remaining() }).then(async (acquired) => {
        if (controller.signal.aborted) {
          await acquired.close();
          throw insufficient("Proof deadline expired");
        }
        return acquired;
      });
      browser = await acquisition;
    }
    const context = browser.contexts()[0];
    const pageOwner = fixture ? browser : context;
    if (!pageOwner) throw insufficient("Signed-in context required");
    pageAcquisition = pageOwner.newPage().then(async (acquired) => {
      if (controller.signal.aborted) {
        await acquired.close();
        throw insufficient("Proof deadline expired");
      }
      return acquired;
    });
    page = await pageAcquisition;
    const active = page;
    active.setDefaultTimeout(remaining());
    await active.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === "GET") return route.continue();
      if (
        url.pathname === "/mcp" &&
        request.method() === "POST" &&
        [
          "lead-board",
          "quiet-follow-ups",
          "list-practice-origination",
          "territory-state-board",
          "read-notifications",
          "notification-count",
          "doc_activity",
        ].includes(request.postDataJSON()?.params?.name)
      )
        return route.continue();
      return route.abort();
    });
    await active.goto(`${origin}/leads`, { timeout: remaining() });
    await active.locator("[data-open]").first().waitFor({ timeout: remaining() });
    const independent = await active.evaluate(async () => {
      const { createLeadBoardClient } = await import(String("/js/leads-client.js"));
      return createLeadBoardClient({ docContext: false }).getWorkspace();
    });
    const supported = independent.leads.find(
      (lead: { opportunity_timing?: { status: string } }) => lead.opportunity_timing?.status === "supported",
    );
    const unknown = independent.leads.find(
      (lead: { opportunity_timing?: { status: string } }) => lead.opportunity_timing?.status === "unknown",
    );
    if (!supported || !unknown) throw insufficient("Existing supported and unknown leads required");
    const instant = (v: string) =>
      new Date(v).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
    const day = (v: string) =>
      new Date(`${v}T12:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await active.setViewportSize({ width, height: 900 });
        await active.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const lead of [supported, unknown]) {
          assert.match(lead.id, /^[a-f0-9-]+$/);
          const timing = parseOpportunityTiming(lead.opportunity_timing);
          const button = active.locator(`[data-open="${lead.id}"]`).first();
          await button.focus();
          await button.press("Enter", { timeout: remaining() });
          const panel = active.locator("#detailBody .lead-timing");
          await panel.waitFor({ timeout: remaining() });
          assert.equal(
            await panel.locator("[data-timing-added]").textContent(),
            `Added ${instant(timing.record_added_at)}`,
          );
          assert.equal(
            await panel.locator("[data-timing-added] time").getAttribute("datetime"),
            timing.record_added_at,
          );
          if (timing.status === "unknown") {
            assert.equal(await panel.locator("[data-timing-evidence]").textContent(), "Opportunity timing unknown");
            assert.equal(await panel.locator("[data-timing-evidence] time").count(), 0);
          } else {
            const summary = panel.locator("summary");
            await summary.focus();
            await summary.press("Enter", { timeout: remaining() });
            assert.equal(await panel.locator("li").count(), timing.events.length);
            for (const [index, event] of timing.events.entries()) {
              const row = panel.locator("li").nth(index);
              assert.equal(await row.locator("strong").textContent(), event.meaning);
              assert.deepEqual(await row.locator("dd").allTextContents(), [
                day(event.date),
                event.date_basis,
                event.source,
                event.record_key,
                `Revision ${event.revision}`,
                day(event.published_on),
                instant(event.observed_at),
                event.source_url,
              ]);
              assert.deepEqual(
                await row.locator("time").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("datetime"))),
                [event.date, event.published_on, event.observed_at],
              );
              assert.equal(await row.locator("p").textContent(), event.uncertainty);
            }
          }
          assert.equal(await active.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          if (screenshotDir)
            await active.screenshot({ path: `${screenshotDir}/${width}-${theme}-${timing.status}.png` });
          await active.keyboard.press("Escape");
          await active.locator("#leadDetail").waitFor({ state: "hidden", timeout: remaining() });
          assert.equal(await button.evaluate((node) => node === document.activeElement), true);
        }
      }
    assert.equal((await readAppRelease(origin, { timeoutMs: remaining() })).source_commit, release.source_commit);
    return { status: "passed", scope: fixture ? "synthetic" : "natural", release };
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
    if (!containing || !(error instanceof assert.AssertionError))
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
        "expected-commit": { type: "string" },
        "producer-origin": { type: "string" },
        "producer-commit": { type: "string" },
        "producer-cwd": { type: "string" },
        "cdp-url": { type: "string" },
        fixture: { type: "boolean" },
        "timeout-ms": { type: "string" },
        "screenshot-dir": { type: "string" },
      },
    });
    console.log(
      JSON.stringify(
        await prove({
          origin: values.origin || "",
          expectedCommit: values["expected-commit"] || "",
          producerOrigin: values["producer-origin"] || "",
          ...(values["producer-commit"] ? { expectedProducerCommit: values["producer-commit"] } : {}),
          fixture: values.fixture ?? false,
          timeoutMs: Number(values["timeout-ms"] || 30000),
          ...(values["producer-cwd"] ? { producerCwd: values["producer-cwd"] } : {}),
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
