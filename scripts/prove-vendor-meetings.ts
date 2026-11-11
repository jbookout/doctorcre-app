import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium as driver } from "playwright";
import type { MeetingQuery } from "../src/ui/vendor-meetings-client.ts";
import { parseMeetingPage, researchReason } from "../src/ui/vendor-meetings-client.ts";
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
        const response = activePage.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/mcp" && r.request().postDataJSON()?.params?.name === "read-vendor-meetings",
          { timeout: remaining() },
        );
        response.catch(() => {});
        await activePage.goto(`${origin}/vendors`, { timeout: remaining() });
        const section = activePage.getByRole("region", { name: "People worth meeting" });
        if (width === 390) await activePage.locator(".vendor-meetings > summary").click({ timeout: remaining() });
        for (const view of ["suggested", "research"] satisfies MeetingQuery["view"][]) {
          const read =
            view === "suggested"
              ? response
              : activePage.waitForResponse(
                  (r) =>
                    new URL(r.url()).pathname === "/mcp" &&
                    r.request().postDataJSON()?.params?.name === "read-vendor-meetings" &&
                    r.request().postDataJSON()?.params?.arguments?.view === "research",
                  { timeout: remaining() },
                );
          read.catch(() => {});
          if (view === "research")
            await section.getByRole("tab", { name: "Research", exact: true }).click({ timeout: remaining() });
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
            throw insufficient("Authorized response unavailable");
          const content = envelope.result.content.find(
            (c: unknown) => c && typeof c === "object" && "type" in c && c.type === "text",
          );
          if (!content || typeof content.text !== "string") throw insufficient("Authorized response unavailable");
          const snapshot = parseMeetingPage(JSON.parse(content.text), { view, q: "", limit: 5 });
          await section.locator('[role="tabpanel"][aria-busy="false"]').waitFor({ timeout: remaining() });
          assertionsStarted = true;
          assert.equal(
            await section
              .getByRole("tab", { name: view === "suggested" ? "Suggested" : "Research", exact: true })
              .getAttribute("aria-selected"),
            "true",
          );
          assert.equal(
            await section
              .getByText(
                `${snapshot.total} ${view === "suggested" ? "suggested people" : "people needing research"}. Showing ${snapshot.items.length}.`,
                { exact: true },
              )
              .count(),
            1,
          );
          const rows = section.locator("[data-meeting-person]");
          assert.equal(await rows.count(), snapshot.items.length);
          assert.equal(
            await section
              .getByText("Calendar unavailable. People and office details are still shown.", { exact: true })
              .count(),
            snapshot.calendar.state === "unavailable" ? 1 : 0,
          );
          for (const note of snapshot.calendar.notes ?? [])
            assert.equal(await section.getByText(note, { exact: true }).count(), 1);
          for (const [index, item] of snapshot.items.entries()) {
            const row = rows.nth(index);
            assert.equal(await row.getAttribute("data-meeting-person"), item.contact?.id ?? "");
            assert.equal(
              await row.locator(":scope > a").textContent(),
              item.contact?.name || "Named contact not recorded",
            );
            assert.equal(
              await row.locator("[data-meeting-office]").textContent(),
              item.office
                ? `${item.office.street_address}, ${item.office.city}, ${item.office.state}`
                : "Verified office not recorded",
            );
            assert.equal(
              await row.locator("[data-meeting-reason]").textContent(),
              item.reason || "Meeting reason not recorded",
            );
            if (item.office)
              assert.equal(await row.getByText(`Office source: ${item.office.source}`, { exact: true }).count(), 1);
            assert.deepEqual(
              await row.locator('[aria-label="Research needed"] > li').allTextContents(),
              item.missing.map(researchReason),
            );
            for (const value of [
              item.company?.name || "Company not recorded",
              item.contact?.email || "Email not recorded",
              item.contact?.phone || item.contact?.cell || "Phone not recorded",
            ])
              assert.equal(await row.getByText(value, { exact: true }).count(), 1);
            assert.deepEqual(
              await row.locator("h3 + ul > li").allTextContents(),
              item.possible_meetings.map(
                (m) => `${m.title} · ${m.start} to ${m.end}${m.location ? ` · ${m.location}` : ""}`,
              ),
            );
          }
          assert.equal(
            await activePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            "No horizontal overflow",
          );
          if (screenshotDir)
            await activePage.screenshot({ path: `${screenshotDir}/${view}-${width}-${theme}.png`, fullPage: true });
          observations.push({
            width,
            theme,
            view,
            total: snapshot.total,
            people: snapshot.items.map((p) => p.contact?.id ?? null),
          });
        }
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
