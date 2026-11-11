import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

export async function observeStopDrag(page: Page) {
  const editor = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
  if (!editor) throw Object.assign(Error("Open an editable Tour in its deal workspace"), { exitCode: 78 });
  const list = editor.locator("#route-stops");
  const order = () =>
    list.locator(":scope > li").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-property-id")));
  const handles = list.locator("[data-stop-drag]:enabled");
  if ((await handles.count()) < 2) throw Object.assign(Error("Two editable flexible stops required"), { exitCode: 78 });
  const before = await order();
  const source = await handles.first().evaluate((el) => el.closest("li")?.getAttribute("data-property-id"));
  const target = await handles.nth(1).evaluate((el) => el.closest("li")?.getAttribute("data-property-id"));
  if (!source || !target) throw Error("Property identity missing");
  await handles.first().scrollIntoViewIfNeeded();
  const from = await handles.first().boundingBox();
  assert.ok(from);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    const destination = list.locator(`[data-property-id="${target}"] .stop-head`);
    await destination.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const to = await destination.boundingBox();
    assert.ok(to);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
    const expected = [...before];
    const a = expected.indexOf(source),
      b = expected.indexOf(target);
    [expected[a], expected[b]] = [expected[b] ?? null, expected[a] ?? null];
    assert.deepEqual(await order(), expected);
    await editor.locator("#undo-route").click();
    assert.deepEqual(await order(), before);
    return before;
  } finally {
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
}

export async function prove(options: {
  origin: string;
  expectedCommit: string;
  tourUrl: string;
  storageState?: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const insufficient = () =>
    Object.assign(Error("Tour proof deadline or signed-in evidence unavailable"), { exitCode: 78 });
  const timer = setTimeout(() => controller.abort(insufficient()), options.timeoutMs);
  const deadline = performance.now() + options.timeoutMs;
  const remaining = () => {
    controller.signal.throwIfAborted();
    return Math.max(1, Math.ceil(deadline - performance.now()));
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const release = await readAppRelease(options.origin, { timeoutMs: remaining() });
    if (!/^[a-f0-9]{40}$/.test(options.expectedCommit)) throw insufficient();
    await requireContainingRelease(options.expectedCommit, release.source_commit, { signal: controller.signal });
    if (!options.tourUrl || new URL(options.tourUrl).origin !== options.origin || !options.storageState)
      throw insufficient();
    let context: BrowserContext;
    let page: Page;
    try {
      browser = await launchProofBrowser(
        chromium,
        { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() },
        { signal: controller.signal },
      );
      context = await browser.newContext({ storageState: options.storageState, serviceWorkers: "block" });
      page = await context.newPage();
    } catch (error) {
      throw Object.assign(insufficient(), { cause: error });
    }
    let writes = 0,
      requests = 0;
    await context.route("**/*", (route) => {
      const request = route.request();
      if (++requests > 300 || new URL(request.url()).origin !== options.origin) return route.abort();
      if (!["GET", "HEAD"].includes(request.method())) {
        writes++;
        return route.abort();
      }
      return route.continue();
    });
    page.setDefaultTimeout(remaining());
    const observations = [];
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(options.tourUrl);
        await page.locator('iframe[title="Tour shortlist, route and packet"]').waitFor();
        await page.frameLocator('iframe[title="Tour shortlist, route and packet"]').locator("#route-editing").waitFor();
        const editor = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
        if (!editor) throw insufficient();
        await editor.locator("#route-editing").evaluate((el) => {
          if (el instanceof HTMLDetailsElement) el.open = true;
        });
        await editor.locator("[data-stop-drag]").first().waitFor();
        await editor.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const before = await observeStopDrag(page);
        await page.reload();
        const refreshed = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
        await refreshed.locator("#route-stops > li").first().waitFor({ state: "attached" });
        assert.deepEqual(
          await refreshed
            .locator("#route-stops > li")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-property-id"))),
          before,
        );
        assert.equal(writes, 0);
        observations.push({ width, theme, orderRestored: true, canonicalReadbackUnchanged: true });
      }
    return { release, observations, writes };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw insufficient();
    throw error;
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (key: string) => {
    const index = args.indexOf(key);
    return index < 0 ? "" : (args[index + 1] ?? "");
  };
  try {
    const timeoutMs = Number(value("--timeout-ms") || 30000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error("Invalid timeout");
    const state = value("--storage-state");
    console.log(
      JSON.stringify(
        await prove({
          origin: value("--origin"),
          expectedCommit: value("--expected-commit"),
          tourUrl: value("--tour-url"),
          ...(state ? { storageState: state } : {}),
          timeoutMs,
        }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
