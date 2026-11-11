import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { chromium as driver } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "../scripts/proof-browser.mjs";
import { proveJourney } from "../scripts/prove-cart-journey.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { parseDealUpdateSummary } from "../src/ui/deal-update-summary-model.ts";

const summaryRecording = JSON.parse(
  await readFile(new URL("../contracts/deal-update-summary.v1/fixture.json", import.meta.url), "utf8"),
);
const responses = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
const recorded = JSON.parse(await readFile(new URL("./fixtures/tour-stop-drag.json", import.meta.url), "utf8"));
const commit = "a".repeat(40);

for (const mode of ["ready", "wrong-order", "deadline"] as const) {
  test(`cart journey proof waits for reopened Tour content (${mode})`, async (t) => {
    const server = await startWorkerFixture({
      assets: await appAssetSnapshot(),
      env: { APP_ENV: "production", GIT_SHA: commit, CARR: { fetch: async () => new Response("synthetic") } },
    });
    t.after(() => server.close());
    const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route(
      (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
      (route) => route.abort(),
    );
    const detail = structuredClone(recorded.detail.data);
    const deal = responses.saved.search.deal_id;
    const tour = detail.id;
    detail.deal_id = deal;
    const accepted = detail.routes[0];
    const propertyIds = accepted.stops.map((stop: { property_id: string }) => stop.property_id);
    const cart = { tour_id: tour, selection_version_id: randomUUID(), selection_version: 1, property_ids: propertyIds };
    const saved = structuredClone(responses.positive.search);
    saved.last_run_at = new Date().toISOString();
    saved.result_property_ids = [propertyIds[0]];
    const payload = { ...responses.reopened, searches: [saved] };
    parseSearchResponse(payload, deal, true);
    const seed = (await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")).replaceAll(
      '"d14"',
      JSON.stringify(deal),
    );
    await page.route("**/data/board-seed.json", (route) =>
      route.fulfill({ body: seed, contentType: "application/json" }),
    );
    await page.route("**/auth/session", (route) =>
      route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" } }),
    );
    await page.route("**/mcp", async (route) => {
      const rpc = route.request().postDataJSON();
      if (rpc.params.name === "read-deal-update-summary-v1") {
        assert.equal(rpc.params.arguments.deal_id, deal);
        const value = { ...structuredClone(summaryRecording), deal_id: deal };
        parseDealUpdateSummary(value, deal);
        return route.fulfill({
          json: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } },
        });
      }
      assert.equal(rpc.params.name, "read-deal-space-searches-v1");
      assert.equal(rpc.params.arguments.deal_id, deal);
      await route.fulfill({
        json: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    });
    let libraries = 0;
    let reloading = false;
    const gate = Promise.withResolvers<void>();
    t.after(() => gate.resolve());
    await page.route("**/api/tours/**", async (route) => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), url.pathname === "/api/tours/properties/search" ? "POST" : "GET");
      let data: unknown;
      if (url.pathname === "/api/tours/library") {
        libraries++;
        if (reloading) await gate.promise;
        if (page.isClosed()) return;
        data = { tours: [{ id: tour, deal_id: deal, name: detail.name, status: "draft" }] };
      } else if (url.pathname === "/api/tours/detail") {
        assert.equal(url.searchParams.get("tour_id"), tour);
        const display = structuredClone(detail);
        if (reloading && route.request().frame() !== page.mainFrame() && mode === "wrong-order") {
          display.routes[0].stops.reverse();
          display.routes[0].stops.forEach((stop: { route_sequence: number }, i: number) => {
            stop.route_sequence = i + 1;
          });
          display.stops = display.routes[0].stops;
        }
        data = display;
      } else if (url.pathname === "/api/tours/selection-cart") data = { cart };
      else if (url.pathname === "/api/tours/properties/search")
        data = {
          search: {
            items: propertyIds.map((property_id: string) => ({
              property_id,
              name: "Synthetic site",
              address: "100 Example Way",
              county: "Escambia",
              state: "FL",
            })),
            has_more: false,
          },
        };
      else return route.fulfill({ status: 404, json: { error: "not_found" } });
      await route.fulfill({ json: { data, csrf_token: "synthetic-csrf" } });
    });
    const reload = page.reload.bind(page);
    t.mock.method(page, "reload", async () => {
      reloading = true;
      const result = await reload();
      assert.equal(
        page.frames().some((frame) => frame.url().includes("/tours/route-editor.html")),
        false,
      );
      if (mode !== "deadline") gate.resolve();
      return result;
    });
    t.mock.method(driver, "connectOverCDP", async () => ({
      contexts: () => [{ newPage: async () => page }],
      close: async () => {},
    }));
    const directory = temporaryDirectory("cart-journey-proof-", t);
    const receiptFile = join(directory, "receipt.json");
    await writeFile(
      receiptFile,
      JSON.stringify({
        source_ref: "synthetic-receipt",
        deal_id: deal,
        tour_id: tour,
        selection_version_id: cart.selection_version_id,
        route_version_id: accepted.id,
        route_version_acceptance_id: randomUUID(),
        selected_property_ids: [propertyIds[0]],
      }),
    );
    const result = await proveJourney({
      origin: server.origin,
      expectedCommit: commit,
      cdpUrl: "http://127.0.0.1:9222",
      dealId: deal,
      searchId: saved.id,
      tourId: tour,
      receiptFile,
      timeoutMs: mode === "deadline" ? 5000 : 30000,
    });
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.exitCode, mode === "ready" ? 0 : mode === "wrong-order" ? 1 : 78);
    if (mode === "deadline") {
      assert.equal(typeof result.error, "string");
      assert.match(result.error || "", /Total proof deadline exceeded/);
    }
    assert.ok(libraries >= 3);
    assert.equal(page.isClosed(), true);
  });
}
