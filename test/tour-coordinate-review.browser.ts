import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import type { Route } from "playwright";
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
      await root.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: "/tmp/WR591.S17.J4-shots/" + width + "-" + theme + ".png" });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const first = detail.stops[0];
      assert.ok(first);
      let capture: (route: Route) => void = () => {};
      const intercepted = new Promise<Route>((resolve) => {
        capture = resolve;
      });
      await page.route("**/api/tours/detail?**", (route) => capture(route));
      await root.getByRole("button", { name: "Refresh coordinate evidence" }).click();
      const held = await intercepted;
      await root.locator("select[data-coordinate-property]").selectOption(first.property_id);
      await held.fulfill({ json: { data: detail } });
      await page.unroute("**/api/tours/detail?**");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(await root.locator("h3").textContent(), "Synthetic Medical 1");
      await root.locator("select[data-coordinate-property]").selectOption(second.property_id);
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
      await root.locator("select[data-coordinate-property]").selectOption(first.property_id);
      assert.equal(await root.locator("h3").textContent(), "Synthetic Medical 1");
      await root.locator("select[data-coordinate-property]").selectOption(second.property_id);
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

for (const newlyApproved of [false, true]) {
  test(`coordinate refresh ${newlyApproved ? "approval" : "rights revocation"} survives property selection and older reads`, async (t) => {
    const detail = coordinateDetailFixture();
    const first = detail.stops[0],
      second = detail.stops[1];
    assert.ok(first && second);
    const initial = second.coordinate_review;
    initial.as_of = "2026-11-11T07:26:13.026100-06:00";
    const approved = structuredClone(initial);
    if (newlyApproved) {
      for (const candidate of initial.candidates) {
        if (candidate.approval.status === "verified_entrance")
          candidate.approval = { status: "unverified", receipt: null };
      }
    }
    const updated = structuredClone(approved);
    updated.as_of = "2026-11-11T07:26:13.026900-06:00";
    updated.property_name = "Corrected Specialty Center";
    if (!newlyApproved) {
      for (const candidate of updated.candidates) {
        candidate.rights.status = "unavailable";
        candidate.position = null;
        candidate.access_notes = null;
        candidate.source.stable_locator = null;
        candidate.approval = { status: "rights_unavailable", receipt: null };
      }
    }
    let reply = detail;
    const server = await startWorkerFixture({
      assets: await appAssetSnapshot(),
      env: {
        CARR: {
          fetch: async (request) =>
            Response.json({
              csrf_token: "synthetic",
              actor: { slug: "synthetic-user" },
              data:
                new URL(request.url).pathname === "/api/tours/detail"
                  ? reply
                  : new URL(request.url).pathname === "/api/tours/library"
                    ? { tours: [{ id: detail.id, name: detail.name }] }
                    : {},
            }),
        },
      },
    });
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(server.origin + "/tours/route-editor.html?tour=" + detail.id);
    const root = page.locator("#coordinate-review");
    await root.locator("h3").waitFor();
    const select = root.locator("select[data-coordinate-property]");
    await select.selectOption(second.property_id);
    reply = structuredClone(detail);
    const refreshed = reply.stops[1];
    assert.ok(refreshed);
    refreshed.coordinate_review = updated;
    await root.getByRole("button", { name: "Refresh coordinate evidence" }).click();
    await root.locator("h3").filter({ hasText: updated.property_name }).waitFor();
    const assertFresh = async () => {
      assert.equal(await root.locator("h3").textContent(), updated.property_name);
      assert.equal(await select.locator("option:checked").textContent(), updated.property_name);
      assert.equal(await root.locator("small").textContent(), `Evidence as of ${updated.as_of}`);
      assert.equal(
        await root
          .getByText("Human entrance approved. Route promotion is checked separately.", { exact: true })
          .count(),
        newlyApproved ? 1 : 0,
      );
      if (!newlyApproved) assert.equal(await root.locator('[data-coordinate-field="position.latitude"]').count(), 0);
    };
    await assertFresh();
    await select.selectOption(first.property_id);
    await select.selectOption(second.property_id);
    await assertFresh();
    reply = detail;
    await root.getByRole("button", { name: "Refresh coordinate evidence" }).click();
    await root.getByRole("status").filter({ hasText: "Coordinate evidence is unavailable." }).waitFor();
    await select.selectOption(first.property_id);
    await select.selectOption(second.property_id);
    await assertFresh();
    reply = structuredClone(detail);
    await page.route("**/api/tours/detail?**", (route) => route.abort());
    await root.getByRole("button", { name: "Refresh coordinate evidence" }).click();
    await root.getByRole("status").filter({ hasText: "Coordinate evidence is unavailable." }).waitFor();
    await select.selectOption(first.property_id);
    await select.selectOption(second.property_id);
    await assertFresh();
  });
}
