import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { noteState } from "../tours/day-store.js";
import { createDayClient } from "../tours/day-client.js";
import { orderedDayStops, safePhone, boundClientId } from "../tours/day.js";
import { createDayRecorder } from "../tours/day-recorder.js";
import { JSDOM } from "jsdom";
import { mountAcceptedItinerary } from "../tours/itinerary-map.js";
import { route, receipt as mapReceipt } from "./fixtures/tour-map.synthetic.mjs";

const base = () => ({ id: "note-1", scope: "synthetic-scope", tour_id: "tour-1", client_id: "client-1", property_id: "property-1", route_version_id: "route-1", route_stop_id: "stop-1", status: "local", audio: new Blob(["synthetic-audio"]), captured_at: "2026-10-01T12:00:00Z" });
function memory(rows = [base()]) {
  return { rows, async put(n) { rows.push(n); }, async list(scope, tour) { return rows.filter(n => n.scope === scope && n.tour_id === tour); }, async patch(scope, id, data) { const row = rows.find(n => n.scope === scope && n.id === id); if (row) Object.assign(row, data); return row; } };
}
test("accepted route order, stable property identity, safe call links and honest live capability", async () => {
  assert.deepEqual(orderedDayStops({ routes: [{ accepted: false, stops: [{ id: "draft" }] }, { accepted: true, stops: [{ id: "b", route_sequence: 2, stop_state: "active" }, { id: "held", route_sequence: 3, stop_state: "held" }, { id: "a", route_sequence: 1, stop_state: "active" }] }] }).map(s => s.id), ["a", "b"]);
  assert.equal(safePhone("+1 (202) 555-0100"), "tel:+12025550100");
  const clientId = "11111111-1111-4111-8111-111111111111";
  assert.equal(boundClientId({ subject_type: "client", subject_id: clientId }), clientId);
  assert.equal(boundClientId({ client_id: clientId }), null);
  assert.equal(boundClientId({ subject_type: "work", subject_id: clientId, client_id: clientId }), null);
  assert.equal(boundClientId({ subject_type: "client", subject_id: "invalid", client_id: clientId }), null);
  for (const value of ["javascript:alert(1)", "+1+2025550100", "1", null]) assert.equal(safePhone(value), null);
  const calls = [], client = createDayClient({ fetchImpl: async path => { calls.push(path); return Response.json({ actor: { slug: "synthetic-partner" }, csrf_token: "synthetic-token" }); } });
  const session = await client.session(); assert.match(session.scope, /^[a-f0-9]{64}$/); assert.equal(client.scope, session.scope);
  assert.equal(client.capabilities.voiceNotes, false); assert.equal(client.submitNote, undefined);
  assert.deepEqual(calls, ["/api/system-work/session"]);
  assert.match(noteState(base()), /Saved on phone.*Filing unavailable/);
});

test("mic denial and storage failure release capture; delayed consent cannot start after disposal", async () => {
  for (const failure of ["mic", "storage"]) {
    const store = memory([]); let micCalls = 0;
    if (failure === "storage") store.put = async () => { throw new Error("quota"); };
    const window = { crypto, navigator: { locks: { request: async (name, options, fn) => fn({ name }) }, mediaDevices: { async getUserMedia() { micCalls++; throw new Error("denied"); } } }, MediaRecorder: class {} };
    const capture = createDayRecorder({ window, store }); await assert.rejects(capture.start(base()));
    assert.equal(capture.active, null); assert.equal(micCalls, failure === "storage" ? 0 : 1);
  }
  let resolveMic, stopped = false;
  const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
  const store = memory([]); const window = { crypto, navigator: { locks: { request: async (name, options, fn) => fn({ name }) }, mediaDevices: { getUserMedia: () => new Promise(r => { resolveMic = r; }) } }, MediaRecorder: class {} };
  const capture = createDayRecorder({ window, store }); const pending = capture.start(base());
  await new Promise(r => setImmediate(r)); capture.dispose(); resolveMic(stream); await pending;
  assert.equal(stopped, true); assert.equal(capture.active, null); assert.equal(store.rows[0].status, "empty");
});

test("day map selection uses canonical IDs, short copy, navigation receipts and online map recovery", async () => {
  const dom = new JSDOM('<section id="map"></section>', { url: "https://synthetic.test/tours/day.html" });
  let online = false, maps = 0, selected = null, allow = true;
  Object.defineProperty(dom.window.navigator, "onLine", { get: () => online });
  class Map { constructor() { maps++; } on() {} resize() {} remove() {} jumpTo() {} flyTo() {} }
  class Marker { constructor({ element }) { this.element = element; } setLngLat() { return this; } addTo() { dom.window.document.body.append(this.element); return this; } remove() { this.element.remove(); } }
  const view = mountAcceptedItinerary(dom.window.document.querySelector("section"), { route, promotion_receipt: mapReceipt, scope: "synthetic", user_ref: "synthetic-user", presentation: "day", canSelect: () => allow, onSelect: id => { selected = id; }, loadMapLibre: async () => ({ Map, Marker, setWorkerUrl() {} }) });
  await view.ready; assert.equal(maps, 0); assert.match(dom.window.document.querySelector("section").textContent, /Map unavailable/);
  online = true; dom.window.dispatchEvent(new dom.window.Event("online")); await new Promise(r => setImmediate(r));
  assert.equal(maps, 1); assert.doesNotMatch(dom.window.document.querySelector("section").textContent, /Source|record|Search Mode|every read/);
  dom.window.document.querySelector('[data-route-stop-id="stop-b"]').click(); assert.equal(selected, "stop-b");
  allow = false; dom.window.document.querySelector('[data-route-stop-id="stop-a"]').click(); assert.equal(selected, "stop-b");
  view.dispatch({ type: "route_stop_change", route_stop_id: "stop-a" }); assert.equal(view.navigationLinks().length, 2);
  view.update({ route, promotion_receipt: null, scope: "synthetic", user_ref: "synthetic-user" }); assert.equal(view.navigationLinks().length, 0);
  view.destroy(); dom.window.close();
});

test("offline tour shell caches every local module dependency", async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('tours/day-sw.js', root), 'utf8');
  const manifest = await readFile(new URL('tours/day-shell.generated.js', root), 'utf8');
  const sandbox = { self: { addEventListener() {} }, importScripts() { runInNewContext(manifest, sandbox); } };
  runInNewContext(source + '\nthis.files = FILES;', sandbox);
  const files = new Set(sandbox.files), checked = new Set();
  async function check(path) {
    if (checked.has(path) || !/\.m?js$/.test(path)) return;
    checked.add(path);
    const source = await readFile(new URL(path.slice(1), root), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
      const relative = match[1];
      if (!relative.startsWith('.') && !relative.startsWith('/')) continue;
      const dependency = new URL(relative, 'https://synthetic.test' + path).pathname;
      assert.ok(files.has(dependency), `${path} needs ${dependency} on offline reload`);
      await check(dependency);
    }
  }
  for (const path of files) await check(path);
});
