import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const clientId = "11111111-1111-4111-8111-111111111111", tourId = "22222222-2222-4222-8222-222222222222";
const original = "Synthetic call entry: prioritize ground-floor space, accessible entry, patient parking and current delivery condition. Compare the proposed stops with the practice requirements. Confirm current availability and any appointment windows before scheduling. Preserve original notes for review; no appointment has been booked.";
const client = { id: clientId, name: "Demo Harbor Practice", city: "Pensacola", state: "FL", vertical: "Medical office", notes: original };
const tour = { id: tourId, name: "Demo Gulf Coast Tour", status: "draft", stops: [{ property_name: "Demo Bayside Office", property_address: "100 Example Way", stop_state: "active" }], cheat_sheet: { content: { notes: original } } };

async function open(t, width) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(6000);
  await page.clock.install({ time: new Date("2026-10-01T15:00:00Z") });
  const calls = [], errors = []; let unavailable = false, revision = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); calls.push({ path: url.pathname, method: request.method(), body: request.postData() });
    if (url.origin !== "http://localhost") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      if (unavailable && url.pathname === "/api/tours/library") return route.fulfill({ status: 503, body: "{}", contentType: "application/json" });
      let data;
      if (url.pathname === "/api/system-work/session") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ actor: { slug: "joe" }, csrf_token: "synthetic-session" }) });
      if (url.pathname === "/api/tours/library") data = { tours: Array.from({ length: 10 }, (_, i) => ({ id: i ? `33333333-3333-4333-8333-${String(i).padStart(12,"0")}` : tourId, name: `Demo ${i ? `Tour ${i + 1}` : "Gulf Coast Tour"}`, status: i > 4 ? "completed" : "draft" })) };
      else if (url.pathname === "/api/tours/detail") data = { ...tour, name: revision ? "Demo refreshed tour" : tour.name };
      else if (url.pathname === "/api/v1/business/clients") {
        if (url.searchParams.get("scope") !== "team" || url.searchParams.get("sort") !== "name") return route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
        data = { rows: [client], page: 1, page_count: 1 };
      }
      else if (url.pathname === `/api/v1/business/clients/${clientId}`) data = { record: client };
      else data = {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data, csrf_token: "synthetic-session" }) });
    }
    const file = url.pathname === "/tours" ? "tours/index.html" : url.pathname.slice(1);
    try {
      const content = await readFile(new URL(file, root));
      return route.fulfill({ body: content, contentType: /\.m?js$/.test(file || "") ? "text/javascript" : file?.endsWith(".css") ? "text/css" : "text/html" });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto("http://localhost/tours"); await page.waitForFunction(() => document.querySelector("#plan-client").options.length === 2);
  return { page, calls, errors, outage(value) { unavailable = value; }, revise() { revision += 1; } };
}

