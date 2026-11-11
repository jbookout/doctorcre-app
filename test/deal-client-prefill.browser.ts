import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
const client = "22222222-2222-4222-8222-222222222222";
const record = {
  id: client,
  name: "Synthetic Clinic",
  city: "Pensacola",
  state: "FL",
  vertical: "Dermatology",
  notes: "Need space next spring. Budget undecided.",
};
test("review, clear, refresh, keep, save and reopen preserve client provenance at four viewports", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S19.J1-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.route("**/client-prefill-fixture", (r) =>
          r.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/tours/app.css"><main style="padding:16px;max-width:1100px;margin:auto" id="view"></main>',
          }),
        );
        await page.route(`**/api/v1/business/clients/${client}`, (r) => r.fulfill({ json: { record } }));
        await page.goto(`${server.origin}/client-prefill-fixture`);
        await page.evaluate(
          async ({ fixture, client, theme }) => {
            document.documentElement.dataset.theme = theme;
            const { mountSavedSearches } = await import("/js/ui-deal-space-searches.js");
            let saved = structuredClone(fixture.saved.search);
            const host = document.querySelector("#view");
            if (!host) throw Error("No host");
            const panel = mountSavedSearches(host, {
              dealId: saved.deal_id,
              describe: () => null,
              hydrate: async () => {},
              handoff: () => false,
              call: async (verb, args) => {
                if (verb === "get-deal-room") return { deal_id: saved.deal_id, client_id: client };
                if (verb === "read-deal-space-searches-v1") return { ...fixture.reopened, searches: [saved] };
                saved = {
                  ...saved,
                  id: args.search_id,
                  name: args.name,
                  requirements: args.requirements,
                  criteria: args.criteria,
                  client_prefill_source: args.client_prefill_source,
                };
                return { ...fixture.saved, search: saved };
              },
            });
            Reflect.set(window, "panel", panel);
          },
          { fixture, client, theme },
        );
        const panel = page.getByRole("region", { name: "Saved space searches" });
        await panel.getByRole("button", { name: "New space search", exact: true }).click();
        await panel.getByRole("button", { name: "Review or refresh client context", exact: true }).click();
        await panel.getByText(`Client ${client}`, { exact: true }).waitFor();
        assert.equal(await panel.getByLabel("Search name", { exact: true }).inputValue(), "");
        await panel.getByLabel("Use client name", { exact: true }).check();
        await panel.getByLabel("Use client requirements", { exact: true }).check();
        await panel.getByRole("button", { name: "Apply reviewed choices", exact: true }).click();
        await panel.getByText("Reviewed choices applied to this draft.", { exact: true }).waitFor();
        assert.equal(
          await panel.getByLabel("Search name", { exact: true }).inputValue(),
          "Synthetic Clinic space search",
        );
        assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), record.notes);
        await panel.getByLabel("Search name", { exact: true }).fill("My retained search");
        await panel.getByLabel("Budget, timing and other requirements").fill("");
        await panel.getByRole("button", { name: "Review or refresh client context", exact: true }).click();
        await panel.getByText(`Client ${client}`, { exact: true }).waitFor();
        await page.screenshot({ path: `/tmp/WR591.S19.J1-shots/${width}-${theme}.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await panel.getByLabel("Keep my name", { exact: true }).check();
        await panel.getByLabel("Keep my requirements", { exact: true }).check();
        await panel.getByRole("button", { name: "Apply reviewed choices", exact: true }).click();
        await panel.getByText("Reviewed choices applied to this draft.", { exact: true }).waitFor();
        assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), "");
        await panel.getByRole("button", { name: "Save search", exact: true }).click();
        await panel.getByText("Search saved.", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Cancel search", exact: true }).click();
        await panel.getByRole("button", { name: "My retained search", exact: true }).click();
        assert.equal(await panel.getByLabel("Budget, timing and other requirements").inputValue(), "");
        assert.equal(await panel.getByText(`Client ${client}`, { exact: true }).count(), 0);
        assert.equal(await panel.getByText(new RegExp(`Client prefill source.*${client}`)).count(), 1);
        await page.evaluate(() => Reflect.get(window, "panel").retire());
      } finally {
        await page.close();
      }
    }
});
