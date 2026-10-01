import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mountAcceptedItinerary, acceptedRouteFromDetail } from "../tours/itinerary-map.js";
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
