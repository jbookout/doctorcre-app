import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { chromium } from "playwright";

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
  await page.goto("http://localhost/tours"); await page.waitForFunction(() => document.querySelector("#plan-client").options.length === 2);
  return { page, calls, errors, outage(value) { unavailable = value; }, revise() { revision += 1; }, accept() { accepted = true; } };
}

test("Next tour opens an eligible Tour day from the Tours page without the library drawer", async t => {
  for (const width of [320, 390]) await t.test(String(width), async t => {
    const app = await open(t, width), { page } = app, link = page.getByRole("link", { name: /^Next tour/ });
    assert.equal(await page.locator("#next-tour").isVisible(), false, "a tour without an accepted route offers no Tour day");
    app.accept(); await page.locator("#planner-refresh").click();
    await link.waitFor();
    assert.match(await link.textContent(), /Demo Gulf Coast Tour/);
    assert.equal(await link.getAttribute("href"), "/tours/day.html?tour=22222222-2222-4222-8222-222222222222");
    assert.equal(await link.evaluate(node => !node.closest("[data-layout-slot=sidebar], .library-card, #appSidebar")), true, "the entry is in the page, not the sidebar drawer");
    const box = await link.boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
    await page.keyboard.press("Tab"); await link.focus(); assert.equal(await link.evaluate(node => node === document.activeElement), true);
    assert.deepEqual(app.errors, []);
  });
});

test("W6 desktop and phone render, client prefill/undo, private files, wide popup and measured reduced motion", async t => {
  await mkdir(new URL("out/test-artifacts/w6/", root), { recursive: true });
  for (const width of [1440, 390]) await t.test(String(width), async t => {
    const app = await open(t, width), { page } = app; const name = width === 1440 ? "desktop" : "phone";
    await page.locator("#plan-client").selectOption(clientId);
    await page.waitForFunction(() => document.querySelector("#plan-name").value.includes("Demo Harbor"));
    await page.locator("#plan-area").fill("Typed tour area"); await page.getByLabel("Undo tour edit", { exact: true }).click();
    assert.equal(await page.locator("#plan-area").inputValue(), "Pensacola, FL");
    await page.locator("#plan-date").fill("2026-10-08"); await page.locator("#plan-dwell").fill("25");
    assert.equal(await page.locator("#file-count").textContent(), "0 files");
    await page.locator("#packet-upload").setInputFiles({ name: "demo-report.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic private report bytes") });
    assert.equal(await page.locator("#file-count").textContent(), "1 file");
    await page.locator("#packet-upload").setInputFiles({ name: "demo-second.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic second private report") });
    assert.equal(await page.locator("#file-count").textContent(), "2 files");
    await page.getByRole("button", { name: "Remove demo-second.txt", exact: true }).click();
    assert.equal(await page.locator("#file-count").textContent(), "1 file");
    assert.match(await page.locator("#packet-files").textContent(), /demo-report/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("doctorcre-tour-planning-drafts-v1").includes("demo-report")), false);
    await page.locator('[data-market="Pensacola, FL"]').click(); assert.equal(await page.locator("#space-area").inputValue(), "Pensacola, FL");
    await page.locator("#space-minSize").fill("1800"); await page.locator("#space-maxSize").fill("3000");
    await page.locator("#space-requirements").fill("Ground floor · accessible entry");
    await page.locator("#save-search").click(); assert.match(await page.locator("#space-message").textContent(), /saved/);
    assert.equal(await page.locator("#property-search-form").count(), 0);
    assert.equal(await page.locator(".territory-map").evaluate(el => el.getAnimations({ subtree: true }).length), 0, "V2: the territory map has no decorative motion");
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: new URL(`out/test-artifacts/w6/${name}.png`, root).pathname, fullPage: true, animations: "disabled" });
    await page.locator("#review-packet").click(); await page.locator("#tour-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#detail-content").textContent(), /demo-report/);
    const box = await page.locator("#tour-dialog").boundingBox(); assert.ok(box.width >= Math.min(1000, width - 32));
    await page.getByLabel("Close tour details").click(); assert.equal(await page.locator("#review-packet").evaluate(el => document.activeElement === el), true);
    if (width <= 760) await page.locator("#appSidebarToggle").click();
    await page.locator("#upcoming-tours .tour-button").first().click(); await page.waitForFunction(() => document.querySelector("#detail-title").textContent.includes("Demo Gulf"));
    assert.ok((await page.locator("#detail-content > p").first().textContent()).length <= 180);
    await page.locator("#detail-content details summary").click(); assert.equal(await page.locator("#detail-content details p").textContent(), original);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: new URL(`out/test-artifacts/w6/${name}-detail.png`, root).pathname, fullPage: false, animations: "disabled" });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#tour-dialog").evaluate(n => n.open), false, "R5 one Escape closes the top modal");
    if (width <= 760) {
      assert.equal(await page.locator("#appLayout").getAttribute("data-drawer"), "sidebar");
      assert.equal(await page.locator("#upcoming-tours").evaluate(n => n.contains(document.activeElement)), true);
      await page.keyboard.press("Escape");
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".planner-grid").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.locator(".plan-card").hover(); assert.equal(await page.locator(".plan-card").evaluate(el => getComputedStyle(el).transform), "none");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const small = await page.locator(".planner-grid").evaluate(el => [...el.querySelectorAll("button,input,select")].filter(node => node.getClientRects().length).filter(node => { const b = node.getBoundingClientRect(); return b.width < 44 || b.height < 44; }).map(node => node.id));
    assert.deepEqual(small, []); assert.deepEqual(app.errors, []);
    assert.ok(app.calls.every(call => call.method === "GET" || call.path === "/mcp")); assert.ok(app.calls.every(call => !call.body || call.path === "/mcp"));
    assert.ok(app.calls.filter(call=>call.path.startsWith("/api/")).every(call => !/search|upload|render|share/.test(call.path)));
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
  assert.equal(await page.locator("#plan-name").inputValue(), "Typed draft"); await page.waitForFunction(() => document.querySelector("#tour-library-state").textContent === "");
  assert.equal(await page.locator("#detail-content details").evaluate(el => el.open), true);
  assert.equal(await page.locator("#detail-content summary").evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#upcoming-tours .tour-button").first().evaluate(el => document.activeElement === el), true);
  await page.locator("#tour-filter").fill("Tour 10"); assert.equal(await page.locator("#history-tours button").count(), 1); assert.equal(await page.locator("#upcoming-tours button").count(), 0);
});


