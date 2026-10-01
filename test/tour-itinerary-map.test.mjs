import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mountAcceptedItinerary, acceptedRouteFromDetail, normalizedProviderBounds } from "../tours/itinerary-map.js";
import { route, receipt } from "./fixtures/tour-map.synthetic.mjs";

function provider() {
  const maps = [], markers = [];
  class Map {
    constructor() { maps.push(this); this.events = {}; this.flights = []; this.jumps = []; }
    on(name, fn) { this.events[name] = fn; }
    getBounds() { return { toArray: () => [[-89, 30], [-87, 32]] }; }
    resize() {} remove() { this.removed = true; }
    flyTo(plan) { this.flights.push(plan); } jumpTo(plan) { this.jumps.push(plan); }
  }
  class Marker {
    constructor({ element }) { this.element = element; markers.push(this); }
    setLngLat(position) { this.position = position; return this; }
    addTo(map) { this.map = map; return this; } remove() { this.removed = true; }
  }
  return { maps, markers, Map, Marker, setWorkerUrl() {} };
}
async function open(options = {}, storage = {}) {
  const dom = new JSDOM('<section id="map-root"></section>', { url: "https://example.test/tours" });
  for (const [k, v] of Object.entries(storage)) dom.window.sessionStorage.setItem(k, v);
  const root = dom.window.document.querySelector("section"), gl = provider();
  const view = mountAcceptedItinerary(root, { route: structuredClone(route), promotion_receipt: receipt, user_ref: "synthetic-user", scope: "synthetic-session", loadMapLibre: async () => gl, ...options });
  await view.ready;
  return { dom, root, view, gl, storage: () => Object.fromEntries(Object.entries(dom.window.sessionStorage)) };
}
const rows = root => [...root.querySelectorAll('[data-itinerary-stop]')];
const select = (root, stop) => root.querySelector(`[data-itinerary-stop="${stop}"] button`).click();

