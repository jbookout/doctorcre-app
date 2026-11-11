import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page, Response } from "playwright";
import { parseCoordinateReview } from "../src/ui/tour-coordinate-review-model.ts";
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
  coordinateReview = false,
  unapprovedTour,
}: {
  origin: string;
  commit: string;
  tourId: string;
  storageState?: string | undefined;
  fixture?: boolean;
  timeoutMs?: number;
  coordinateReview?: boolean;
  unapprovedTour?: string;
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
    if (coordinateReview && (!unapprovedTour || !/^[a-f0-9-]{36}$/.test(unapprovedTour)))
      throw unavailable("An existing unapproved Tour is required for the negative navigation observation");
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
        if (coordinateReview) {
          const panel = page.locator("#coordinate-review");
          let observedCandidates = 0;
          for (const stop of route.stops) {
            if (stop.stop_state !== "active") continue;
            const review = parseCoordinateReview(Reflect.get(stop, "coordinate_review"), stop.property_id);
            if (!review) throw unavailable("Coordinate review contract unavailable");
            await bounded(panel.locator("select[data-coordinate-property]").selectOption(stop.property_id));
            assert.equal(
              await bounded(panel.locator("h3").textContent()),
              review.property_name ?? "Property name unknown",
            );
            assert.equal(await bounded(panel.locator("[data-coordinate-candidate]").count()), review.candidates.length);
            assert.equal(
              await bounded(panel.locator("h3 + p").textContent()),
              review.property_address ?? "Address unknown",
            );
            assert.equal(
              await bounded(panel.locator("select[data-coordinate-property] option:checked").textContent()),
              review.property_name ?? "Property name unknown",
            );
            for (const [index, candidate] of review.candidates.entries()) {
              observedCandidates++;
              const card = panel.locator("[data-coordinate-candidate]").nth(index);
              const rows: [string, string][] = [];
              const flatten = (value: unknown, prefix = "") => {
                if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                  for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key);
                } else
                  rows.push([
                    prefix,
                    value === null ? "Unknown" : Array.isArray(value) ? value.join(", ") : String(value),
                  ]);
              };
              flatten(candidate);
              for (const [key, value] of rows)
                assert.equal(await bounded(card.locator(`dd[data-coordinate-field="${key}"]`).textContent()), value);
              assert.equal(await bounded(card.locator("a").count()), 0);
            }
          }
          if (!observedCandidates) throw unavailable("Positive coordinate candidates required");
        }
        const navigation = navigationFromEvidence(tourId, route, route.navigation);
        if (!navigation) throw unavailable("Approved entrance and matching current promotion evidence required");
        const stop = route.stops.filter((item) => item.stop_state === "active").at(-1);
        if (!stop) throw unavailable("Approved stop required");
        const point = navigation.positions.get(stop.id);
        if (coordinateReview) {
          const review = parseCoordinateReview(Reflect.get(stop, "coordinate_review"), stop.property_id);
          const entrance = review?.candidates.find(
            (candidate) =>
              candidate.approval.status === "verified_entrance" &&
              candidate.position?.latitude === point?.latitude &&
              candidate.position?.longitude === point?.longitude,
          );
          if (!entrance) throw unavailable("Matching approved entrance receipt required");
          const source =
            isRecord(route.navigation) &&
            isRecord(route.navigation.evidence) &&
            Array.isArray(route.navigation.evidence.stops)
              ? route.navigation.evidence.stops.find((item) => isRecord(item) && item.route_stop_id === stop.id)
              : null;
          if (!isRecord(source) || !isRecord(source.source) || entrance.approval.status !== "verified_entrance")
            throw unavailable("Sealed navigation receipt required");
          assert.equal(entrance.coordinate_candidate_id, source.source.coordinate_candidate_id);
          assert.equal(
            entrance.approval.receipt.verification_receipt_id,
            source.source.entrance_verification_receipt_id,
          );
          assert.equal(entrance.approval.receipt.verifier_actor_id, source.source.verifier_actor_id);
          assert.equal(entrance.approval.receipt.receipt_digest, source.source.receipt_digest);
          assert.equal(entrance.approval.receipt.verified_at, source.source.verified_at);
          assert.equal(entrance.approval.receipt.evidence_reference, source.source.evidence_reference);
          assert.deepEqual(entrance.approval.receipt.native_navigation_proof, source.source.native_navigation_proof);
          assert.equal(entrance.source.source_evidence_id, source.source.source_evidence_id);
          assert.equal(entrance.source.stable_locator, source.source.stable_locator);
          assert.equal(entrance.rights.rights_receipt_id, source.source.rights_receipt_id);
        }
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
        if (coordinateReview) {
          const negativeResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/tours/detail" && response.ok(),
            { timeout: timeoutMs },
          );
          void negativeResponse.catch(() => {});
          await bounded(
            page.goto(new URL(`/tours/route-editor.html?tour=${encodeURIComponent(unapprovedTour ?? "")}`, base).href, {
              timeout: timeoutMs,
            }),
          );
          const negative: unknown = await bounded((await bounded(negativeResponse)).json());
          if (!isRecord(negative) || !isRecord(negative.data) || !Array.isArray(negative.data.routes))
            throw unavailable("Unapproved Tour detail unavailable");
          const blocked = negative.data.routes.find(isAcceptedRoute);
          if (!blocked || navigationFromEvidence(unapprovedTour ?? "", blocked, blocked.navigation))
            throw unavailable("A recorded accepted route without eligible navigation is required");
          const unapproved = blocked.stops.find((stop) => {
            const review = parseCoordinateReview(Reflect.get(stop, "coordinate_review"), stop.property_id);
            return review && !review.candidates.some((candidate) => candidate.approval.status === "verified_entrance");
          });
          if (!unapproved) throw unavailable("An unknown or unapproved stop is required");
          const panel = page.locator("#coordinate-review");
          await bounded(panel.locator("select[data-coordinate-property]").selectOption(unapproved.property_id));
          const review = parseCoordinateReview(Reflect.get(unapproved, "coordinate_review"), unapproved.property_id);
          assert.ok(review);
          assert.equal(
            await bounded(panel.locator("h3").textContent()),
            review.property_name ?? "Property name unknown",
          );
          if (review.status === "unknown")
            assert.equal(
              await bounded(
                panel
                  .getByText("No observed coordinate candidates. Pin and entrance approval unknown.", { exact: true })
                  .count(),
              ),
              1,
            );
          await bounded(
            page.locator("#accepted-itinerary [data-itinerary-stop]").first().waitFor({ timeout: timeoutMs }),
          );
          assert.equal(await bounded(page.locator("#accepted-itinerary .itinerary-navigation a").count()), 0);
          assert.equal(
            await bounded(page.locator("#accepted-itinerary [data-itinerary-stop]").count()),
            blocked.stops.filter((stop) => stop.stop_state === "active").length,
          );
        }
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
        "coordinate-review": { type: "boolean" },
        "unapproved-tour": { type: "string" },
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
          coordinateReview: values["coordinate-review"] ?? false,
          ...(values["unapproved-tour"] ? { unapprovedTour: values["unapproved-tour"] } : {}),
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
