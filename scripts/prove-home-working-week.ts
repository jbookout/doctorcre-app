import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { chromium as driver } from "playwright";
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
    if (fixture) await activePage.clock.setFixedTime(new Date());
    await activePage.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === "GET") return route.continue();
      if (
        url.pathname === "/mcp" &&
        [
          "read-home-agenda",
          "calendar-meeting-prep",
          "deal-room-board",
          "morning-brief",
          "today-triage",
          "change-feed",
          "read-home-inbox-v5",
          "read-home-inbox-v4",
          "read-home-inbox-v3",
          "read-home-inbox-v2",
          "read-home-inbox",
          "relationship-network",
          "notification-count",
          "read-notifications",
          "doc_activity",
        ].includes(request.postDataJSON()?.params?.name)
      )
        return route.continue();
      return route.abort();
    });
    await activePage.goto(`${origin}/${fixture ? "?fixture=1" : ""}`, { timeout: remaining() });
    const week = activePage.getByRole("region", { name: "Working week", exact: true });
    await week.waitFor({ timeout: remaining() });
    const expected = await activePage.evaluate(async (fixture) => {
      const { createClient } = await import("/js/" + "client.js");
      const { readHomeAgenda, agendaSnapshot } = await import("/js/" + "home-dashboard-model.js");
      const { homeWeek } = await import("/js/" + "home-week.js");
      const { localToday } = await import("/js/" + "calendar-model.js");
      const client = await createClient(fixture ? "fixture" : "live", { docContext: false });
      const [source, calendar] = await Promise.all([readHomeAgenda(client), client.calendarMeetingPrep()]);
      return {
        days: homeWeek({ agenda: agendaSnapshot(source.board, source.details), calendar, today: localToday() }),
        state: calendar.state,
      };
    }, fixture);
    type Row = { key: string; label: string; time?: string; start?: string; end?: string; deal_id?: string };
    type Day = { day: string; dated: Row[]; allDay: Row[]; timed: Row[] };
    const days: Day[] = expected.days;
    if (!days.some((day) => day.dated.length) || !days.some((day) => day.allDay.length || day.timed.length))
      throw insufficient("Existing dated work and meeting cohort required");
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await activePage.setViewportSize({ width, height: 900 });
        await activePage.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const [index, day] of days.entries()) {
          const choose = week.getByRole("button", { name: /\d{4}/ }).nth(index);
          await choose.click({ timeout: remaining() });
          assert.equal(await choose.getAttribute("aria-pressed"), "true");
          const rows = [...day.dated, ...day.allDay, ...day.timed];
          assert.deepEqual(
            await week
              .locator("[data-week-entry]")
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-week-entry"))),
            rows.map((row) => row.key),
          );
          assert.deepEqual(
            await week.locator("[data-week-entry] strong").allTextContents(),
            rows.map((row) => row.label),
          );
          for (const [rowIndex, row] of rows.entries()) {
            const button = week.locator("[data-week-entry]").nth(rowIndex);
            assert.equal(await button.locator("small").textContent(), row.time || "Dated deal work");
            await button.click({ timeout: remaining() });
            const detail = activePage.getByRole("dialog", { name: "Calendar item details" });
            assert.equal(await detail.locator("h2").textContent(), row.label);
            assert.deepEqual(
              await detail.locator("time").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime"))),
              row.start ? [row.start, ...(row.end ? [row.end] : [])] : [],
            );
            assert.equal(await detail.getByRole("link").count(), row.deal_id ? 1 : 0);
            if (row.deal_id)
              assert.equal(
                await detail.getByRole("link").getAttribute("href"),
                `/deals?deal=${encodeURIComponent(row.deal_id)}`,
              );
            await detail.getByRole("button", { name: "Return to day" }).click({ timeout: remaining() });
            assert.equal(await button.evaluate((node) => node === document.activeElement), true);
            assert.equal(await choose.getAttribute("aria-pressed"), "true");
          }
        }
        assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (expected.state === "partial")
          assert.equal(
            await week
              .getByText("Calendar coverage is incomplete. Check Outlook for changes.", { exact: true })
              .count(),
            1,
          );
        if (screenshotDir)
          await activePage.screenshot({ path: `${screenshotDir}/${width}-${theme}.png`, fullPage: true });
        observations.push({
          width,
          theme,
          days: days.length,
          rows: days.flatMap((day) => [...day.dated, ...day.allDay, ...day.timed]).length,
        });
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
