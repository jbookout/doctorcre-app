import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";
import { handleDoctorcreRequest } from "../src/worker.js";
import { route as canonical } from "./fixtures/tour-map.synthetic.mjs";

const tourId = "11111111-1111-4111-8111-111111111111", routeId = "22222222-2222-4222-8222-222222222222";
const stops = [...canonical.stops].sort((a, b) => a.route_sequence - b.route_sequence).map((s, i) => ({
  ...s, id: `${i + 3}${"3333333"}-3333-4333-8333-333333333333`, property_id: `${i + 5}${"5555555"}-5555-4555-8555-555555555555`,
  property_name: s.title, property_address: s.address_line, stop_state: "active", locked_appointment: s.locked_state === "locked", appointment_start: null, appointment_end: null,
}));
const detail = { id: tourId, name: "Synthetic itinerary", status: "draft", route_version_id: routeId, route_version_state: "accepted", accepted_route_version: 3,
  canonical_dataset_version: "synthetic-v1", stops, routes: [{ id: routeId, route_version: 3, accepted: true, stops }], projection_status: "missing" };
const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

test("rendered composer uses compact fallback, keeps exact stop after reload, and fits phone/iPad/desktop", async () => {
  const asset = await handleDoctorcreRequest(new Request("https://example.test/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs"), { ASSETS: { fetch: async () => new Response("fixture") } });
  assert.equal(asset.status, 200);
  const csp = asset.headers.get("content-security-policy");
  const evidenceRequests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/tours/property-evidence/v1") evidenceRequests.push(url.searchParams.get("as_of"));
        const data = url.pathname === "/api/tours/library" ? { tours: [{ id: tourId, name: "Synthetic itinerary" }] }
          : url.pathname === "/api/tours/detail" ? detail
          : url.pathname === "/api/tours/property-evidence/v1" ? { schema: "tour-property-evidence.v1", facts: {
            county: url.searchParams.get("as_of") === "2026-01-15T09:30:45.000Z"
              ? { status: "reviewed", value: "Bay", as_of: "2026-01-15T09:30:45.000Z", effective_from: "2026-01-15T09:00:00Z" }
              : { status: "unknown", reason: "no_authorized_evidence" },
            municipality: { status: "unavailable", reason: "authoritative_coverage_missing" },
          } } : {};
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data, csrf_token: "synthetic-session-csrf" })); return;
      }
      const path = url.pathname === "/tours" ? "tours/route-editor.html" : url.pathname.slice(1);
      if (path.includes("..")) throw new Error("invalid path");
      const content = await readFile(new URL(`../${path}`, import.meta.url));
      res.writeHead(200, { "content-type": type[extname(path)] || "application/octet-stream", "content-security-policy": csp }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    for (const [name, width, height] of [["phone", 390, 844], ["ipad", 820, 1180], ["desktop", 1440, 1000]]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      await page.route(url => !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), route => route.abort());
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${base}/tours`); await page.locator("#appSidebarToggle").click(); await page.locator(".tour-button").click(); if (width <= 760) await page.keyboard.press("Escape");
      const root = page.locator("#accepted-itinerary"); await root.waitFor({ state: "visible" });
      await page.locator('#property-evidence-panel > summary').click();
      const coverage = page.locator('#property-evidence details').filter({ hasText: 'Field coverage' });
      await coverage.locator('summary').focus();
      await coverage.locator('summary').press('Enter');
      await page.waitForFunction(() => document.querySelector('#property-evidence details')?.open);
      assert.equal(await coverage.evaluate(node => node.open), true);
      assert.match(await coverage.innerText(), /County.*Unknown.*No authorized evidence/s);
      assert.match(await coverage.innerText(), /Municipality.*Coverage unavailable.*Authoritative coverage missing/s);
      assert.match(await coverage.innerText(), /Building.*Unknown.*Reason not recorded/s);
      assert.equal(await coverage.locator('a').count(), 0);
      assert.ok(await coverage.evaluate(node => node.getBoundingClientRect().right <= innerWidth), `${name}: coverage fits`);
      if (process.env.TOUR_MAP_SCREENSHOTS) {
        await mkdir(process.env.TOUR_MAP_SCREENSHOTS, { recursive: true });
        await page.locator('#property-evidence-panel').screenshot({ path: `${process.env.TOUR_MAP_SCREENSHOTS}/coverage-${name}.png` });
      }
      await page.locator('#property-evidence-date').fill('2026-01-15');
      await page.locator('#property-evidence-time').fill('09:30:45');
      await page.locator('#property-evidence-time').blur();
      await page.waitForFunction(() => document.querySelector('#property-evidence-content')?.textContent.includes('Bay'));
      assert.ok(evidenceRequests.includes('2026-01-15T09:30:45.000Z'));
      const timeInput = page.getByLabel('Time (UTC, optional)', { exact: true });
      assert.equal(await timeInput.inputValue(), '09:30:45');
      assert.ok(await timeInput.evaluate(node => node.getBoundingClientRect().right <= innerWidth), `${name}: time input fits`);
      await page.locator('[data-evidence-field="county"]').click();
      const evidenceDialog = page.locator('#property-evidence-dialog');
      assert.match(await evidenceDialog.innerText(), /2026-01-15T09:30:45.000Z/);
      assert.match(await evidenceDialog.innerText(), /2026-01-15T09:00:00.000Z/);
      if (process.env.TOUR_MAP_SCREENSHOTS) {
        await evidenceDialog.screenshot({ path: `${process.env.TOUR_MAP_SCREENSHOTS}/intraday-${name}.png` });
      }
      await page.keyboard.press('Escape');
      await evidenceDialog.waitFor({ state: 'hidden' });
      assert.equal(await root.locator("canvas").count(), 0);
      assert.match(await root.locator("[data-map-status]").innerText(), /Street map unavailable/);
      assert.equal(await root.locator("[data-itinerary-stop]").count(), 2);
      const second = root.locator(`[data-itinerary-stop="${stops[1].id}"] button`);
      const first = root.locator(`[data-itinerary-stop="${stops[0].id}"] button`);
      await first.focus(); await first.press("Enter");
      assert.equal(await first.evaluate(el => document.activeElement === el), true);
      await first.press("Tab");
      assert.equal(await second.evaluate(el => document.activeElement === el), true);
      await second.press("Enter");
      assert.equal(await second.evaluate(el => document.activeElement === el), true);
      await root.locator(`[data-itinerary-stop="${stops[1].id}"] button`).click();
      assert.equal(await root.locator("[data-itinerary-card]").getAttribute("data-property-id"), stops[1].property_id);
      assert.equal(await root.locator(".maplibregl-canvas").count(), 0);
      if (name === "phone") {
        stops[1].property_name = "Refreshed synthetic property";
        stops[1].property_address = "202 Example Way";
        await page.locator("#route-editing > summary").click();
        await page.locator("#reload-composer").click();
        await page.waitForFunction(() => document.querySelector('[data-itinerary-stop][aria-current=step]').textContent.includes("Refreshed synthetic property"));
        assert.match(await root.locator('[data-itinerary-card]').textContent(), /202 Example Way/);
        await page.evaluate(async () => {
          const component = await import("/tours/itinerary-map.js"), gl = await import("/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs");
          const detail = (await (await fetch("/api/tours/detail")).json()).data;
          const root = document.createElement("section"); root.id = "provider-regression"; document.body.append(root);
          const provider = { ...gl, Map: class extends gl.Map { constructor(options) { super(options); window.regressionMap = this; } } };
          window.regressionView = component.mountAcceptedItinerary(root, { route: component.acceptedRouteFromDetail(detail), prefersReducedMotion: true, basemapStyle: { version: 8, sources: {}, layers: [] }, loadMapLibre: async () => provider });
          await window.regressionView.ready;
        });
        await page.waitForFunction(() => window.regressionMap.loaded());
        for (const [center, zoom] of [[[-87, 30], 0], [[200, 30], 8], [[180, 30], 8]]) {
          await page.evaluate(({ center, zoom }) => {
            const button = document.querySelector("#provider-regression .itinerary-stop button"); button.focus();
            window.regressionMap.jumpTo({ center, zoom });
          }, { center, zoom });
          assert.equal(await page.evaluate(() => document.activeElement.closest('[data-itinerary-stop]') !== null), true);
        }
        await page.evaluate(() => { window.regressionView.destroy(); document.querySelector("#provider-regression").remove(); });
      }
      await page.reload(); await root.waitFor({ state: "visible" });
      assert.equal(await root.locator("[aria-current=step]").getAttribute("data-itinerary-stop"), stops[1].id);
      assert.equal(await root.locator("canvas").count(), 0);
      await root.scrollIntoViewIfNeeded();
      const bounds = await root.evaluate(el => ({ width: document.documentElement.scrollWidth, targets: [...el.querySelectorAll("button,a")].filter(n => n.getClientRects().length).map(n => { const b = n.getBoundingClientRect(); return { text: n.textContent, w: b.width, h: b.height }; }) }));
      assert.ok(bounds.width <= width, `${name}: overflow ${bounds.width}`);
      assert.deepEqual(bounds.targets.filter(t => t.w < 44 || t.h < 44), [], `${name}: touch targets`);
      assert.deepEqual(errors, [], `${name}: browser errors`);
      if (process.env.TOUR_MAP_SCREENSHOTS) {
        await mkdir(process.env.TOUR_MAP_SCREENSHOTS, { recursive: true });
        // Hide unrelated sticky shell overlays for the component capture. Style
        // properties work under the production CSP; an injected sheet does not.
        await page.evaluate(() => { document.querySelector("#appShell").style.visibility = "hidden"; });
        await root.screenshot({ path: `${process.env.TOUR_MAP_SCREENSHOTS}/${name}.png`, animations: "disabled" });
      }
      await page.context().setOffline(true);
      await page.waitForFunction(() => /ordered list/i.test(document.querySelector('[data-map-status]').textContent));
      assert.equal(await root.locator("[data-itinerary-stop]").count(), 2);
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
