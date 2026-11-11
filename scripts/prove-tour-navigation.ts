import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page, Response } from "playwright";
import { navigationFromEvidence } from "../src/ui/tour-navigation.ts";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { chromium } from "./proof-browser.mjs";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type AcceptedRoute = Parameters<typeof navigationFromEvidence>[1] & { accepted: true; navigation: unknown };
function isAcceptedRoute(value: unknown): value is AcceptedRoute {
  return (
    isRecord(value) &&
    value.accepted === true &&
    typeof value.id === "string" &&
    typeof value.route_version === "number" &&
    Array.isArray(value.stops) &&
    value.stops.every(
      (stop) =>
        isRecord(stop) &&
        ["id", "property_id", "route_label", "stop_state"].every((key) => typeof stop[key] === "string") &&
        typeof stop.route_sequence === "number",
    )
  );
}
export async function prove({
  origin,
  commit,
  tourId,
  storageState,
  fixture = false,
  timeoutMs = 30000,
}: {
  origin: string;
  commit: string;
  tourId: string;
  storageState?: string | undefined;
  fixture?: boolean;
  timeoutMs?: number;
}) {
  const base = new URL(origin);
  assert.ok(base.href === `${base.origin}/` && !base.username && !base.password, "origin only");
  assert.ok(timeoutMs > 0 && timeoutMs <= 60000, "bounded deadline");
  if (fixture && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw unavailable("Fixture requires loopback");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable("Proof deadline exceeded")), timeoutMs);
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
  );
  void aborted.catch(() => {});
  function bounded<T>(value: Promise<T>) {
    return Promise.race([value, aborted]);
  }
  let browser: Browser | undefined;
  try {
    const release = await bounded(readAppRelease(base, { timeoutMs }));
    if (!/^[a-f0-9]{40}$/.test(commit) || /^0+$/.test(commit)) throw unavailable("Expected merge commit required");
    if (!/^[a-f0-9-]{36}$/.test(tourId)) throw unavailable("Approved Tour identity required");
    if (release.source_commit !== commit) {
      await bounded(
        new Promise<void>((resolve, reject) => {
          execFile(
            "git",
            ["merge-base", "--is-ancestor", commit, release.source_commit],
            { signal: controller.signal, timeout: timeoutMs },
            (error) => (error ? reject(unavailable("Release does not contain the expected merge")) : resolve()),
          );
        }),
      );
    }
    if (!fixture && !storageState) throw unavailable("Signed-in storage state and an approved route are required");
    try {
      browser = await launchProofBrowser(chromium, { timeout: timeoutMs }, { signal: controller.signal });
    } catch {
      throw unavailable("Proof browser unavailable");
    }
    const receipts = [];
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"] as const) {
        const page: Page = await bounded(
          browser.newPage({
            viewport: { width, height: 1000 },
            colorScheme: theme,
            ...(storageState ? { storageState } : {}),
          }),
        );
        await bounded(
          page.addInitScript(
            (value) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: value })),
            theme,
          ),
        );
        await bounded(
          page.route("**/*", (route) =>
            ["GET", "HEAD"].includes(route.request().method()) ? route.fallback() : route.abort(),
          ),
        );
        const response: Promise<Response> = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/tours/detail" && response.ok(),
          { timeout: timeoutMs },
        );
        await bounded(
          page.goto(new URL(`/tours/route-editor.html?tour=${encodeURIComponent(tourId)}`, base).href, {
            timeout: timeoutMs,
          }),
        );
        assert.equal(await bounded(page.locator("html").getAttribute("data-theme")), theme);
        void response.catch(() => {});
        const payload: unknown = await bounded((await bounded(response)).json());
        if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.routes))
          throw unavailable("Tour detail unavailable");
        const route = payload.data.routes.find(isAcceptedRoute);
        if (!route) throw unavailable("No accepted production route");
        const navigation = navigationFromEvidence(tourId, route, route.navigation);
        if (!navigation) throw unavailable("Approved entrance and matching current promotion evidence required");
        const stop = route.stops.filter((item) => item.stop_state === "active").at(-1);
        if (!stop) throw unavailable("Approved stop required");
        const point = navigation.positions.get(stop.id);
        assert.ok(point);
        const root = page.locator("#accepted-itinerary");
        await bounded(root.locator(`[data-itinerary-stop="${stop.id}"] button`).click({ timeout: timeoutMs }));
        const link = root.getByRole("link", { name: "Navigate with Google Maps", exact: true });
        const expected = `https://www.google.com/maps/dir/?api=1&destination=${point.latitude},${point.longitude}&travelmode=driving`;
        assert.equal(await bounded(link.getAttribute("href", { timeout: timeoutMs })), expected);
        await bounded(link.evaluate((el) => el.addEventListener("click", (event) => event.preventDefault())));
        await bounded(link.click({ timeout: timeoutMs }));
        await bounded(page.reload({ timeout: timeoutMs }));
        await bounded(root.locator("[aria-current=step]").waitFor({ timeout: timeoutMs }));
        assert.equal(await bounded(root.locator("[aria-current=step]").getAttribute("data-itinerary-stop")), stop.id);
        receipts.push({ width, theme, stop: stop.id, link: expected });
        await page.close();
      }
    return { status: "passed", release, receipts, device_handoff: "requires separate device observation" };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && error.name === "TimeoutError")
      throw unavailable("Authenticated Tour observation unavailable");
    throw error;
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        commit: { type: "string" },
        tour: { type: "string" },
        "storage-state": { type: "string" },
        "timeout-ms": { type: "string" },
        fixture: { type: "boolean" },
      },
    });
    console.log(
      JSON.stringify(
        await prove({
          origin: values.origin ?? "https://app.doctorcre.com",
          commit: values.commit ?? "",
          tourId: values.tour ?? "",
          storageState: values["storage-state"],
          fixture: values.fixture ?? false,
          timeoutMs: Number(values["timeout-ms"] ?? 30000),
        }),
      ),
    );
  } catch (error) {
    const code =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
    console.log(
      JSON.stringify({
        status: code === 78 ? "insufficient_evidence" : "assertion_failure",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = code;
  }
}
