import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createTourRouteDraft } from "../tours/route-draft.mjs";
import { domain, properties } from "./fixtures/tour-composer.synthetic.mjs";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function syntheticRoutes(store) {
  async function request(path, body) {
    const response = await store.fetch(path, body ? { method: "POST", headers: { "x-carr-csrf": "synthetic-csrf" }, body: JSON.stringify(body) } : {});
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error), { status: response.status, writeRefusal: Boolean(body) && response.status >= 400 && response.status < 500 });
    return payload.data;
  }
  return { detail: tourId => request(`/api/tours/detail?tour_id=${tourId}`), write: request };
}
async function setup(storage = memoryStorage()) {
  const store = domain();
  const result = await store.fetch("/api/tours/create", { headers: { "x-carr-csrf": "synthetic-csrf" }, body: JSON.stringify({idempotency_key:webcrypto.randomUUID(),tour_name:"Synthetic Tour",subject_type:"work",subject_id:"work:fixture",canonical_dataset_version:"synthetic-v1",start_point:null,end_point:null}) });
  const tourId = (await result.json()).data.tour_id;
  const draft = createTourRouteDraft({ routes: syntheticRoutes(store), storage, crypto: webcrypto });
  await draft.bindSession("synthetic-csrf");
  draft.open(await draft.read(tourId));
  return { draft, store, tourId, storage };
}

test("route draft saves stable property identities and requires a separate acceptance of the reviewed server digest", async () => {
  const { draft, store, tourId } = await setup();
  draft.edit({ type: "add", properties });
  draft.edit({ type: "field", propertyId: properties[0].property_id, field: "route_label", value: "A1" });
  draft.edit({ type: "field", propertyId: properties[1].property_id, field: "stop_state", value: "excluded" });
  await draft.save({ candidates: properties });
  assert.equal(draft.view.phase, "ready");
  assert.equal(draft.view.saved, true);
  assert.equal(store.tours.get(tourId).routes[0].accepted, false);
  assert.deepEqual(draft.view.rows.map(row => [row.property_id, row.route_label, row.route_sequence, row.stop_state]), [[properties[0].property_id,"A1",1,"active"],[properties[1].property_id,"1",null,"excluded"]]);
  const reviewed = draft.view.reviewDigest;
  await draft.accept();
  assert.equal(store.tours.get(tourId).routes[0].accepted, true);
  assert.equal(store.calls.find(call => call.path === "/api/tours/route-accept").body.acceptance_digest, reviewed);
});

test("lost stop response survives reload and only a successful read permits explicit same-key recovery", async () => {
  const { draft, store, tourId, storage } = await setup();
  draft.edit({ type: "add", properties });
  store.fail("/api/tours/route-stop", "lost");
  await draft.save({ candidates: properties });
  const failed = store.calls.find(call => call.path === "/api/tours/route-stop").body;
  const resumed = createTourRouteDraft({ routes: syntheticRoutes(store), storage, crypto: webcrypto });
  await resumed.bindSession("synthetic-csrf");
  assert.equal(resumed.pendingTourId, tourId);
  resumed.open(await resumed.read(tourId));
  assert.equal(resumed.view.phase, "unknown");
  await resumed.recover("retry");
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-stop").length, 1);
  store.fail("/api/tours/detail", "missing");
  await resumed.recover("reconcile");
  assert.equal(resumed.view.phase, "unknown");
  await resumed.recover("reconcile");
  assert.equal(resumed.view.phase, "reconciled");
  await resumed.recover("retry");
  assert.equal(resumed.view.saved, true);
  assert.deepEqual(store.calls.filter(call => call.path === "/api/tours/route-stop")[1].body, failed);
  assert.equal(store.tours.get(tourId).routes[0].stops.length, 2);
  assert.equal(storage.getItem("doctorcre-tour-pending-v1"), null);
});

