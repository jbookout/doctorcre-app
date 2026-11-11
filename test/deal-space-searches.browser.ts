import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import { chromium } from "./browser-harness.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
test("saved search panel save, reopen, rerun, rollback, conflict, archive, restore and cart at four viewports", async (t) => {
  for (const [key, value] of Object.entries(fixture))
    parseSearchResponse(value, fixture.saved.search.deal_id, key === "reopened");
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S18.J3-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.route("**/search-panel-fixture", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/tours/app.css"><main style="padding:16px;max-width:1100px;margin:auto" id="view"></main>',
          }),
        );
        await page.goto(`${server.origin}/search-panel-fixture`);
        await page.clock.install({ time: new Date(fixture.positive.search.last_run_at) });
        await page.evaluate(
          async ({ fixture, theme }) => {
            document.documentElement.dataset.theme = theme;
            const { mountSavedSearches } = await import("/js/ui-deal-space-searches.js");
            const element = document.querySelector("#view");
            if (!element) throw Error("No host");
            let current = structuredClone(fixture.saved.search);
            let failure = false,
              conflict = false;
            const calls: unknown[] = [];
            const cart: string[] = [];
            const panel = mountSavedSearches(element, {
              dealId: current.deal_id,
              call: async (verb, args) => {
                calls.push({ verb, args });
                if (verb === "read-deal-space-searches-v1") return { ...fixture.reopened, searches: [current] };
                if (verb === "run-deal-space-search-v1") {
                  if (failure) {
                    failure = false;
                    throw Error("offline");
                  }
                  current = structuredClone(fixture.positive.search);
                  return { ...fixture.positive, search: current };
                }
                if (conflict) {
                  conflict = false;
                  current = { ...current, version: current.version + 1, requirements: "Newer saved requirement" };
                  throw Error("space_search_version_conflict");
                }
                current = {
                  ...current,
                  id: args.search_id,
                  name: args.name,
                  requirements: args.requirements,
                  criteria: args.criteria,
                  status: args.status,
                  state: args.status === "archived" ? "archived" : "saved",
                  version: current.version + 1,
                };
                return { ...fixture.saved, search: current };
              },
              describe: () => "Medical Plaza · 100 Clinic Way",
              hydrate: async () => {},
              handoff: (ids) => {
                cart.push(...ids);
                return true;
              },
            });
            Reflect.set(window, "searchFixture", {
              panel,
              calls,
              cart,
              fail: () => {
                failure = true;
              },
              conflict: () => {
                conflict = true;
              },
            });
          },
          { fixture, theme },
        );
        const panel = page.getByRole("region", { name: "Saved space searches" });
        await panel.getByRole("button", { name: "Medical space", exact: true }).click();
        assert.equal(
          await panel.getByLabel("Budget, timing and other requirements").inputValue(),
          fixture.saved.search.requirements,
        );
        await panel.getByLabel("Search name", { exact: true }).fill("Clinic shortlist");
        await panel.getByRole("button", { name: "Save search", exact: true }).click();
        await panel.getByText("Search saved.", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
        await panel.getByRole("button", { name: "Reload saved searches", exact: true }).click();
        await panel.getByRole("button", { name: "Clinic shortlist", exact: true }).click();
        assert.equal(await panel.getByLabel("Search name", { exact: true }).inputValue(), "Clinic shortlist");
        await panel.getByRole("button", { name: "Rerun saved search", exact: true }).click();
        await panel.getByRole("checkbox").check();
        await page.screenshot({ path: `/tmp/WR591.S18.J3-shots/${width}-${theme}.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await panel.getByRole("button", { name: "Add chosen results to Tour cart", exact: true }).click();
        assert.deepEqual(
          await page.evaluate(() => Reflect.get(window, "searchFixture").cart),
          fixture.positive.search.result_property_ids,
        );
        await page.evaluate(() => Reflect.get(window, "searchFixture").fail());
        await panel.getByRole("button", { name: "Rerun saved search", exact: true }).click();
        await panel
          .getByText("Run failed or unconfirmed. Previous results remain. Retry uses the same request.", {
            exact: true,
          })
          .waitFor();
        assert.equal(await panel.getByRole("checkbox").count(), 1);
        await panel.getByRole("button", { name: "Rerun saved search", exact: true }).click();
        await panel
          .getByText("Results saved. Review candidates before adding them to a Tour.", { exact: true })
          .waitFor();
        await page.evaluate(() => Reflect.get(window, "searchFixture").conflict());
        await panel.getByLabel("Budget, timing and other requirements").fill("My retained draft");
        await panel.getByRole("button", { name: "Save search", exact: true }).click();
        await panel
          .getByRole("region", { name: "Newer saved search" })
          .getByText("Newer saved requirement", { exact: true })
          .waitFor();
        assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), "My retained draft");
        await panel.getByRole("button", { name: "Save search", exact: true }).click();
        await panel.getByText("Search saved.", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Archive search", exact: true }).click();
        await panel.getByRole("button", { name: "Restore search", exact: true }).click();
        await panel.getByText("Search restored.", { exact: true }).waitFor();
        await page.evaluate(() => Reflect.get(window, "searchFixture").panel.retire());
        assert.equal(await panel.getByRole("button", { name: "New space search", exact: true }).isDisabled(), true);
      } finally {
        await page.close();
      }
    }
});
