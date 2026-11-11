import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { chromium } from "./browser-harness.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
const deal = fixture.saved.search.deal_id;
const tour = "33333333-3333-4333-8333-333333333333";
const routeId = "55555555-5555-4555-8555-555555555555";
const row = { id: tour, deal_id: deal, name: "Synthetic departure tour", status: "draft" };
parseSearchResponse(fixture.reopened, deal, true);
parseSearchResponse(fixture.positive, deal);

test("saved search departure distinguishes reads, edits and writes", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      for (const scenario of ["pending read leaves", "edited draft blocks", "pending write blocks"] as const) {
        await t.test(`${width} ${theme} ${scenario}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let observed = () => {};
          const held = new Promise<void>((resolve) => {
            observed = resolve;
          });
          try {
            await page.addInitScript(
              (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
              theme,
            );
            await page.route(/^https:\/\//, (route) => route.abort());
            const seed = JSON.parse(
              (await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8")).replaceAll(
                '"d14"',
                JSON.stringify(deal),
              ),
            );
            await page.route("**/data/board-seed.json", (route) => route.fulfill({ json: seed }));
            await page.route("**/auth/session", (route) =>
              route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } }),
            );
            await page.route("**/mcp", async (route) => {
              const rpc = route.request().postDataJSON();
              const reading = rpc.params.name === "read-deal-space-searches-v1";
              assert.ok(reading || rpc.params.name === "run-deal-space-search-v1");
              if (
                (scenario === "pending read leaves" && reading) ||
                (!reading && scenario === "pending write blocks")
              ) {
                observed();
                await gate;
              }
              await route
                .fulfill({
                  json: {
                    jsonrpc: "2.0",
                    id: rpc.id,
                    result: {
                      content: [{ type: "text", text: JSON.stringify(reading ? fixture.reopened : fixture.positive) }],
                    },
                  },
                })
                .catch(() => {});
            });
            await page.route("**/api/tours/**", (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === "/api/tours/library")
                return route.fulfill({ json: { data: { tours: [row] }, csrf_token: "synthetic-session" } });
              if (path === "/api/tours/detail")
                return route.fulfill({
                  json: {
                    data: {
                      ...row,
                      stops: [],
                      routes: [{ id: routeId, route_version: 1, accepted: false, stops: [] }],
                      route_version_id: routeId,
                      route_version_state: "draft",
                      accepted_route_version: 0,
                    },
                    csrf_token: "synthetic-session",
                  },
                });
              return route.fulfill({ status: 404, json: { error: "not_found" } });
            });
            await page.goto(`${server.origin}/deals?deal=${deal}&tab=tours`);
            await page.locator("[data-open-tour]").click();
            const editor = page.frameLocator("iframe");
            await editor.locator("#tour-name").filter({ hasText: row.name }).waitFor();
            const panel = editor.getByRole("region", { name: "Saved space searches", exact: true });
            if (scenario === "pending read leaves") {
              await held;
              await panel.getByText("Loading saved searches…", { exact: true }).waitFor();
            } else {
              await panel.getByRole("button", { name: fixture.saved.search.name, exact: true }).click();
              if (scenario === "edited draft blocks")
                await panel.getByLabel("Search name", { exact: true }).fill("Unsaved departure draft");
              else {
                await panel.getByRole("button", { name: "Rerun saved search", exact: true }).click();
                await held;
                await panel.getByText("Rerunning saved criteria…", { exact: true }).waitFor();
              }
            }
            await page.goBack();
            const dialog = page.getByRole("dialog", { name: "Leave this tour?" });
            if (scenario === "pending read leaves") {
              await Promise.race([dialog.waitFor(), page.locator("[data-open-tour]").waitFor()]);
              assert.equal(await dialog.isVisible(), false, "An unedited pending read must return to the list");
              assert.equal(await page.locator("[data-open-tour]").count(), 1);
              assert.equal(new URL(page.url()).searchParams.has("tour"), false);
            } else {
              await dialog.waitFor();
              await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
              await editor.locator("#tour-name").filter({ hasText: row.name }).waitFor();
              assert.equal(new URL(page.url()).searchParams.get("tour"), tour);
              if (scenario === "edited draft blocks")
                assert.equal(
                  await panel.getByLabel("Search name", { exact: true }).inputValue(),
                  "Unsaved departure draft",
                );
            }
          } finally {
            release();
            await page.close();
          }
        });
      }
    }
});