for (const status of [401,403]) test(`PR182 Tours ${status} settles freshness at boot and retry`, async t => {
  const { page, errors } = await open(t,1440);
  await page.route('**/api/**', route => route.fulfill({status,json:{}}));
  await page.reload();
  await page.getByText('Sign in to continue.',{exact:true}).first().waitFor();
  assert.equal(await page.locator('#planner-updated').textContent(), 'Unavailable');
  await page.locator('#planner-refresh').click();
  await page.getByText('Sign in to continue.',{exact:true}).first().waitFor();
  assert.equal(await page.locator('#planner-updated').textContent(), 'Unavailable');
  assert.equal(await page.locator('.freshness').evaluate(n=>n.classList.contains('current')), false);
  assert.deepEqual(errors,[]);
});

test('planner reveals reviewed territory on demand and keeps editable market controls when geometry fails', async t => {
  const { page, calls, errors } = await open(t, 390);
  assert.equal(await page.locator('svg.territory-map').count(), 0);
  assert.equal(calls.some(call => /maplibre|leads-territory|leads-market-locations/.test(call.path)), false);
  await page.route('**/data/leads-territory.geojson', route => route.fulfill({ status: 503 }));
  const reveal = page.getByRole('button', { name: 'Show territory', exact: true });
  await reveal.focus(); await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: 'Territory unavailable. Choose an area above' }).waitFor();
  assert.equal(await page.locator('#planner-territory').isVisible(), false, 'a failed map leaves no empty box');
  await page.locator('[data-market="Pensacola, FL"]').click();
  assert.equal(await page.locator('#space-area').inputValue(), 'Pensacola, FL');
  await page.getByLabel('Undo search edit', { exact: true }).click();
  assert.equal(await page.locator('#space-area').inputValue(), '');
  assert.deepEqual(errors, []);
});