test("W6 desktop and phone render, client prefill/undo, private files, wide popup and measured reduced motion", async t => {
  await mkdir(new URL("test-artifacts/w6/", root), { recursive: true });
  for (const width of [1440, 390]) await t.test(String(width), async t => {
    const app = await open(t, width), { page } = app; const name = width === 1440 ? "desktop" : "phone";
    await page.locator("#plan-client").selectOption(clientId);
    await page.waitForFunction(() => document.querySelector("#plan-name").value.includes("Demo Harbor"));
    await page.locator("#plan-area").fill("Typed tour area"); await page.getByLabel("Undo tour edit", { exact: true }).click();
    assert.equal(await page.locator("#plan-area").inputValue(), "Pensacola, FL");
    await page.locator("#plan-date").fill("2026-10-08"); await page.locator("#plan-dwell").fill("25");
    await page.locator("#packet-upload").setInputFiles({ name: "demo-report.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic private report bytes") });
    assert.match(await page.locator("#packet-files").textContent(), /demo-report/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("doctorcre-tour-planning-drafts-v1").includes("demo-report")), false);
    await page.locator('[data-market="Pensacola, FL"]').click(); assert.equal(await page.locator("#space-area").inputValue(), "Pensacola, FL");
    await page.locator("#space-minSize").fill("1800"); await page.locator("#space-maxSize").fill("3000");
    await page.locator("#space-requirements").fill("Ground floor · accessible entry");
    await page.locator("#save-search").click(); assert.match(await page.locator("#space-message").textContent(), /saved/);
    assert.equal(await page.locator("#property-search-form").count(), 0);
    assert.ok(await page.locator(".territory-map").evaluate(el => el.getAnimations({ subtree: true }).length > 0));
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: new URL(`test-artifacts/w6/${name}.png`, root).pathname, fullPage: true, animations: "disabled" });
    await page.locator("#review-packet").click(); await page.locator("#tour-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#detail-content").textContent(), /demo-report/);
    const box = await page.locator("#tour-dialog").boundingBox(); assert.ok(box.width >= Math.min(1000, width - 32));
    await page.getByLabel("Close tour details").click(); assert.equal(await page.locator("#review-packet").evaluate(el => document.activeElement === el), true);
    if (width < 761) await page.locator("#appSidebarToggle").click();
    await page.locator("#upcoming-tours .tour-button").first().click(); await page.waitForFunction(() => document.querySelector("#detail-title").textContent.includes("Demo Gulf"));
    assert.ok((await page.locator("#detail-content > p").first().textContent()).length <= 180);
    await page.locator("#detail-content details summary").click(); assert.equal(await page.locator("#detail-content details p").textContent(), original);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: new URL(`test-artifacts/w6/${name}-detail.png`, root).pathname, fullPage: false, animations: "disabled" });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#tour-dialog").evaluate(n => n.open), false);
    if (width < 761 && await page.locator("#appSidebarToggle").getAttribute("aria-expanded") === "true") await page.locator('#appSidebar [data-layout-close="sidebar"]').click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".planner-grid").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.locator(".plan-card").hover(); assert.equal(await page.locator(".plan-card").evaluate(el => getComputedStyle(el).transform), "none");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const small = await page.locator(".planner-grid").evaluate(el => [...el.querySelectorAll("button,input,select")].filter(node => node.getClientRects().length).filter(node => { const b = node.getBoundingClientRect(); return b.width < 44 || b.height < 44; }).map(node => node.id));
    assert.deepEqual(small, []); assert.deepEqual(app.errors, []);
    assert.ok(app.calls.every(call => call.method === "GET")); assert.ok(app.calls.every(call => !call.body));
    assert.ok(app.calls.every(call => !/search|upload|render|share|mcp/.test(call.path)));
  });
});

test("W6 polling recovers from outage without retry controls and refreshes open detail without losing drafts", async t => {
  const app = await open(t, 1440), { page } = app;
  await page.locator("#plan-name").fill("Typed draft");
  await page.locator("#upcoming-tours .tour-button").first().click(); await page.waitForFunction(() => document.querySelector("#detail-title").textContent.includes("Demo Gulf"));
  await page.locator("#detail-content details summary").click();
  app.revise(); app.outage(true); await page.clock.runFor(30_500);
  await page.waitForFunction(() => document.querySelector("#tour-library-state").textContent.includes("temporarily"));
  assert.match(await page.locator("#tour-library-state").textContent(), /temporarily/);
  app.outage(false); await page.clock.runFor(30_500);
  await page.waitForFunction(() => document.querySelector("#detail-title").textContent === "Demo refreshed tour");
  assert.equal(await page.locator("#plan-name").inputValue(), "Typed draft"); assert.equal(await page.locator("#tour-library-state").textContent(), "");
  assert.equal(await page.locator("#detail-content details").evaluate(el => el.open), true);
  assert.equal(await page.locator("#detail-content summary").evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#upcoming-tours .tour-button").first().evaluate(el => document.activeElement === el), true);
  await page.locator("#tour-filter").fill("Tour 10"); assert.equal(await page.locator("#history-tours button").count(), 1); assert.equal(await page.locator("#upcoming-tours button").count(), 0);
});