test("exact pinned composer POST feeds its legal fixed appointment into the accepted consumer", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned composer boundary",
}, async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  const source = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, "show", `${contract.producer.source_commit}:mcp-server/src/tour-internal-web.js`], { encoding: "utf8" });
  const { createTourInternalWebHandler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const routeId = "22222222-2222-4222-8222-222222222222", stopId = "33333333-3333-4333-8333-333333333333";
  const input = { idempotency_key: stopId, route_version_id: routeId, property_id: "44444444-4444-4444-8444-444444444444", route_sequence: 1, route_label: "A", stop_state: "active", appointment_start: "2026-09-30T12:00:00Z", appointment_end: "2026-09-30T12:00:00Z", locked_appointment: true, dwell_minutes: 30, buffer_minutes: 10, access_coordinate_status: "unknown", assertion_set_digest: `sha256:${"0".repeat(64)}` };
  const calls = [];
  const handler = createTourInternalWebHandler({ appendRouteStopFn: async context => { calls.push(context.input); return { ok: true, data: { route_stop_id: stopId } }; } });
  const response = await handler.fetch(new Request("https://app.doctorcre.com/api/tours/route-stop", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.doctorcre.com", "sec-fetch-site": "same-origin", "x-carr-csrf": "synthetic-csrf" }, body: JSON.stringify(input) }), { APP_HOST: "app.doctorcre.com" }, {}, { id: "synthetic-partner" }, { csrfToken: "synthetic-csrf" });
  assert.equal(response.status, 200); assert.deepEqual(calls, [input]);
  const accepted = acceptedRouteFromDetail({ id: "11111111-1111-4111-8111-111111111111", routes: [{ id: routeId, route_version: 1, accepted: true, stops: [{ ...calls[0], id: stopId, property_name: "Synthetic producer site", property_address: "100 Example Way" }] }] });
  const { view } = await open({ route: accepted, promotion_receipt: null });
  assert.deepEqual(view.projection.card.appointment, { start: input.appointment_start, end: input.appointment_end });
  assert.equal(view.projection.card.locked_state, "locked");
});

test("producer-legal equal appointment instants remain fixed and readable without changing timestamps", async () => {
  for (const [start, end] of [["2026-09-30T12:00:00Z", "2026-09-30T12:00:00Z"], ["2026-09-30T12:00:00Z", "2026-09-30T12:00:00.000Z"]]) {
    const candidate = structuredClone(route), stop = candidate.stops.find(s => s.route_stop_id === "stop-a");
    Object.assign(stop, { locked_state: "locked", appointment_start: start, appointment_end: end });
    const { root, view } = await open({ route: candidate });
    assert.deepEqual(view.projection.card.appointment, { start, end });
    assert.deepEqual(view.projection.offline_itinerary[0].appointment, { start, end });
    assert.equal(view.projection.card.locked_state, "locked");
    assert.match(root.querySelector('[data-itinerary-card]').textContent, /Fixed appointment/);
    view.dispatch({ type: "bounds_change", bounds: [-90, 20, -80, 40] });
    assert.deepEqual(view.projection.card.appointment, { start, end });
  }
  for (const [start, end] of [["invalid", "invalid"], ["2026-02-30T12:00:00Z", "2026-02-30T12:00:00Z"], ["2026-09-30T12:00:00Z", "2026-09-30T11:00:00Z"]]) {
    const candidate = structuredClone(route); Object.assign(candidate.stops[0], { appointment_start: start, appointment_end: end });
    await assert.rejects(open({ route: candidate }), { code: "invalid_appointment" });
  }
});

test("delayed native activation stores a fresh marker that restores the current stop", async t => {
  const at = new Date("2026-09-30T10:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: at.getTime() });
  const first = await open();
  const link = first.root.querySelector('[data-itinerary-card] a');
  first.root.addEventListener("click", event => event.preventDefault(), true);
  t.mock.timers.tick(13 * 60 * 60 * 1000);
  link.dispatchEvent(new first.dom.window.MouseEvent("click", { cancelable: true }));
  const saved = first.storage();
  const marker = JSON.parse(saved[Object.keys(saved).find(k => k.startsWith("doctorcre-current-stop-v1:"))]).return_state;
  assert.equal(marker.generated_at, "2026-09-30T23:00:00.000Z");
  assert.equal(marker.expires_at, "2026-10-01T11:00:00.000Z");
  const returned = await open({}, saved);
  assert.equal(returned.view.projection.card.route_stop_id, "stop-a");
  assert.doesNotMatch(returned.root.querySelector('[data-map-status]').textContent, /could not be restored/);
});

test("native activation retains a visible return-restoration warning when storage fails", async () => {
  const { root, dom } = await open();
  Object.defineProperty(dom.window.Storage.prototype, "setItem", { value() { throw new Error("storage unavailable"); } });
  root.addEventListener("click", event => event.preventDefault(), true);
  root.querySelector('[data-itinerary-card] a').dispatchEvent(new dom.window.MouseEvent("click", { cancelable: true }));
  assert.match(root.querySelector('[data-map-status]').textContent, /Storage unavailable.*return.*restor/i);
  root.querySelector('[data-map-mode="search"]').click();
  assert.match(root.querySelector('[data-map-status]').textContent, /Storage unavailable/i);
});

test("partial optional coordinates retain ordered facts and cannot navigate", async () => {
  for (const position of [{ ...route.stops[1].position, latitude: null }, { ...route.stops[1].position, longitude: 200 }, { latitude: 30 }]) {
    const candidate = structuredClone(route);
    candidate.stops.find(s => s.route_stop_id === "stop-a").position = position;
    const { root, view } = await open({ route: candidate });
    assert.equal(rows(root).length, 2);
    assert.equal(view.projection.card.display, "unknown");
    assert.match(root.querySelector('[data-itinerary-card]').textContent, /100 Example Way/);
    assert.equal(root.querySelectorAll('[data-itinerary-card] a').length, 0);
    select(root, "stop-b"); assert.equal(view.projection.card.route_stop_id, "stop-b");
  }
});

test("provider world copies and wide views dispatch valid antimeridian bounds", async () => {
  const { gl, view } = await open();
  for (const [raw, expected] of [
    [[-223.40625, -20, 49.40625, 70], [136.59375, -20, 49.40625, 70]],
    [[199, 29, 201, 31], [-161, 29, -159, 31]],
    [[-300, -80, 300, 80], [-180, -80, 180, 80]],
    [[170, 29, 190, 31], [170, 29, -170, 31]],
  ]) {
    gl.maps[0].getBounds = () => ({ toArray: () => [[raw[0], raw[1]], [raw[2], raw[3]]] });
    assert.deepEqual(normalizedProviderBounds(gl.maps[0].getBounds().toArray()), expected);
    assert.doesNotThrow(() => gl.maps[0].events.moveend());
    // A subsequent selection proves bounds updates leave the route usable.
    view.dispatch({ type: "route_stop_change", route_stop_id: "stop-b" });
    assert.equal(view.projection.card.route_stop_id, "stop-b");
  }
});

test("ordered controls keep keyboard focus through selection and moveend in map and fallback", async () => {
  for (const fallback of [false, true]) {
    const { root, dom, gl } = await open();
    if (fallback) gl.maps[0].events.error();
    const button = root.querySelector('[data-itinerary-stop="stop-b"] button');
    button.focus(); button.click();
    assert.equal(dom.window.document.activeElement.closest('[data-itinerary-stop]')?.dataset.itineraryStop, "stop-b");
    gl.maps[0].events.moveend();
    assert.equal(dom.window.document.activeElement.closest('[data-itinerary-stop]')?.dataset.itineraryStop, "stop-b");
    dom.window.document.activeElement.click();
    assert.equal(root.querySelector('[aria-current=step]').dataset.itineraryStop, "stop-b");
  }
});

test("same-identity refresh replaces facts and receipt bindings while retaining interaction state", async () => {
  const { root, view, gl } = await open();
  root.querySelector('[data-map-mode="search"]').click();
  const fresh = structuredClone(route);
  const stop = fresh.stops.find(s => s.route_stop_id === "stop-a");
  stop.title = "Refreshed synthetic site"; stop.address_line = "200 Example Way";
  stop.position.latitude = 30.62;
  view.update({ route: fresh });
  assert.equal(view.projection.mode, "search");
  assert.equal(view.projection.card.title, stop.title);
  assert.equal(view.projection.card.address_line, stop.address_line);
  assert.equal(gl.markers.find(m => m.element.dataset.routeStopId === "stop-a").position[1], 30.62);
  for (const field of ["canonical_dataset_version", "component_registry_version"]) {
    view.update({ route: { ...fresh, [field]: "new-version" } });
    assert.equal(root.querySelectorAll('[data-itinerary-card] a').length, 0, field);
  }
});

test("route module stays byte-bound to CARR PR 1443 and GL reuses the pinned app distribution", async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url));
  const contract = JSON.parse(await read("contracts/tour-map.v1.json"));
  assert.equal(contract.version, "1.2.0");
  assert.equal(contract.producer.source_commit, "edf9c2d74a7e64070f8c2dc5189ea8b6181af435");
  assert.equal(createHash("sha256").update(await read(contract.consumer_module)).digest("hex"), contract.producer.sha256);
  for (const file of ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css", "LICENSE.txt"]) {
    assert.deepEqual(await read(`tours/vendor/maplibre-gl-6.4.1/${file}`), await read(`reports/vendor/maplibre-gl-6.4.1/${file}`));
  }
});

