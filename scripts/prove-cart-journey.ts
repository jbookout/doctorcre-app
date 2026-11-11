import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export function compareJourney(search: string[], cart: string[], route: string[], chosen = search) {
  assert.ok(search.length > 0 && chosen.length > 0);
  assert.ok(
    chosen.every((id) => search.includes(id)),
    "Chosen property must be a canonical result",
  );
  assert.ok(
    chosen.every((id) => cart.includes(id)),
    "Chosen search results must belong to saved cart",
  );
  assert.equal(new Set(cart).size, cart.length);
  assert.equal(new Set(route).size, route.length);
  assert.deepEqual([...route].sort(), [...cart].sort(), "Accepted route membership differs from cart");
}
const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
}
function parseTourReads(value: unknown) {
  record(value);
  record(value.detail);
  record(value.cart);
  const detail = value.detail,
    cart = value.cart;
  assert.ok(Array.isArray(detail.routes));
  assert.ok(Array.isArray(cart.property_ids) && cart.property_ids.every((id) => typeof id === "string"));
  const routes = detail.routes.map((route: unknown) => {
    record(route);
    assert.equal(typeof route.id, "string");
    assert.equal(typeof route.accepted, "boolean");
    assert.ok(Array.isArray(route.stops));
    return {
      id: route.id,
      accepted: route.accepted,
      stops: route.stops.map((stop: unknown) => {
        record(stop);
        assert.equal(typeof stop.property_id, "string");
        assert.equal(typeof stop.stop_state, "string");
        assert.ok(
          stop.stop_state === "active" ? typeof stop.route_sequence === "number" : stop.route_sequence === null,
        );
        return {
          property_id: String(stop.property_id),
          stop_state: stop.stop_state,
          route_sequence: Number(stop.route_sequence),
        };
      }),
    };
  });
  return { detail: { ...detail, routes }, cart: { ...cart, property_ids: cart.property_ids.map(String) } };
}
export async function proveJourney(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  dealId?: string | undefined;
  searchId?: string | undefined;
  tourId?: string | undefined;
  receiptFile?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  if (options.fixtureCase)
    return runProof({
      origin: options.origin,
      expectedCommit: options.expectedCommit,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        const fixture = JSON.parse(
          await readFile(new URL("../test/fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
        );
        const search = parseSearchResponse(fixture.positive, fixture.positive.search.deal_id)[0];
        assert.ok(search);
        compareJourney(
          search.result_property_ids,
          search.result_property_ids,
          options.fixtureCase === "pass" ? search.result_property_ids : [],
        );
        return { scope: "synthetic contract-checked membership comparison" };
      },
    });
  return runProof({
    ...options,
    observe: async (page, origin) => {
      if (!options.cdpUrl || !options.dealId || !options.searchId || !options.tourId || !options.receiptFile)
        throw unavailable(
          "Signed-in CDP session, deal, search, Tour and existing authorized save/accept receipt required",
        );
      const receipt = JSON.parse(await readFile(options.receiptFile, "utf8"));
      if (
        !receipt.source_ref ||
        receipt.deal_id !== options.dealId ||
        receipt.tour_id !== options.tourId ||
        !receipt.selection_version_id ||
        !receipt.route_version_id ||
        !receipt.route_version_acceptance_id
      )
        throw unavailable("Persistence receipt does not identify this deal and Tour");
      await page.goto(
        `${origin}/deals?deal=${encodeURIComponent(options.dealId)}&tab=tours&tour=${encodeURIComponent(options.tourId)}`,
      );
      const editor = page.frameLocator('iframe[title="Tour shortlist, route and packet"]');
      const panel = editor.getByRole("region", { name: "Saved space searches", exact: true });
      try {
        await panel.locator(`[data-search-id="${options.searchId}"]`).waitFor();
      } catch {
        throw unavailable("Signed-in saved search unavailable");
      }
      let frame = page.frames().find((f) => f.url().includes("/tours/route-editor.html"));
      if (!frame) throw unavailable("Tour editor unavailable");
      const raw = await frame.evaluate(
        async ({ deal, search, tour }) => {
          const path = "/js/mcp-requests.mjs";
          const { createMcpRequests } = await import(path);
          const result = await createMcpRequests()(
            "read-deal-space-searches-v1",
            { deal_id: deal, search_id: search },
            { timeoutMs: 10000 },
          );
          if (result.kind !== "payload" || result.isError) throw Error("Search read unavailable");
          const privatePath = "/js/private-session.js";
          const { sessionFetch } = await import(privatePath);
          const reads = await Promise.all(
            ["detail", "selection-cart"].map(async (name) => {
              const response = await sessionFetch(`/api/tours/${name}?tour_id=${encodeURIComponent(tour)}`, {
                cache: "no-store",
              });
              if (!response.ok) throw Error("Independent Tour read unavailable");
              return (await response.json()).data;
            }),
          );
          return { search: result.payload, detail: reads[0], cart: reads[1].cart };
        },
        { deal: options.dealId, search: options.searchId, tour: options.tourId },
      );
      const search = parseSearchResponse(raw.search, options.dealId, true).find((s) => s.id === options.searchId);
      if (!search?.last_run_at || Date.now() - Date.parse(search.last_run_at) >= 86400000)
        throw unavailable("Existing results must be fresh for read-only local handoff");
      const parsed = parseTourReads(raw);
      const accepted = parsed.detail.routes.find((r) => r.accepted && r.id === receipt.route_version_id);
      if (
        !accepted ||
        raw.detail.id !== options.tourId ||
        raw.detail.deal_id !== options.dealId ||
        raw.cart.tour_id !== options.tourId ||
        raw.cart.selection_version_id !== receipt.selection_version_id
      )
        throw unavailable("Existing persistence receipt is not current for this deal and Tour");
      if (parsed.detail.routes[0]?.id !== accepted.id)
        throw unavailable("A newer route draft requires review before proving accepted UI parity");
      const routeIds = accepted.stops.map((s) => s.property_id);
      if (
        !Array.isArray(receipt.selected_property_ids) ||
        !receipt.selected_property_ids.every((id: unknown) => typeof id === "string")
      )
        throw unavailable("Persistence receipt must identify the chosen canonical search results");
      const chosen = receipt.selected_property_ids.map(String);
      compareJourney(search.result_property_ids, parsed.cart.property_ids, routeIds, chosen);
      await page.reload();
      frame = page.frames().find((f) => f.url().includes("/tours/route-editor.html"));
      if (!frame) throw unavailable("Reopened Tour frame unavailable");
      await editor.locator("#composer-badge").filter({ hasText: "Accepted" }).waitFor({ state: "attached" });
      await editor.locator("#route-editing > summary").click();
      assert.deepEqual(
        await editor
          .locator("#route-stops > li")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-property-id"))),
        routeIds,
      );
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 1000 });
          await frame.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await panel.locator(`[data-search-id="${options.searchId}"]`).click();
          assert.deepEqual(
            await panel
              .locator("[data-result-property-id]")
              .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-result-property-id"))),
            search.result_property_ids,
          );
          for (const id of chosen)
            await panel.locator(`[data-result-property-id="${id}"]`).getByRole("checkbox").check();
          await panel.getByRole("button", { name: "Add chosen results to Tour cart", exact: true }).click();
          await editor.locator("#selection-state").filter({ hasText: "cart draft" }).waitFor();
          await editor.locator("#undo-selection").click();
          assert.equal(await editor.locator("#selection-list li").count(), raw.cart.property_ids.length);
          assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
        }
      return {
        scope: "read-only saved search/cart/accepted route comparison; local handoff undone",
        persistence_receipt: receipt.source_ref,
      };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      "deal-id": { type: "string" },
      "search-id": { type: "string" },
      "tour-id": { type: "string" },
      "receipt-file": { type: "string" },
      "fixture-case": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const result = await proveJourney({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    dealId: values["deal-id"],
    searchId: values["search-id"],
    tourId: values["tour-id"],
    receiptFile: values["receipt-file"],
    fixtureCase: values["fixture-case"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
