import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

export function parseArgs(args: string[]) {
  const options: { timeoutMs: number; origin?: string | undefined; expectedCommit?: string | undefined } = {
    timeoutMs: 30000,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") return { help: true };
    if (args[i] === "--origin") options.origin = args[++i];
    else if (args[i] === "--expected-commit") options.expectedCommit = args[++i];
    else if (args[i] === "--timeout-ms") options.timeoutMs = Number(args[++i]);
    else throw Error(`Unknown option ${args[i]}`);
  }
  const url = new URL(options.origin || "");
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== options.origin)
    throw Error("Expected an HTTP origin without a path");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)
    throw Error("Timeout must be 1 through 30000ms");
  return { origin: url.origin, timeoutMs: options.timeoutMs, expectedCommit: options.expectedCommit };
}

export async function prove({
  origin,
  expectedCommit,
  timeoutMs = 30000,
  screenshotDir,
}: {
  origin: string;
  expectedCommit: string | undefined;
  timeoutMs?: number;
  screenshotDir?: string;
}) {
  const controller = new AbortController();
  const expired = () => Object.assign(Error("Proof deadline exceeded"), { exitCode: 78 });
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    controller.signal.throwIfAborted();
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw expired();
    return ms;
  };
  const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const release = await readAppRelease(origin, { timeoutMs: remaining() });
    if (!expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit) || /^0+$/.test(expectedCommit))
      throw Object.assign(Error("Expected merge commit required"), { exitCode: 78 });
    remaining();
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    browser = await launchProofBrowser(
      chromium,
      { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() },
      { signal: controller.signal },
    );
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(remaining());
    const modules = new Set<string>();
    let requests = 0;
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (++requests > 50 || request.method() !== "GET" || url.origin !== origin) return route.abort();
      if (url.pathname === "/__revoked-controls-proof")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><title>Tour session proof</title><div id="view"></div>',
        });
      if (url.pathname.startsWith("/tours/"))
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic editor</title>" });
      if (url.pathname === "/app-release" || url.pathname.startsWith("/js/")) return route.continue();
      return route.abort();
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith(".js")) modules.add(response.url());
    });
    await page.goto(`${origin}/__revoked-controls-proof`);
    const assertions = [];
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        assertions.push(
          await page.evaluate(async () => {
            const { mountDealTours } = await import("/js/ui-deal-tours.generated.js");
            if (typeof mountDealTours !== "function") throw Error("Missing mountDealTours export");
            const root = document.querySelector("#view");
            if (!root) throw Error("Proof mount missing");
            const dealId = "11111111-1111-4111-8111-111111111111";
            let reads = 0,
              navigations = 0;
            const client = {
              scope: "verified-synthetic-actor",
              library: async () => {
                ++reads;
                return [];
              },
              tour: async () => {
                ++reads;
                throw Error("Unexpected detail");
              },
            };
            const panel = mountDealTours(root, {
              dealId,
              client,
              navigate() {
                ++navigations;
              },
            });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            root.querySelector<HTMLButtonElement>("[data-start-tour]")?.click();
            if (!root.querySelector("iframe")) throw Error("Fresh verified mount did not create editor");
            dispatchEvent(new Event("doctorcre-session-invalidated"));
            const before = { reads, navigations };
            root.querySelector("[data-start-tour]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            root.querySelector("[data-refresh-tours]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await panel.refresh();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (root.querySelector("iframe")) throw Error("Retired instance recreated iframe");
            if (reads !== before.reads || navigations !== before.navigations)
              throw Error("Retired instance issued a read or navigation");
            if (!root.textContent.includes("session has changed")) throw Error("Retired status missing");
            panel.dispose();
            const fresh = mountDealTours(root, { dealId, client, navigate() {} });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            root.querySelector<HTMLButtonElement>("[data-start-tour]")?.click();
            if (!root.querySelector("iframe")) throw Error("Separately verified fresh mount failed");
            dispatchEvent(new Event("doctorcre-session-invalidated"));
            window.__tourProofDispose = () => fresh.dispose();
            return {
              clearedFrame: true,
              refusedStartAndRefresh: true,
              zeroNewReadsAndNavigation: true,
              freshMountWorks: true,
            };
          }),
        );
        if (screenshotDir)
          await page.screenshot({ path: `${screenshotDir}/${width}-${theme}-retired.png`, fullPage: true });
        await page.evaluate(() => window.__tourProofDispose());
      }
    return {
      origin,
      expectedCommit,
      release,
      loadedModuleUrls: [...modules],
      assertions,
      requests,
      evidenceClass: "deployed-code-synthetic-clients",
    };
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if ("help" in options)
      console.log(
        "Usage: node scripts/prove-deal-tours-revoked-controls.ts --origin <http-origin> --expected-commit <merge-sha> --timeout-ms 30000",
      );
    else console.log(JSON.stringify(await prove(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
