import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { chromium } from "./browser-harness.mjs";

const root = new URL("../", import.meta.url);
const clientId = "11111111-1111-4111-8111-111111111111", tourId = "22222222-2222-4222-8222-222222222222";
const original = "Synthetic call entry: prioritize ground-floor space, accessible entry, patient parking and current delivery condition. Compare the proposed stops with the practice requirements. Confirm current availability and any appointment windows before scheduling. Preserve original notes for review; no appointment has been booked.";
const client = { id: clientId, name: "Demo Harbor Practice", city: "Pensacola", state: "FL", vertical: "Medical office", notes: original };
const tour = { id: tourId, name: "Demo Gulf Coast Tour", status: "draft", stops: [{ property_name: "Demo Bayside Office", property_address: "100 Example Way", stop_state: "active" }], cheat_sheet: { content: { notes: original } } };

async function open(t, width, site = root) {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.clock.install({ time: new Date("2026-10-01T15:00:00Z") });
  const calls = [], errors = []; let unavailable = false, revision = 0, accepted = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); calls.push({ path: url.pathname, method: request.method(), body: request.postData() });
    if (url.origin !== "http://localhost") return route.abort();
    if(url.pathname === "/mcp") {
      const {name}=request.postDataJSON().params; assert.ok(["list-feature-switches","list-doc-suggestions","morning-brief"].includes(name));
      return route.fulfill({json:{result:{content:[{type:"text",text:JSON.stringify({ok:true,suggestions:[]})}]}}});
    }
    if (url.pathname.startsWith("/api/")) {
      if (unavailable && url.pathname === "/api/tours/library") return route.fulfill({ status: 503, body: "{}", contentType: "application/json" });
      let data;
      if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ actor: { slug: "joe" }, csrf_token: "synthetic-session" }) });
      if (url.pathname === "/api/tours/library") data = { tours: Array.from({ length: 10 }, (_, i) => ({ id: i ? `33333333-3333-4333-8333-${String(i).padStart(12,"0")}` : tourId, name: `Demo ${i ? `Tour ${i + 1}` : "Gulf Coast Tour"}`, status: i > 4 ? "completed" : "draft" })) };
      else if (url.pathname === "/api/tours/detail") data = { ...tour, name: revision ? "Demo refreshed tour" : tour.name, ...(accepted ? { routes: [{ accepted: true, stops: [{ id: "stop-a", stop_state: "active", route_sequence: 1 }] }] } : {}) };
      else if (url.pathname === "/api/v1/business/clients") {
        if (url.searchParams.get("scope") !== "team" || url.searchParams.get("sort") !== "name") return route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
        data = { rows: [client], page: 1, page_count: 1 };
      }
      else if (url.pathname === `/api/v1/business/clients/${clientId}`) data = { record: client };
      else data = {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.startsWith("/api/v1/business/") ? data : { data, csrf_token: "synthetic-session" }) });
    }
    const file = url.pathname === "/tours" ? "tours/index.html" : url.pathname.slice(1);
    try {
      const content = await readFile(new URL(file, site));
      return route.fulfill({ body: content, contentType: /\.m?js$/.test(file || "") ? "text/javascript" : file?.endsWith(".css") ? "text/css" : "text/html" });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto("http://localhost/tours"); await page.waitForFunction(() => document.querySelector("#planner-updated").textContent.startsWith("Updated"));
  return { page, calls, errors, outage(value) { unavailable = value; }, revise() { revision += 1; }, accept() { accepted = true; } };
}

for (const width of [390,1440]) test(`cross-deal Tours filters, reads legacy detail and recovers at ${width}px`, async t => {
  const app = await open(t,width), {page} = app;
  assert.equal(await page.locator('#plan-form, #create-tour-form').count(),0);
  await page.locator('.tour-button').first().click();
  await page.locator('#detail-title').filter({hasText:'Demo Gulf Coast Tour'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Open legacy itinerary'}).getAttribute('href'),`/tours/route-editor.html?tour=${tourId}`);
  await page.getByRole('button',{name:'Close tour details'}).click();
  await page.locator('#tour-filter').fill('no matching fixture');
  assert.equal(await page.locator('.tour-button').count(),0);
  await page.locator('#tour-filter').fill('');
  app.outage(true); await page.locator('#planner-refresh').click();
  await page.getByText('Tours unavailable. Refresh to try again.').waitFor();
  app.outage(false); await page.locator('#planner-refresh').click();
  await page.locator('.tour-button').first().waitFor();
  assert.deepEqual(app.errors,[]);
});