test("a lost acceptance response is confirmed by read without another acceptance", async () => {
  const { draft, store } = await setup();
  draft.edit({ type: "add", properties }); await draft.save({ candidates: properties });
  store.fail("/api/tours/route-accept", "lost"); await draft.accept();
  assert.equal(draft.view.phase, "unknown");
  await draft.recover("reconcile");
  assert.equal(draft.view.phase, "ready");
  assert.equal(draft.view.saved, false);
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-accept").length, 1);
});

test("refused partial assembly is read before the same transition is resumed", async () => {
  const { draft, store, tourId } = await setup();
  draft.edit({ type: "add", properties });
  store.fail("/api/tours/route-stop-transition", "refused"); await draft.save({ candidates: properties });
  assert.equal(draft.view.phase, "refused");
  await draft.recover("reload"); assert.equal(draft.view.phase, "reconciled");
  assert.equal(draft.view.saved, false);
  await draft.recover("retry");
  assert.equal(draft.view.saved, true);
  const attempts = store.calls.filter(call => call.path === "/api/tours/route-stop-transition");
  assert.deepEqual(attempts[1].body, attempts[0].body);
  assert.equal(store.tours.get(tourId).routes[0].stops.length, 2);
});

for (const status of ["stale", "refused"]) test(`${status} writes retain the draft and forbid fresh-key saves until reload`, async () => {
  const { draft, store } = await setup();
  draft.edit({ type: "add", properties }); store.fail("/api/tours/route-stop", status);
  await draft.save({ candidates: properties });
  assert.equal(draft.view.phase, status);
  const count = store.calls.filter(call => call.body).length;
  await draft.save(); await draft.accept(); await draft.recover("retry");
  assert.equal(store.calls.filter(call => call.body).length, count);
  assert.equal(draft.view.rows.length, 2);
  await draft.recover("reload"); assert.equal(draft.view.phase, "reconciled");
});

for (const invalid of ["label", "minutes", "window", "inactive fixed", "fixed order"]) test(`${invalid} validation refuses before any route write`, async () => {
  const { draft, store } = await setup();
  draft.edit({ type: "add", properties });
  const field = (index, field, value) => draft.edit({type:"field",propertyId:properties[index].property_id,field,value});
  if (invalid === "label") field(1,"route_label","1");
  if (invalid === "minutes") field(0,"dwell_minutes",NaN);
  if (invalid === "window") field(0,"locked_appointment",true);
  if (invalid === "inactive fixed" || invalid === "fixed order") {
    for (const i of [0,1]) {
      field(i,"locked_appointment",true);
      field(i,"appointment_start",i === 0 ? "2026-10-05T10:00:00Z" : "2026-10-05T09:00:00Z");
      field(i,"appointment_end",i === 0 ? "2026-10-05T10:30:00Z" : "2026-10-05T09:30:00Z");
    }
    if (invalid === "inactive fixed") field(1,"stop_state","held");
  }
  await draft.save();
  assert.equal(store.calls.filter(call => call.path.startsWith("/api/tours/route-")).length, 0);
  assert.equal(draft.view.dirty, true);
  assert.equal(draft.view.pending, false);
});

for (const bad of ["wrong Tour", "missing stops", "disagreeing stops"]) test(`${bad} detail cannot enable recovery retry`, async () => {
  const { draft, store } = await setup();
  draft.edit({type:"add",properties}); store.fail("/api/tours/route-stop","lost"); await draft.save();
  const normalFetch = store.fetch;
  store.fetch = async (path, options) => {
    const result = await normalFetch(path, options);
    if (!path.startsWith("/api/tours/detail")) return result;
    return {...result,json:async()=>{
      const payload = await result.json();
      if (bad === "wrong Tour") payload.data.id = webcrypto.randomUUID();
      if (bad === "missing stops") delete payload.data.routes[0].stops;
      if (bad === "disagreeing stops") payload.data.stops = [];
      return payload;
    }};
  };
  const writes = store.calls.filter(call=>call.body).length;
  await draft.recover("reconcile"); await draft.recover("retry");
  assert.equal(draft.view.phase,"unknown");
  assert.equal(store.calls.filter(call=>call.body).length,writes);
});

