import test from "node:test";
import assert from "node:assert/strict";
import { createNoteSync, matchesNote, noteState } from "../tours/day-store.js";
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
const filed = note => ({ ...Object.fromEntries(["id", "tour_id", "client_id", "property_id", "route_version_id", "route_stop_id"].map(k => [k, note[k]])), status: "filed", summary: "Quiet interior; access works.", transcript: "Synthetic original spoken note. Quiet interior. Access works.", tour_feedback_ref: "feedback-1", client_activity_ref: "activity-1" });
const queue = (store, api) => createNoteSync({ store, api, scope: "synthetic-scope", tourId: "tour-1" });

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

test("one immutable note files to both records; duplicate sync callers share one operation", async () => {
  const store = memory(); let submissions = 0;
  const api = { scope: "synthetic-scope", capabilities: { voiceNotes: true }, async submitNote(note) { submissions++; return filed(note); } };
  const sync = queue(store, api); await Promise.all([sync.sync(), sync.sync()]); await sync.sync();
  assert.equal(submissions, 1); assert.equal(store.rows[0].status, "filed"); assert.equal(store.rows[0].audio.size, base().audio.size);
  assert.equal(store.rows[0].transcript, filed(base()).transcript); assert.equal(store.rows[0].summary, filed(base()).summary);
});

test("unknown upload is read before resend; known processing is polled and not uploaded twice", async () => {
  const store = memory(); const events = []; let answer = { ...filed(base()), status: "processing" };
  const api = { scope: "synthetic-scope", capabilities: { voiceNotes: true }, async submitNote(n) { events.push(`submit:${n.id}`); throw new Error("response_lost"); }, async lookupNote(id) { events.push(`read:${id}`); return answer; } };
  const sync = queue(store, api); await sync.sync(); assert.equal(store.rows[0].status, "uncertain");
  await sync.sync(); assert.equal(store.rows[0].status, "processing");
  answer = filed(base()); await sync.sync();
  assert.equal(store.rows[0].status, "filed"); assert.deepEqual(events, ["submit:note-1", "read:note-1", "read:note-1"]);
});

test("only an authoritative absence permits same-id replay after a lost response", async () => {
  const store = memory([{ ...base(), status: "uncertain" }]), events = [];
  const api = { scope: "synthetic-scope", capabilities: { voiceNotes: true }, async lookupNote(id) { events.push(`read:${id}`); return { status: "absent" }; }, async submitNote(n) { events.push(`submit:${n.id}`); return filed(n); } };
  await queue(store, api).sync(); assert.deepEqual(events, ["read:note-1", "submit:note-1"]);
  const other = memory([{ ...base(), status: "syncing" }]); api.lookupNote = async () => { throw new Error("offline"); };
  await queue(other, api).sync(); assert.equal(other.rows[0].status, "uncertain"); assert.equal(events.length, 2);
});

test("wrong receipt bindings, transcript and single-record acknowledgements never claim filed", async () => {
  for (const change of [{ client_id: "other" }, { property_id: "other" }, { route_version_id: "other" }, { transcript: "" }, { client_activity_ref: "" }, { tour_feedback_ref: "" }, { summary: "" }]) {
    const store = memory(); const api = { scope: "synthetic-scope", capabilities: { voiceNotes: true }, async submitNote(n) { return { ...filed(n), ...change }; } };
    await queue(store, api).sync(); assert.equal(store.rows[0].status, "uncertain"); assert.ok(store.rows[0].audio.size);
  }
  assert.equal(matchesNote(base(), filed(base())), true);
});

test("unsupported producer, another account and recordings never upload", async () => {
  for (const [scope, capability, status] of [["synthetic-scope", false, "local"], ["other", true, "local"], ["synthetic-scope", true, "recording"]]) {
    const store = memory([{ ...base(), status }]); const api = { scope, capabilities: { voiceNotes: capability }, submitNote() { assert.fail("must not submit"); } };
    await queue(store, api).sync(); assert.equal(store.rows[0].status, status);
  }
});

test("identity changing while a receipt is in flight cannot acknowledge the previous account", async () => {
  const store = memory(); const api = { scope: "synthetic-scope", capabilities: { voiceNotes: true }, async submitNote(note) { api.scope = "other"; return filed(note); } };
  await queue(store, api).sync(); assert.equal(store.rows[0].status, "uncertain");
});

test("mic denial and storage failure release capture; delayed consent cannot start after disposal", async () => {
  for (const failure of ["mic", "storage"]) {
    const store = memory([]); let micCalls = 0;
    if (failure === "storage") store.put = async () => { throw new Error("quota"); };
    const window = { crypto, navigator: { mediaDevices: { async getUserMedia() { micCalls++; throw new Error("denied"); } } }, MediaRecorder: class {} };
    const capture = createDayRecorder({ window, store }); await assert.rejects(capture.start(base()));
    assert.equal(capture.active, null); assert.equal(micCalls, failure === "storage" ? 0 : 1);
  }
  let resolveMic, stopped = false;
  const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
  const store = memory([]); const window = { crypto, navigator: { mediaDevices: { getUserMedia: () => new Promise(r => { resolveMic = r; }) } }, MediaRecorder: class {} };
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