for (const width of [1440, 390]) test(`planner renders Census geography after reveal and reuses its canvas at ${width}px`, async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'm01-planner-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(root), outDir, commit: '1'.repeat(40) });
  const { page, calls, errors } = await open(t, width, pathToFileURL(`${outDir}/site/`));
  await page.route('**/maplibre-gl.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    export * from './maplibre-gl.mjs?provider';
    import { Map as ProviderMap } from './maplibre-gl.mjs?provider';
    export class Map extends ProviderMap {
      constructor(options) { super(options); globalThis.plannerRenderer = this; }
      fitBounds(bounds, options) { globalThis.plannerBounds = bounds.toArray(); return super.fitBounds(bounds, options); }
    }
  ` }));
  const buttonsTop = await page.locator('.market-buttons').evaluate(node => node.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('#planner-territory canvas').waitFor();
  await page.waitForFunction(() => globalThis.plannerRenderer?.loaded());
  assert.ok(await page.evaluate(() => plannerRenderer.queryRenderedFeatures({ layers: ['land'] }).length) > 0);
  // The extent is the five area points, so the markets fill the map.
  assert.deepEqual(await page.evaluate(() => plannerBounds), [[-88.107853, 30.239496], [-84.252272, 30.668246]]);
  const canvas = await page.locator('#planner-territory canvas').elementHandle();
  await page.getByRole('button', { name: 'Hide territory', exact: true }).click();
  assert.equal(await page.locator('#planner-territory').isVisible(), false);
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  // Every area button has one labelled Census market point; there are no lead or property pins.
  const points = page.locator('#planner-territory .area-marker');
  assert.deepEqual(await points.allTextContents(), ['Mobile', 'Pensacola', 'Fort Walton / Destin', 'Panama City', 'Tallahassee']);
  assert.deepEqual(await points.evaluateAll(nodes => nodes.map(node => node.dataset.market)),
    await page.locator('.market-buttons [data-market]').evaluateAll(nodes => nodes.map(node => node.dataset.market)));
  assert.equal(await page.locator('#planner-territory .market-marker').count(), 0);
  const pressed = () => page.evaluate(() => ({ button: document.querySelector('.market-buttons [aria-pressed="true"]')?.dataset.market ?? null,
    point: document.querySelector('#planner-territory .area-marker[aria-pressed="true"]')?.dataset.market ?? null }));
  await page.locator('.market-buttons [data-market="Pensacola, FL"]').click();
  assert.deepEqual(await pressed(), { button: 'Pensacola, FL', point: 'Pensacola, FL' });
  await page.getByRole('button', { name: 'Choose Tallahassee on the map', exact: true }).click();
  assert.deepEqual(await pressed(), { button: 'Tallahassee, FL', point: 'Tallahassee, FL' });
  assert.equal(await page.locator('#space-area').inputValue(), 'Tallahassee, FL');
  await page.locator('.market-buttons [data-market="Pensacola, FL"]').click();
  assert.equal(await page.locator('.market-buttons').evaluate(node => node.getBoundingClientRect().top), buttonsTop, 'the status line and map never move the area buttons');
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  assert.equal(await page.locator('#space-area').inputValue(), 'Pensacola, FL');
  assert.equal(await canvas.evaluate(node => node.isConnected), true);
  assert.equal(calls.filter(call => call.path.endsWith('leads-territory.geojson')).length, 1);
  // Water and land stay distinct in the painted theme.
  const paints = () => page.evaluate(() => Object.fromEntries([['ground', 'background-color'], ['context', 'fill-color'], ['land', 'fill-color']]
    .map(([layer, property]) => [layer, String(plannerRenderer.getPaintProperty(layer, property))])));
  const before = await paints();
  assert.equal(new Set(Object.values(before)).size, 3, 'water, context land and territory land are distinct');
  // Every label stays inside the map and clear of every other label and dot.
  const layout = await page.evaluate(() => {
    const frame = document.querySelector('#planner-territory').getBoundingClientRect();
    const labels = [...document.querySelectorAll('#planner-territory .area-marker span')].map(node => node.getBoundingClientRect());
    const dots = [...document.querySelectorAll('#planner-territory .area-marker')].map(node => node.getBoundingClientRect());
    const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { inside: labels.every(r => r.left >= frame.left && r.right <= frame.right && r.top >= frame.top && r.bottom <= frame.bottom),
      overlaps: labels.flatMap((a, i) => [...labels.map((b, j) => j > i && hits(a, b)), ...dots.map((b, j) => j !== i && hits(a, b))]).filter(Boolean).length };
  });
  assert.deepEqual(layout, { inside: true, overlaps: 0 });
  // A theme switch repaints the open map in place.
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; });
  await page.waitForFunction(previous => String(plannerRenderer.getPaintProperty('ground', 'background-color')) !== previous, before.ground);
  const after = await paints();
  assert.notEqual(after.land, before.land); assert.notEqual(after.context, before.context);
  await mkdir(new URL('out/test-artifacts/w6/', root), { recursive: true });
  await page.screenshot({ path: new URL(`out/test-artifacts/w6/territory-${width}.png`, root).pathname, fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
});