test("new session clears retained creation and route intents and prevents replay", async () => {
  const { draft, store, storage } = await setup();
  draft.edit({type:"add",properties}); store.fail("/api/tours/route-stop","lost"); await draft.save();
  const posts = store.calls.filter(call=>call.body).length;
  assert.equal(await draft.bindSession("changed-session"), true);
  await draft.recover("reconcile"); await draft.recover("retry");
  assert.equal(draft.view.phase,"session-changed");
  assert.equal(draft.view.pending,false);
  assert.equal(storage.getItem("doctorcre-tour-pending-v1"),null);
  assert.equal(store.calls.filter(call=>call.body).length,posts);
  draft.retainCreation({idempotency_key:webcrypto.randomUUID()});
  await draft.bindSession("third-session");
  assert.equal(draft.pendingCreation,null);
});

test("review digest remains bound to displayed stops and a missing digest withholds acceptance", async () => {
  const { draft, store, tourId } = await setup();
  draft.edit({type:"add",properties}); await draft.save();
  const reviewed = draft.view.reviewDigest;
  store.tours.get(tourId).routes[0].stops[0].dwell_minutes = 99;
  store.fail("/api/tours/route-accept", "stale");
  await draft.accept();
  assert.equal(store.calls.find(call=>call.path==="/api/tours/route-accept").body.acceptance_digest, reviewed);
  assert.equal(draft.view.phase,"stale");
  await draft.recover("reload");
  const detail = await draft.read(tourId); delete detail.routes[0].acceptance_digest;
  draft.open(detail);
  const count = store.calls.filter(call=>call.path==="/api/tours/route-accept").length;
  await draft.accept();
  assert.equal(store.calls.filter(call=>call.path==="/api/tours/route-accept").length,count);
});

test("accepted-route edits require endpoints and preserve fixed timing, inactive identity and transitions", async () => {
  const { draft, store, tourId } = await setup();
  draft.edit({type:"add",properties});
  const edit = (index,field,value) => draft.edit({type:"field",propertyId:properties[index].property_id,field,value});
  edit(0,"appointment_start","2026-10-05T09:00:00Z"); edit(0,"appointment_end","2026-10-05T09:45:00Z"); edit(0,"locked_appointment",true);
  await draft.save(); await draft.accept();
  const prior = store.tours.get(tourId).routes[0];
  edit(1,"stop_state","held");
  await draft.save();
  assert.equal(draft.view.notice,"point-invalid");
  assert.equal(store.tours.get(tourId).routes.length,1);
  const endpoints = { start:{latitude:"30.5",longitude:"-87.2",source:"fixture:start"},end:{latitude:"30.6",longitude:"-87.3",source:"fixture:end"} };
  draft.edit({type:"endpoints",values:endpoints});
  edit(1,"route_label","B2"); draft.edit({type:"undo"});
  assert.equal(draft.view.rows[1].route_label,"2");
  assert.deepEqual(draft.view.endpoints,endpoints);
  await draft.save({ endpoints });
  const detail = await draft.read(tourId), current = detail.routes[0];
  assert.equal(current.route_version,2);
  assert.equal(current.stops[0].appointment_start,prior.stops[0].appointment_start);
  assert.equal(current.stops[0].appointment_end,prior.stops[0].appointment_end);
  assert.equal(current.stops[0].locked_appointment,true);
  assert.equal(current.stops[1].property_id,properties[1].property_id);
  assert.equal(current.stops[1].route_label,null);
  assert.equal(current.stops[1].route_sequence,null);
  await draft.accept();
  assert.equal(store.tours.get(tourId).routes[0].accepted,true);
});

test("failed post-write detail keeps the outcome unknown and resumes by readback without resending completed stops", async () => {
  const { draft, store } = await setup();
  draft.edit({type:"add",properties}); store.fail("/api/tours/detail","missing"); await draft.save();
  assert.equal(draft.view.phase,"unknown");
  assert.equal(draft.view.pending,true);
  const count = store.calls.filter(call=>call.body).length;
  await draft.recover("reconcile"); await draft.recover("retry");
  assert.equal(draft.view.saved,true);
  assert.equal(store.calls.filter(call=>call.body).length,count);
});
