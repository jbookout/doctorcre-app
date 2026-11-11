import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { coordinateDetailFixture } from "./fixtures/coordinate-review/detail.ts";

test("coordinate review selects exact property, compares, refuses authority and retires at four viewports", async (t) => {
  const detail = coordinateDetailFixture();
  const second = detail.stops[1];
  assert.ok(second);
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      CARR: {
        fetch: async (request) => {
          const url = new URL(request.url);
          const path = url.pathname;
          return Response.json({
            csrf_token: "synthetic-coordinate",
            actor: { slug: "synthetic-user" },
            data:
              path === "/api/tours/detail"
                ? detail
                : path === "/api/tours/library"
                  ? { tours: [{ id: detail.id, name: detail.name }] }
                  : {},
          });
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S17.J4-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      await page.addInitScript(
        (value) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: value })),
        theme,
      );
      await page.goto(server.origin + "/tours/route-editor.html?tour=" + detail.id);
      const root = page.locator("#coordinate-review");
      await root.locator("h3").waitFor();
      assert.equal(await root.locator("h3").textContent(), "Synthetic Medical 1");
      await root.locator("select[data-coordinate-property]").selectOption(second.property_id);
      assert.equal(await root.locator("h3").textContent(), "Synthetic Medical 2");
      assert.equal(await root.locator("[data-coordinate-candidate]").count(), 3);
      assert.equal(await root.locator("a").count(), 0);
      await root.getByRole("button", { name: "Refresh coordinate evidence" }).click();
      await root.locator("h3").waitFor();
      assert.equal(await root.locator("h3").textContent(), "Synthetic Medical 2");
      await root.screenshot({ path: "/tmp/WR591.S17.J4-shots/" + width + "-" + theme + ".png" });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.route("**/mcp", (route) =>
        route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [
                { type: "text", text: JSON.stringify({ ok: false, error: "tour_human_verification_required" }) },
              ],
            },
          },
        }),
      );
      await root.getByText("Record human entrance verification", { exact: true }).click();
      await root.locator("input[name=verified_at]").fill("2026-11-10T12:00");
      await root.locator("input[name=tested_at]").fill("2026-11-10T12:00");
      await root.locator("input[name=evidence_reference]").fill("https://example.com/site");
      await root.locator("input[name=receipt_digest]").fill("sha256:" + "a".repeat(64));
      await root.locator("input[name=evidence_digest]").fill("sha256:" + "b".repeat(64));
      await root.locator("input[type=checkbox]").check();
      await root.getByRole("button", { name: "Submit human verification" }).click();
      await root.getByRole("status").filter({ hasText: "Entrance review refused." }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
      assert.equal(await root.locator("[data-coordinate-candidate]").count(), 0);
      await page.close();
    }
});
test("coordinate production proof passes exact candidate fields and fails a near miss", async () => {
  const commit = "1".repeat(40),
    detail = coordinateDetailFixture();
  const first = detail.stops[0];
  assert.ok(first);
  const blocked = structuredClone(detail);
  blocked.id = "22222222-2222-4222-8222-222222222222";
  for (const stop of blocked.stops) {
    stop.coordinate_review.candidates = [];
    stop.coordinate_review.status = "unknown";
    stop.coordinate_review.reason = "no_observed_candidates";
  }
  const route = blocked.routes[0];
  assert.ok(route);
  Reflect.set(route, "navigation", {
    contract_version: "tour-navigation-evidence.v1",
    status: "unavailable",
    reason: "promotion_missing",
    evidence: null,
  });
  const assets = await appAssetSnapshot();
  for (const broken of [false, true]) {
    const next = new Map(assets);
    if (broken) {
      const asset = next.get("/js/ui-tour-coordinate-review.js");
      assert.ok(asset);
      next.set("/js/ui-tour-coordinate-review.js", {
        ...asset,
        body: Buffer.from(asset.body.toString().replaceAll("Property name unknown", "Wrong property name")),
      });
      first.coordinate_review.property_name = null;
    }
    const server = await startWorkerFixture({
      assets: next,
      env: {
        APP_ENV: "production",
        GIT_SHA: commit,
        CARR: {
          fetch: async (request) => {
            const url = new URL(request.url);
            const path = url.pathname;
            return Response.json({
              csrf_token: "synthetic-coordinate",
              actor: { slug: "synthetic-user" },
              data:
                path === "/api/tours/detail"
                  ? url.searchParams.get("tour_id") === blocked.id
                    ? blocked
                    : detail
                  : path === "/api/tours/library"
                    ? { tours: [{ id: detail.id, name: detail.name }] }
                    : {},
            });
          },
        },
      },
    });
    try {
      const call = promisify(execFile)(
        process.execPath,
        [
          "scripts/prove-tour-navigation.ts",
          "--fixture",
          "--coordinate-review",
          "--unapproved-tour",
          blocked.id,
          "--origin",
          server.origin,
          "--commit",
          commit,
          "--tour",
          detail.id,
        ],
        { timeout: 60000 },
      );
      if (broken) await assert.rejects(call, (e) => e instanceof Error && "code" in e && e.code === 1);
      else assert.equal(JSON.parse((await call).stdout).status, "passed");
    } finally {
      await server.close();
    }
  }
});