test("one route version supplies marker/list/card/offline order and identity", async () => {
  const { root, view, gl } = await open();
  assert.deepEqual(rows(root).map(n => n.dataset.itineraryStop), ["stop-a", "stop-b"]);
  assert.deepEqual(gl.markers.map(m => m.element.dataset.routeStopId), ["stop-a", "stop-b"]);
  assert.match(gl.markers[0].element.textContent, /synthetic:access-review.*entrance/);
  assert.deepEqual(view.projection.offline_itinerary.map(s => s.route_stop_id), ["stop-a", "stop-b"]);
  assert.equal(root.querySelector('[data-itinerary-card]').dataset.propertyId, "property-a");
  assert.equal(view.projection.route_version, 3);
});
test("list selection and mode events synchronize marker and card without map remount", async () => {
  const { root, view, gl } = await open(); select(root, "stop-b");
  assert.equal(root.querySelector('[data-itinerary-card]').dataset.propertyId, "property-b");
  assert.equal(gl.markers[1].element.getAttribute("aria-pressed"), "true");
  root.querySelector('[data-map-mode="search"]').click();
  gl.markers[0].element.click();
  assert.equal(view.projection.card.property_id, "property-a");
  assert.equal(view.projection.mode, "search"); assert.equal(gl.maps.length, 1);
});
test("centroids, unreviewed, geocoder and imprecise access pins have no navigation links", async () => {
  for (const position of [route.stops[0].position, { ...route.stops[1].position, coordinate_role: "building_centroid" }, { ...route.stops[1].position, human_approved: false }, { ...route.stops[1].position, coordinate_role: "geocoder_candidate" }, { ...route.stops[1].position, precision_class: "building" }]) {
    const candidate = structuredClone(route); candidate.stops[1].position = position;
    const { root, view } = await open({ route: candidate });
    assert.equal(root.querySelectorAll('[data-itinerary-card] a').length, 0);
    assert.match(root.querySelector('[data-itinerary-card]').textContent, /Approximate location/); view.destroy();
  }
});
test("approved access pins produce exact-coordinate Apple and Google handoff URLs", async () => {
  const { root } = await open();
  assert.deepEqual([...root.querySelectorAll('[data-itinerary-card] a')].map(a => a.href), [
    "https://maps.apple.com/?daddr=30.6001,-88.0001&dirflg=d",
    "https://www.google.com/maps/dir/?api=1&destination=30.6001,-88.0001&travelmode=driving",
  ]);
});
test("missing or wrong-version promotion receipt withholds even approved access links", async () => {
  for (const promotion_receipt of [null, { ...receipt, route_version: 4 }]) {
    const { root } = await open({ promotion_receipt }); assert.equal(root.querySelectorAll('[data-itinerary-card] a').length, 0);
    assert.match(root.textContent, /receipt/i);
  }
});
test("current stop survives reload and native handoff but stays bound to session and route version", async () => {
  const first = await open(); select(first.root, "stop-b"); const saved = first.storage();
  const restored = await open({}, saved); assert.equal(restored.view.projection.card.route_stop_id, "stop-b");
  assert.equal(restored.view.projection.list[1].current, true);
  const other = await open({ scope: "another-session" }, saved); assert.equal(other.view.projection.card.route_stop_id, "stop-a");
  const newer = await open({ route: { ...route, route_version: 4, route_version_id: "route-v4" } }, saved);
  assert.equal(newer.view.projection.card.route_stop_id, "stop-a");
  const handoffRoute = structuredClone(route); handoffRoute.stops[0].position = { ...route.stops[1].position, latitude: 30.6102, longitude: -88.0102 };
  const handoffView = await open({ route: handoffRoute }); select(handoffView.root, "stop-b");
  handoffView.root.addEventListener("click", event => event.preventDefault(), true);
  handoffView.root.querySelector('[data-itinerary-card] a').dispatchEvent(new handoffView.dom.window.MouseEvent("click", { cancelable: true }));
  const afterHandoff = await open({ route: handoffRoute }, handoffView.storage()); assert.equal(afterHandoff.view.projection.list[1].current, true);
});
test("map init failure renders a usable ordered fallback", async () => {
  const { root, view } = await open({ loadMapLibre: async () => ({ ...provider(), Map: class { constructor() { throw new Error("no WebGL"); } } }) });
  assert.match(root.querySelector('[data-map-status]').textContent, /ordered list/i);
  assert.match(rows(root)[0].textContent, /100 Example Way/);
  assert.match(rows(root)[0].textContent, /Dwell 30 min.*Buffer 10 min/);
  assert.equal(rows(root).length, 2); select(root, "stop-b"); assert.equal(view.projection.card.route_stop_id, "stop-b");
});
test("tile failure and offline transitions preserve current stop and ordered list", async () => {
  const { root, gl, dom, view } = await open(); select(root, "stop-b"); gl.maps[0].events.error({ error: new Error("tile failed") });
  assert.match(root.querySelector('[data-map-status]').textContent, /ordered list/i);
  dom.window.dispatchEvent(new dom.window.Event("offline"));
  assert.equal(view.projection.card.route_stop_id, "stop-b"); assert.equal(rows(root).length, 2);
});
test("reduced motion uses jumpTo and never flyTo", async () => {
  const { root, gl } = await open({ prefersReducedMotion: true }); select(root, "stop-b");
  assert.equal(gl.maps[0].flights.length, 0); assert.ok(gl.maps[0].jumps.length > 0);
});
test("missing coordinate geometry explicitly falls back to the ordered list", async () => {
  const unknown = structuredClone(route); unknown.stops.forEach(stop => { stop.position = null; });
  const { root, view } = await open({ route: unknown });
  assert.match(root.querySelector('[data-map-status]').textContent, /No recorded coordinates.*ordered list/);
  assert.equal(rows(root).length, 2); assert.equal(view.projection.markers[0].display, "unknown");
});
test("detail adapter uses accepted version even while a newer draft is being composed; never upgrades coordinate status to approval", () => {
  const detail = { id: "tour-synthetic", projection_id: null, routes: [
    { id: "draft-v4", route_version: 4, accepted: false, stops: [] },
    { id: "accepted-v3", route_version: 3, accepted: true, stops: [{ id: "stop-a", property_id: "property-a", route_sequence: 1, route_label: "A", stop_state: "active", property_name: "Synthetic property", locked_appointment: false, access_coordinate_status: "verified" }, { id: "held", stop_state: "held" }] },
  ] };
  const adapted = acceptedRouteFromDetail(detail); assert.equal(adapted.route_version, 3); assert.equal(adapted.stops.length, 1);
  assert.equal(adapted.stops[0].position, null); assert.equal(adapted.stops[0].property_id, "property-a");
});
