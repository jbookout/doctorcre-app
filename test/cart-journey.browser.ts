import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { chromium } from "./browser-harness.mjs";

const responses = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
const recorded = JSON.parse(await readFile(new URL("./fixtures/tour-stop-drag.json", import.meta.url), "utf8"));
const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
const deal = responses.saved.search.deal_id;
const candidate = responses.positive.search.result_property_ids[0];
const tour = recorded.detail.data.id;
const existing = recorded.detail.data.stops[0].property_id;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

test("saved search to saved cart to reviewed route preserves identities and explicit acceptance", async (t) => {
  parseSearchResponse(responses.reopened, deal, true);
  parseSearchResponse(responses.positive, deal);
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S20.J3-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await t.test(`${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        page.setDefaultTimeout(5000);
        try {
          const detail = structuredClone(recorded.detail.data);
          detail.deal_id = deal;
          detail.routes[0].accepted = false;
          detail.routes[0].stops = [];
          detail.stops = [];
          detail.route_version_state = "draft";
          detail.accepted_route_version = 0;
          let cart = {
            tour_id: tour,
            selection_version_id: randomUUID(),
            selection_version: 1,
            property_ids: [existing],
          };
          const writes: { path: string; body: Record<string, unknown> }[] = [];
          const replay = new Map<string, unknown>();
          let saveAttempt = 0;
          let savedSearch = structuredClone(responses.saved.search);
          const route = detail.routes[0];
          const seed = JSON.parse(
            (await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")).replaceAll(
              '"d14"',
              JSON.stringify(deal),
            ),
          );
          await page.addInitScript(
            (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
            theme,
          );
          await page.route(/^https:\/\//, (route) => route.abort());
          await page.route("**/data/board-seed.json", (route) => route.fulfill({ json: seed }));
          await page.route("**/auth/session", (route) =>
            route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" } }),
          );
          await page.route("**/mcp", async (request) => {
            const rpc = request.request().postDataJSON();
            assert.equal(rpc.params.arguments.deal_id, deal);
            const reading = rpc.params.name === "read-deal-space-searches-v1";
            assert.ok(reading || rpc.params.name === "run-deal-space-search-v1");
            const payload = structuredClone(reading ? responses.reopened : responses.positive);
            if (!reading) {
              payload.search.last_run_at = new Date().toISOString();
              savedSearch = structuredClone(payload.search);
            } else payload.searches = [savedSearch];
            parseSearchResponse(payload, deal, reading);
            await request.fulfill({
              json: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
              },
            });
          });
          await page.route("**/api/tours/**", async (request) => {
            const path = new URL(request.request().url()).pathname;
            const body = request.request().method() === "POST" ? request.request().postDataJSON() : null;
            let data: unknown;
            if (path === "/api/tours/library")
              data = { tours: [{ id: tour, deal_id: deal, name: detail.name, status: "draft" }] };
            else if (path === "/api/tours/detail") {
              route.acceptance_digest = digest(route.stops);
              detail.stops = structuredClone(route.stops);
              data = detail;
            } else if (path === "/api/tours/selection-cart") {
              if (body) {
                writes.push({ path, body });
                saveAttempt++;
                if (saveAttempt === 1) {
                  cart = { ...cart, selection_version: 2, selection_version_id: randomUUID() };
                  return request.fulfill({ status: 409, json: { error: "conflict" } });
                }
                if (!replay.has(body.idempotency_key)) {
                  assert.equal(body.expected_selection_version, cart.selection_version);
                  assert.equal(body.selection_digest, digest(body.property_ids));
                  cart = {
                    ...cart,
                    selection_version: cart.selection_version + 1,
                    selection_version_id: randomUUID(),
                    property_ids: body.property_ids,
                  };
                  replay.set(body.idempotency_key, { selection_version_id: cart.selection_version_id });
                }
              }
              if (body && saveAttempt === 2) return request.abort("failed");
              data = body ? replay.get(body.idempotency_key) : { cart };
            } else if (path === "/api/tours/properties/search")
              data = {
                search: {
                  items: [existing, candidate].map((property_id, i) => ({
                    property_id,
                    name: `Synthetic site ${i + 1}`,
                    address: `${100 + i} Example Way`,
                    county: "Escambia",
                    state: "FL",
                  })),
                  has_more: false,
                },
              };
            else if (body && contract.writes[path]) {
              writes.push({ path, body });
              assert.deepEqual(Object.keys(body).sort(), [...contract.writes[path].fields].sort());
              if (path === "/api/tours/route-stop") {
                const stop = {
                  ...body,
                  id: randomUUID(),
                  name: body.property_id === existing ? "Synthetic site 1" : "Synthetic site 2",
                };
                route.stops.push(stop);
                data = { route_stop_id: stop.id };
              } else if (path === "/api/tours/route-stop-transition") data = { route_stop_transition_id: randomUUID() };
              else if (path === "/api/tours/route-accept") {
                assert.equal(body.acceptance_digest, digest(route.stops));
                route.accepted = true;
                detail.route_version_state = "accepted";
                detail.accepted_route_version = 1;
                data = { route_version_acceptance_id: randomUUID() };
              } else throw Error(`Unexpected write ${path}`);
            } else return request.fulfill({ status: 404, json: { error: "not_found" } });
            await request.fulfill({ json: { data, csrf_token: "synthetic-csrf" } });
          });
          await page.goto(`${server.origin}/deals?deal=${deal}&tab=tours`);
          await page.locator("[data-open-tour]").click();
          const editor = page.frameLocator("iframe");
          await editor.locator("#tour-name").filter({ hasText: detail.name }).waitFor();
          const panel = editor.getByRole("region", { name: "Saved space searches", exact: true });
          await panel.getByRole("button", { name: responses.saved.search.name, exact: true }).click();
          await panel.getByRole("button", { name: "Rerun saved search", exact: true }).click();
          await panel.getByRole("checkbox").check();
          await panel.getByRole("button", { name: "Add chosen results to Tour cart", exact: true }).click();
          await editor.locator("#selection-state").filter({ hasText: "cart draft" }).waitFor();
          assert.equal(writes.length, 0);
          assert.equal(await editor.locator("#selection-list li").count(), 2);
          await editor.locator("#undo-selection").click();
          assert.equal(await editor.locator("#selection-list li").count(), 1);
          await panel.getByRole("button", { name: "Add chosen results to Tour cart", exact: true }).click();
          await editor.locator("#save-selection").click();
          await editor.locator("#selection-state").filter({ hasText: "Saved version changed" }).waitFor();
          await editor.locator("#save-selection").click();
          await editor.locator("#selection-state").filter({ hasText: "same save request" }).waitFor();
          await editor.locator("#save-selection").click();
          const cartWrites = writes.filter((w) => w.path === "/api/tours/selection-cart");
          assert.equal(cartWrites.length, 3);
          assert.notEqual(cartWrites[0]?.body.idempotency_key, cartWrites[1]?.body.idempotency_key);
          assert.deepEqual(cartWrites[1]?.body, cartWrites[2]?.body);
          await editor.locator("#selection-state").filter({ hasText: "saved with this Tour" }).waitFor();
          assert.deepEqual(cart.property_ids, [existing, candidate]);
          await editor.locator("#add-cart-stops").click();
          assert.equal(await editor.locator("#accept-route").isDisabled(), true);
          await editor.locator("#save-composer").click();
          await editor.locator("#composer-state").filter({ hasText: "Draft saved" }).waitFor();
          assert.equal(writes.filter((w) => w.path === "/api/tours/route-accept").length, 0);
          await editor.locator("#route-reviewed").check();
          await editor.locator("#accept-route").click();
          await editor.locator("#composer-badge").filter({ hasText: "Accepted" }).waitFor({ state: "attached" });
          assert.deepEqual(
            route.stops.map((s: { property_id: string }) => s.property_id),
            cart.property_ids,
          );
          assert.deepEqual(
            route.stops.map((s: { route_sequence: number }) => s.route_sequence),
            [1, 2],
          );
          await page.goBack();
          await page.locator("[data-open-tour]").waitFor();
          await page.locator("[data-open-tour]").click();
          await editor.locator("#composer-badge").filter({ hasText: "Accepted" }).waitFor({ state: "attached" });
          assert.equal(await editor.locator("#selection-list li").count(), 2);
          await editor.locator("#route-editing > summary").click();
          assert.deepEqual(
            await editor
              .locator("#route-stops > li")
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-property-id"))),
            cart.property_ids,
          );
          await panel.getByRole("button", { name: responses.saved.search.name, exact: true }).click();
          assert.deepEqual(
            await panel
              .locator("[data-result-property-id]")
              .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-result-property-id"))),
            responses.positive.search.result_property_ids,
          );
          await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
          await page.screenshot({ path: `/tmp/WR591.S20.J3-shots/${width}-${theme}.png`, fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        } catch (error) {
          await page.screenshot({ path: `/tmp/WR591.S20.J3-shots/failure-${width}-${theme}.png`, fullPage: true });
          throw error;
        } finally {
          await page.close();
        }
      });
    }
});
