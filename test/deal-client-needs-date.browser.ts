import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseNeed } from "../src/ui/deal-client-needs-model.ts";
import { chromium } from "./browser-harness.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/client-needs/authoring.json", import.meta.url), "utf8"));
Object.assign(recorded, {client_name: 'Gulf Coast Pediatric Partners', deal_name: 'Fairhope clinic relocation', vendor_ref: 'Bayshore Medical Buildout', description: 'Price a 4,200 SF pediatric clinic buildout with six exam rooms and an accessible imaging suite.', applicability: 'Tenant improvement estimate for Fairhope relocation. Client needs a preliminary budget before LOI approval.', source_ref: 'Client discovery call with Dr. Morgan, November 10', source_revision: 'Call transcript revision 3', observed_at: '2026-11-10T16:00:00Z', fresh_until: '2026-12-10T16:00:00Z'});
const fixture = parseNeed(recorded, { deal: recorded.deal_id, client: recorded.client_id });
test("author list, create, edit, exact review, cancel and withdraw at four sizes", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S27.J21-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.route("**/need-fixture", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"><main style="max-width:700px;margin:auto;padding:16px" id="host"></main></html>',
          }),
        );
        await page.goto(server.origin + "/need-fixture");
        await page.evaluate(
          async ({ fixture, theme }) => {
            document.documentElement.dataset.theme = theme;
            const modulePath = "/js/ui-deal-client-needs.js";
            const { mountDealClientNeeds } = await import(modulePath);
            let current = fixture;
            const calls: unknown[] = [];
            const host = document.querySelector("#host");
            if (!host) throw Error("host");
            const view = mountDealClientNeeds(host, {
              deal: fixture.deal_id,
              client: fixture.client_id,
              call: async (verb: string, args: Record<string, unknown>) => {
                calls.push({ verb, args });
                if (verb.startsWith("read"))
                  return {
                    schema_version: "client-needs.v1",
                    subject: "deal",
                    subject_id: fixture.deal_id,
                    as_of: new Date().toISOString(),
                    state: "ready",
                    rows: [current],
                    next_offset: null,
                  };
                if (verb.startsWith("approve"))
                  current = {
                    ...current,
                    version: current.version + 1,
                    state: "approved",
                    approved_revision: current.revision,
                    approved_by: fixture.client_id,
                    approved_at: "2026-11-11T00:00:00Z",
                  };
                else {
                  const f = args.fields;
                  if (!f || typeof f !== "object" || !("vendor" in f) || !("withdrawn" in f))
                    throw Error("Missing fields");
                  current = {
                    ...current,
                    ...f,
                    vendor_id: String(f.vendor),
                    version: current.version + 1,
                    revision: current.revision + 1,
                    state: f.withdrawn ? "withdrawn" : "edited_lapsed",
                    approved_revision: null,
                  };
                }
                return { schema_version: "client-needs.v1", need: current };
              },
            });
            Reflect.set(window, "needCalls", calls);
            Reflect.set(window, "needView", view);
          },
          { fixture, theme },
        );
        await page.screenshot({path: `/tmp/WR591.S27.J21-shots/${width}-${theme}-list.png`, fullPage: true});
        await page.getByRole("button", { name: "Review for approval" }).click();
        await page.getByRole("button", { name: "Cancel review" }).click();
        assert.equal(await page.evaluate(() => Reflect.get(window, "needCalls").length), 1);
        await page.getByRole("button", { name: "Review for approval" }).click();
        await page.getByRole("region", { name: "Review need revision" }).waitFor();
        await page.screenshot({ path: `/tmp/WR591.S27.J21-shots/${width}-${theme}-review.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.getByRole("button", { name: "Approve this revision" }).click();
        await page.getByText(/^Approved ·/).waitFor();
        await page.getByRole("button", { name: "Edit need" }).click();
        await page.getByLabel("Need description").fill("Add acoustic treatment to the six exam rooms and price a separate imaging allowance.");
        await page.getByRole("button", { name: "Save need" }).click();
        await page.getByText(/^Approval lapsed ·/).waitFor();
        await page.getByRole("button", { name: "Withdraw need" }).click();
        await page.getByText(/^Withdrawn ·/).waitFor();
        await page.getByRole("button", { name: "Record client need", exact: true }).click();
        for (const [label, value] of Object.entries({
          "Vendor ID": fixture.vendor_id,
          "Need description": "Obtain a preliminary medical buildout estimate before the client signs the LOI.",
          Applicability: fixture.applicability,
          "Source identity": fixture.source_ref,
          "Source revision": fixture.source_revision,
          "Observed at (ISO date and time)": fixture.observed_at,
          "Fresh until (ISO date and time)": fixture.fresh_until,
        }))
          await page.getByLabel(label, { exact: true }).fill(value);
        await page.screenshot({ path: `/tmp/WR591.S27.J21-shots/${width}-${theme}-edit.png`, fullPage: true });
        const observed = page.getByLabel("Observed at (ISO date and time)", {exact:true});
        await observed.fill("2099-01-01T00:00:00Z");
        await page.getByRole("button", { name: "Save need" }).click();
        await observed.fill(fixture.observed_at);
        await page.getByRole("button", { name: "Save need" }).click();
        const stuck = await page.getByLabel("Fresh until (ISO date and time)", {exact:true}).evaluate((e: HTMLInputElement) => ({valid:e.validity.valid,message:e.validationMessage}));
        console.log(JSON.stringify({width,theme,correctedObservationStillBlocked:stuck}));
        assert.equal(stuck.valid,true,'Correcting the observed date must allow the valid form to submit');
        await page.getByText("Obtain a preliminary medical buildout estimate before the client signs the LOI.", { exact: true }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        await page.getByText("Session ended. Sign in again.", { exact: true }).waitFor();
      } finally {
        await page.close();
      }
    }
});

