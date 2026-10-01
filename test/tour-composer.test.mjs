import { mapScript } from "./tours-map-script.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { webcrypto, createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";

const html = await readFile(new URL("../tours/index.html", import.meta.url), "utf8");
const format = (await readFile(new URL("../tours/tour-format.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const panel = (await readFile(new URL("../tours/property-panel.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const app = (await readFile(new URL("../tours/app.js", import.meta.url), "utf8")).replace(/^import [^\n]*\n/gm, "");
const script = `${mapScript}\n${format}\nconst mountPropertyPanel = (() => { ${panel}\nreturn mountPropertyPanel; })();\n${app}`;
const uuid = () => webcrypto.randomUUID();
const propA = "44444444-4444-4444-8444-444444444444", propB = "55555555-5555-4555-8555-555555555555";
const properties = [propA, propB].map((property_id, i) => ({ property_id, name: `Synthetic site ${i + 1}`, address: `${100 + i} Example Way`, county: "Escambia", state: "FL" }));
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

for (const failure of ["503", "timeout", "malformed"]) test(`automatic itinerary restoration surfaces ${failure} and permits explicit retry`, async () => {
  const store = domain(), tourId = uuid();
  store.tours.set(tourId, { id: tourId, name: "Synthetic restored Tour", routes: [{ id: uuid(), route_version: 1, accepted: false, stops: [] }] });
  const normalFetch = store.fetch; let reads = 0, fail = true;
  store.fastTimeout = failure === "timeout";
  store.fetch = async (path, options) => {
    if (path.startsWith("/api/tours/detail")) {
      ++reads;
      if (fail) {
        if (failure === "timeout") return new Promise(() => {});
        return failure === "503" ? response(null, 503) : response({ id: "invalid" });
      }
    }
    return normalFetch(path, options);
  };
  const scope = `sha256:${createHash("sha256").update("synthetic-csrf").digest("hex")}`;
  const { dom, doc } = await open(store, { "doctorcre-itinerary-tour-v1": JSON.stringify({ scope, tour_id: tourId }) });
  assert.equal(reads, 1);
  assert.match(doc.querySelector("#status").textContent, /Saved Tour unavailable.*select.*retry/i);
  assert.equal(doc.querySelector("#create-tour").disabled, false);
  fail = false; doc.querySelector(".tour-button").click(); await settle();
  assert.equal(reads, 2); assert.match(doc.querySelector("#status").textContent, /Tour ready/);
  dom.window.close();
});
test("composer contracts pin the exact server PR revision and each authenticated assembly route", async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  assert.equal(contract.schema, "doctorcre-tour-composer.v1");
  assert.equal(contract.producer.source_commit, "ff7251b5dab04e5a73c614d712bf0d16fd3d7a33");
  assert.equal(contract.producer.pull_request, "https://github.com/jbookout/carr-system/pull/1453");
  assert.deepEqual(Object.keys(contract.writes), ["/api/tours/create", "/api/tours/route-draft", "/api/tours/route-stop", "/api/tours/route-stop-transition", "/api/tours/route-accept"]);
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc); await saveAndAccept(doc);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "B2"); doc.querySelector("#save-composer").click(); await settle();
  for (const call of store.calls.filter(call => contract.writes[call.path])) assert.deepEqual(Object.keys(call.body).sort(), [...contract.writes[call.path].fields].sort(), call.path);
  dom.window.close();
});
function response(data, status = 200) { return { ok: status < 400, status, json: async () => status < 400 ? { data, csrf_token: "synthetic-csrf" } : { error: status === 409 ? "conflict" : status === 404 ? "not_found" : "tour_unavailable" } }; }
function fixtureReviewDigest(route) { return `sha256:${createHash("sha256").update(JSON.stringify({ route_id: route.id, stops: route.stops })).digest("hex")}`; }
function domain() {
  const tours = new Map(), replay = new Map(), calls = [], transitions = [];
  let fault = null;
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body, options });
    if (body) assert.equal(options.headers["x-carr-csrf"], "synthetic-csrf");
    if (path === "/api/tours/library") return response({ tours: [...tours.values()].map(t => ({ id: t.id, name: t.name, status: "draft" })) });
    if (path.startsWith("/api/tours/detail")) {
      if (fault?.path === "/api/tours/detail") { const status = fault.kind === "missing" ? 404 : 503; fault = null; return response(null, status); }
      const tour = tours.get(new URL(path, "https://example.test").searchParams.get("tour_id"));
      if (!tour) return response(null, 404);
      const latest = tour.routes[0], accepted = tour.routes.find(r => r.accepted);
      const reviewed = structuredClone(tour);
      for (const route of reviewed.routes) route.acceptance_digest = fixtureReviewDigest(route);
      return response({ ...reviewed, route_version: accepted?.route_version || 1,
        route_version_id: latest.id, route_version_state: latest.accepted ? "accepted" : "draft",
        accepted_route_version: accepted?.route_version || 0, stops: structuredClone(latest.stops) });
    }
    if (path.startsWith("/api/tours/selection-cart?")) return response(null, 404);
    if (path === "/api/tours/properties/search") return response({ search: { items: properties, has_more: false } });
    if (path.startsWith("/api/tours/property-evidence")) return response({ schema: "tour-property-evidence.v1", facts: {} });
    if (fault?.path === path && fault.kind === "stale") { fault = null; return response(null, 409); }
    if (fault?.path === path && fault.kind === "refused") { fault = null; return response(null, 403); }
    if (replay.has(body?.idempotency_key)) {
      const previous = replay.get(body.idempotency_key);
      return JSON.stringify(body) === previous.body ? response(previous.result) : response(null, 409);
    }
    let result;
    if (path === "/api/tours/create") {
      assert.deepEqual(Object.keys(body).sort(), ["idempotency_key", "tour_name", "subject_type", "subject_id", "canonical_dataset_version", "start_point", "end_point"].sort());
      const id = uuid(); tours.set(id, { id, name: body.tour_name, routes: [{ id: uuid(), route_version: 1, accepted: false, stops: [] }] }); result = { tour_id: id };
    } else if (path === "/api/tours/route-draft") {
      const t = tours.get(body.tour_id), prior = t.routes.find(r => r.accepted);
      if (prior?.id !== body.base_route_version_id || prior.route_version !== body.expected_route_version || body.route_version !== t.routes[0].route_version + 1) return response(null, 409);
      const route = { id: uuid(), route_version: body.route_version, accepted: false, stops: [] }; t.routes.unshift(route); result = { route_version_id: route.id };
    } else if (path === "/api/tours/route-stop") {
      const r = [...tours.values()].flatMap(t => t.routes).find(r => r.id === body.route_version_id);
      if (r.accepted) return response(null, 409);
      if (body.stop_state === "active") {
        assert.ok(Number.isInteger(body.route_sequence) && body.route_sequence > 0);
        assert.match(body.route_label, /^[A-Za-z0-9._ -]{1,80}$/);
        assert.ok(!r.stops.some(s => s.route_sequence === body.route_sequence || s.route_label === body.route_label));
      } else { assert.equal(body.route_sequence, null); assert.equal(body.route_label, null); }
      const stop = { ...body, id: uuid(), name: properties.find(p => p.property_id === body.property_id)?.name }; r.stops.push(stop); result = { route_stop_id: stop.id };
    } else if (path === "/api/tours/route-stop-transition") {
      transitions.push(body); result = { route_stop_transition_id: uuid() };
    } else if (path === "/api/tours/route-accept") {
      const t = [...tours.values()].find(t => t.routes.some(r => r.id === body.route_version_id));
      const r = t.routes.find(r => r.id === body.route_version_id), prior = t.routes.find(r => r.accepted);
      if ((prior?.route_version || 0) !== body.expected_prior_route_version) return response(null, 409);
      assert.equal(body.acceptance_digest, fixtureReviewDigest(r));
      assert.ok(r.stops.some(s => s.stop_state === "active"));
      assert.ok(r.stops.every(s => transitions.some(x => x.new_route_stop_id === s.id && x.new_route_version_id === r.id)));
      if (prior) {
        assert.ok(prior.stops.every(s => transitions.some(x => x.old_route_stop_id === s.id && x.new_route_version_id === r.id)));
        assert.ok(prior.stops.filter(s => s.locked_appointment).every(old => r.stops.some(s => s.property_id === old.property_id && s.stop_state === "active" &&
          ["locked_appointment", "appointment_start", "appointment_end", "dwell_minutes", "buffer_minutes"].every(field => s[field] === old[field]))));
      }
      r.accepted = true; result = { route_version_acceptance_id: uuid() };
    } else throw new Error(`Unexpected path: ${path}`);
    replay.set(body.idempotency_key, { body: JSON.stringify(body), result });
    if (fault?.path === path && fault.kind === "lost") { fault = null; throw new Error("response lost"); }
    return response(result);
  };
  return { tours, calls, transitions, fetch, fail(path, kind) { fault = { path, kind }; } };
}
async function open(store, storage = {}) {
  const dom = new JSDOM(html, { url: "https://app.doctorcre.com/tours", runScripts: "outside-only" });
  Object.defineProperty(dom.window, "crypto", { value: webcrypto }); dom.window.TextEncoder = TextEncoder; dom.window.fetch = store.fetch;
  if (store.fastTimeout) { const timeout = dom.window.setTimeout.bind(dom.window); dom.window.setTimeout = (fn, delay) => timeout(fn, delay === 15000 ? 0 : delay); }
  for (const [key, value] of Object.entries(storage)) dom.window.sessionStorage.setItem(key, value);
  dom.window.eval(script); await settle();
  return { dom, doc: dom.window.document };
}
function fill(doc, selector, value) { const node = doc.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new doc.defaultView.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }
function deferDetail(store) {
  const fetch = store.fetch; let release;
  store.fetch = async (path, options) => {
    if (!path.startsWith("/api/tours/detail")) return fetch(path, options);
    store.fetch = fetch;
    const result = await fetch(path, options);
    await new Promise(resolve => { release = resolve; }); return result;
  };
  return () => release();
}
async function create(doc, type = "work") {
  fill(doc, "#create-tour-name", "Synthetic Tour"); fill(doc, "#create-subject-type", type); fill(doc, "#create-subject-id", `${type}:fixture`);
  fill(doc, "#create-dataset", "synthetic-v1");
  for (const role of ["start", "end"]) { fill(doc, `#${role}-latitude`, "30.5"); fill(doc, `#${role}-longitude`, "-87.2"); fill(doc, `#${role}-source`, `fixture:${role}`); }
  doc.querySelector("#create-tour-form").requestSubmit(); await settle();
}

for (const type of ["client", "work"]) test(`create a Tour bound to a ${type} and reload its initial draft`, async () => {
  const store = domain(), { dom, doc } = await open(store);
  await create(doc, type);
  assert.equal(store.tours.size, 1);
  assert.equal(doc.querySelector("#tour-name").textContent, "Synthetic Tour");
  assert.equal(store.calls.find(c => c.path === "/api/tours/create").body.subject_type, type);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-accept").length, 0);
  dom.window.close();
  const next = await open(store); next.doc.querySelector(".tour-button").click(); await settle();
  assert.equal(next.doc.querySelector("#tour-name").textContent, "Synthetic Tour"); next.dom.window.close();
});

async function addCart(doc) {
  doc.querySelector("#property-search-form").requestSubmit(); await settle();
  for (const button of doc.querySelectorAll("#property-results button[data-property-id]")) button.click();
  doc.querySelector("#add-cart-stops").click(); await settle();
}
test("cart stops keep property identity separate, save timing and exclusions, and require explicit acceptance", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  const row = doc.querySelector(`#route-stops [data-property-id="${propA}"]`);
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="route_label"]`, "A1");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="dwell_minutes"]`, "45");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="buffer_minutes"]`, "15");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_start"]`, "2026-10-05T09:00");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_end"]`, "2026-10-05T09:45");
  row.querySelector('[data-field="locked_appointment"]').click();
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="stop_state"]`, "excluded");
  assert.match(doc.querySelector("#route-changes").textContent, /Synthetic site 2.*excluded/i);
  doc.querySelector("#save-composer").click(); await settle();
  const saved = store.calls.filter(c => c.path === "/api/tours/route-stop").map(c => c.body);
  assert.equal(saved.length, 2); assert.equal(saved[0].property_id, propA); assert.equal(saved[0].route_label, "A1");
  assert.equal(saved[0].dwell_minutes, 45); assert.equal(saved[0].buffer_minutes, 15); assert.equal(saved[0].locked_appointment, true);
  assert.ok(saved[0].appointment_start.endsWith("Z"));
  assert.equal(saved[1].stop_state, "excluded"); assert.equal(saved[1].route_label, null); assert.equal(saved[1].route_sequence, null);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-accept").length, 0);
  assert.equal(doc.querySelector("#accept-route").disabled, true);
  doc.querySelector("#route-reviewed").click();
  assert.equal(doc.querySelector("#accept-route").disabled, false);
  doc.querySelector("#accept-route").click(); await settle();
  assert.equal([...store.tours.values()][0].routes[0].accepted, true);
  dom.window.close();
  const next = await open(store); next.doc.querySelector(".tour-button").click(); await settle();
  assert.match(next.doc.querySelector("#route-stops").textContent, /Excluded/);
  assert.equal(next.doc.querySelector('[data-field="dwell_minutes"]').value, "45"); next.dom.window.close();
});

async function saveAndAccept(doc) {
  doc.querySelector("#save-composer").click(); await settle();
  doc.querySelector("#route-reviewed").click(); doc.querySelector("#accept-route").click(); await settle();
}
test("review 1: a changed same-Tour read invalidates review and displays the target route", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  doc.querySelector("#save-composer").click(); await settle(); doc.querySelector("#route-reviewed").click();
  const tour = [...store.tours.values()][0];
  tour.routes.unshift({ ...structuredClone(tour.routes[0]), id: uuid(), route_version: 2 });
  tour.routes[0].stops[0].route_label = "Changed elsewhere";
  doc.querySelector(".tour-button").click(); await settle();
  assert.equal(doc.querySelector("#route-reviewed").checked, false);
  assert.equal(doc.querySelector('[data-field="route_label"]').value, "Changed elsewhere");
  doc.querySelector("#accept-route").click(); await settle();
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-accept").length, 0);
  dom.window.close();
});
test("review 4: Reload serializes edits and writes until its captured read settles", async () => {
  const store = domain(), fetch = store.fetch;
  const proxy = { fetch: (...args) => store.fetch(...args) };
  const { dom, doc } = await open(proxy); await create(doc); await addCart(doc); await saveAndAccept(doc);
  const release = deferDetail(store); doc.querySelector("#reload-composer").click(); await settle();
  assert.equal(doc.querySelector('[data-field="route_label"]').disabled, true);
  assert.equal(doc.querySelector("#save-composer").disabled, true);
  const writes = store.calls.filter(c => c.body).length;
  doc.querySelector("#save-composer").click(); await settle();
  assert.equal(store.calls.filter(c => c.body).length, writes);
  release(); await settle(); assert.equal(doc.querySelector('[data-field="route_label"]').disabled, false);
  store.fetch = fetch; dom.window.close();
});
test("review 5: Tour navigation locks the outgoing composer against intervening edits", async () => {
  const store = domain(), { dom, doc } = await open({ fetch: (...args) => store.fetch(...args) });
  await create(doc); await addCart(doc); await saveAndAccept(doc); await create(doc);
  const tours = [...store.tours.values()]; doc.querySelector(".tour-button").click(); await settle();
  const release = deferDetail(store); doc.querySelectorAll(".tour-button")[1].click(); await settle();
  assert.equal(doc.querySelector('[data-field="route_label"]').disabled, true);
  fill(doc, '[data-field="route_label"]', "Intervening edit");
  release(); await settle(); assert.equal(doc.querySelector("#tour-name").textContent, tours[1].name);
  doc.querySelector(".tour-button").click(); await settle();
  assert.equal(doc.querySelector('[data-field="route_label"]').value, "1"); dom.window.close();
});
for (const kind of ["create", "composer"]) test(`review 2: ${kind} intent cannot retry under a changed authenticated session`, async () => {
  const store = domain(); let changed = false;
  const { dom, doc } = await open({ fetch: async (...args) => {
    const result = await store.fetch(...args);
    if (!changed) return result;
    return { ...result, json: async () => ({ ...await result.json(), csrf_token: "second-session" }) };
  } });
  if (kind === "create") { store.fail("/api/tours/create", "lost"); await create(doc); }
  else { await create(doc); await addCart(doc); store.fail("/api/tours/route-stop", "lost"); doc.querySelector("#save-composer").click(); await settle(); }
  const posts = store.calls.filter(c => c.body).length; changed = true;
  doc.querySelector(kind === "create" ? "#reconcile-create" : "#reconcile-composer").click(); await settle();
  if (kind === "create") assert.equal(doc.querySelector("#create-tour").textContent.includes("Retry"), false);
  else assert.equal(doc.querySelector("#retry-composer").hidden, true);
  assert.equal(store.calls.filter(c => c.body).length, posts);
  assert.equal(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), null);
  dom.window.close();
});
test("review 3: boot surfaces a pending composer before another Tour can erase its journal", async () => {
  const store = domain(), first = await open(store); await create(first.doc); await create(first.doc);
  first.doc.querySelector(".tour-button").click(); await settle(); await addCart(first.doc);
  store.fail("/api/tours/route-stop", "lost"); first.doc.querySelector("#save-composer").click(); await settle();
  const retained = first.dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"); first.dom.window.close();
  const next = await open(store, { "doctorcre-tour-pending-v1": retained });
  assert.equal(next.doc.querySelector("#reconcile-composer").hidden, false);
  next.doc.querySelectorAll(".tour-button")[1].click(); await settle(); await create(next.doc);
  assert.equal(next.dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), retained);
  assert.equal(store.tours.size, 2); next.dom.window.close();
});
test("review 3: a failed boot library cannot expose writes that replace a retained composer", async () => {
  const store = domain(), first = await open(store); await create(first.doc); await addCart(first.doc);
  store.fail("/api/tours/route-stop", "lost"); first.doc.querySelector("#save-composer").click(); await settle();
  const retained = first.dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"); first.dom.window.close();
  const next = await open({ fetch: (path, options) => path === "/api/tours/library" ? response({}) : store.fetch(path, options) }, { "doctorcre-tour-pending-v1": retained });
  assert.equal(next.doc.querySelector("#create-tour").disabled, true);
  await create(next.doc);
  assert.equal(store.tours.size, 1);
  assert.equal(next.dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), retained); next.dom.window.close();
});
test("review 6: Reload after a refused transition preserves and resumes partial assembly", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  store.fail("/api/tours/route-stop-transition", "refused"); doc.querySelector("#save-composer").click(); await settle();
  const retained = dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1");
  const tour = [...store.tours.values()][0]; assert.equal(tour.routes[0].stops.length, 1);
  doc.querySelector("#reload-composer").click(); await settle();
  assert.equal(doc.querySelector("#retry-composer").hidden, false);
  assert.equal(doc.querySelector("#accept-route").disabled, true);
  assert.equal(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), retained);
  doc.querySelector("#retry-composer").click(); await settle();
  assert.equal(tour.routes[0].stops.length, 2);
  const transitions = store.calls.filter(c => c.path === "/api/tours/route-stop-transition");
  assert.deepEqual(transitions[0].body, transitions[1].body);
  doc.querySelector("#route-reviewed").click(); doc.querySelector("#accept-route").click(); await settle();
  assert.equal(tour.routes[0].accepted, true); dom.window.close();
});
for (const artifact of ["library", "truncated detail", "wrong Tour", "partial route"]) test(`review 7: ${artifact} is a failed reconciliation artifact`, async () => {
  const store = domain(); let malformed = false;
  const { dom, doc } = await open({ fetch: async (path, options) => {
    if (malformed && (artifact === "library" ? path === "/api/tours/library" : path.startsWith("/api/tours/detail"))) {
      if (artifact === "truncated detail") return { ok: true, status: 200, json: async () => { throw new SyntaxError("truncated"); } };
      if (artifact === "library") return response({});
      const data = (await (await store.fetch(path, options)).json()).data;
      if (artifact === "wrong Tour") data.id = uuid(); else delete data.routes[0].stops;
      return response(data);
    }
    return store.fetch(path, options);
  } });
  if (artifact === "library") { store.fail("/api/tours/create", "lost"); await create(doc); }
  else { await create(doc); await addCart(doc); store.fail("/api/tours/route-stop", "lost"); doc.querySelector("#save-composer").click(); await settle(); }
  const retained = dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), posts = store.calls.filter(c => c.body).length;
  malformed = true; doc.querySelector(artifact === "library" ? "#reconcile-create" : "#reconcile-composer").click(); await settle();
  assert.equal(artifact === "library" ? doc.querySelector("#create-tour").disabled : doc.querySelector("#retry-composer").hidden, true);
  assert.equal(store.calls.filter(c => c.body).length, posts);
  assert.equal(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), retained); dom.window.close();
});
test("review 7: projected display fields may differ from raw route history", async () => {
  const store = domain(), { dom, doc } = await open({ fetch: async (path, options) => {
    const result = await store.fetch(path, options);
    if (!path.startsWith("/api/tours/detail")) return result;
    const data = (await result.json()).data;
    data.stops = data.stops.map(stop => ({ ...stop, label: `${stop.route_label} · Synthetic display` }));
    return response(data);
  } });
  await create(doc); await addCart(doc); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Draft saved/); dom.window.close();
});
for (const inactive of ["held", "excluded"]) test(`review 8: an initial ${inactive} fixed appointment is rejected before assembly`, async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  const row = `#route-stops [data-property-id="${propB}"]`;
  fill(doc, `${row} [data-field="appointment_start"]`, "2026-10-05T09:00");
  fill(doc, `${row} [data-field="appointment_end"]`, "2026-10-05T09:45");
  doc.querySelector(`${row} [data-field="locked_appointment"]`).click(); fill(doc, `${row} [data-field="stop_state"]`, inactive);
  doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /fixed appointment.*active/i);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-stop").length, 0);
  fill(doc, `${row} [data-field="stop_state"]`, "active"); await saveAndAccept(doc);
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="route_label"]`, "A2"); await saveAndAccept(doc);
  assert.equal([...store.tours.values()][0].routes[0].route_version, 2);
  assert.equal([...store.tours.values()][0].routes[0].accepted, true); dom.window.close();
});
for (const lost of ["acceptance", "readback"]) test(`review 9: ${lost} confirms the accepted target after a newer draft opens`, async () => {
  const store = domain(); let advance = false;
  const { dom, doc } = await open({ fetch: async (path, options) => {
    if (advance && path.startsWith("/api/tours/detail")) {
      advance = false; const tour = [...store.tours.values()][0];
      tour.routes.unshift({ id: uuid(), route_version: 2, accepted: false, stops: [] });
    }
    return store.fetch(path, options);
  } });
  await create(doc); await addCart(doc); doc.querySelector("#save-composer").click(); await settle(); doc.querySelector("#route-reviewed").click();
  if (lost === "acceptance") store.fail("/api/tours/route-accept", "lost"); else advance = true;
  doc.querySelector("#accept-route").click(); await settle();
  if (lost === "acceptance") { advance = true; doc.querySelector("#reconcile-composer").click(); await settle(); }
  assert.match(doc.querySelector("#composer-state").textContent, /(?:Reconciled.*accepted|Route accepted)/);
  assert.equal(doc.querySelector("#reconcile-composer").hidden, true);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-accept").length, 1);
  assert.equal(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"), null); dom.window.close();
});
test("review 10: endpoint-only edits appear in review, support undo, and save a new version", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc); await saveAndAccept(doc);
  fill(doc, "#edit-start-latitude", "30.7");
  assert.equal(doc.querySelector("#save-composer").disabled, false);
  assert.match(doc.querySelector("#route-changes").textContent, /Start endpoint changed/);
  doc.querySelector("#undo-route").click(); assert.equal(doc.querySelector("#edit-start-latitude").value, "30.5");
  fill(doc, "#edit-start-latitude", "30.7"); doc.querySelector("#save-composer").click(); await settle();
  assert.equal(store.calls.find(c => c.path === "/api/tours/route-draft").body.start_point.latitude, 30.7);
  assert.match(doc.querySelector("#route-changes").textContent, /Start endpoint changed/);
  doc.querySelector("#route-reviewed").click(); doc.querySelector("#accept-route").click(); await settle();
  assert.equal([...store.tours.values()][0].routes[0].accepted, true); dom.window.close();
});
test("review 10: endpoint review survives reload of an unresolved version save", async () => {
  const store = domain(), first = await open(store); await create(first.doc); await addCart(first.doc); await saveAndAccept(first.doc);
  fill(first.doc, "#edit-start-latitude", "30.7"); store.fail("/api/tours/route-stop", "lost");
  first.doc.querySelector("#save-composer").click(); await settle();
  const retained = first.dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"); first.dom.window.close();
  const next = await open(store, { "doctorcre-tour-pending-v1": retained });
  assert.equal(next.doc.querySelector("#edit-start-latitude").value, "30.7");
  assert.match(next.doc.querySelector("#route-changes").textContent, /Start endpoint changed/);
  next.doc.querySelector("#reconcile-composer").click(); await settle(); next.doc.querySelector("#retry-composer").click(); await settle();
  assert.match(next.doc.querySelector("#composer-state").textContent, /Draft saved/);
  assert.equal(next.doc.querySelector("#edit-start-latitude").value, "30.7"); next.dom.window.close();
});
for (const hung of ["creation", "stop", "reconciliation"]) test(`review 11: a non-settling ${hung} request times out without resending`, async () => {
  const store = domain(); let hang = false, hungCalls = 0;
  const pathToHang = hung === "creation" ? "/api/tours/create" : hung === "stop" ? "/api/tours/route-stop" : "/api/tours/detail";
  const { dom, doc } = await open({ fetch: async (path, options) => {
    if (hang && path.startsWith(pathToHang)) { hungCalls++; return new Promise(() => {}); }
    return store.fetch(path, options);
  } });
  if (hung !== "creation") { await create(doc); await addCart(doc); }
  // Accelerate only the production request deadline; preserve normal scheduling.
  const originalTimer = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 15000 ? 1 : ms, ...args);
  if (hung === "creation") { hang = true; await create(doc); }
  else {
    if (hung === "reconciliation") store.fail("/api/tours/route-stop", "lost"); else hang = true;
    doc.querySelector("#save-composer").click(); await settle();
    if (hung === "reconciliation") { hang = true; doc.querySelector("#reconcile-composer").click(); await settle(); }
  }
  assert.equal(hungCalls, 1);
  const reconcile = doc.querySelector(hung === "creation" ? "#reconcile-create" : "#reconcile-composer");
  assert.equal(reconcile.hidden, false);
  assert.equal(hung === "creation" ? doc.querySelector("#create-tour").disabled : doc.querySelector("#retry-composer").hidden, true);
  assert.ok(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"));
  hang = false; reconcile.click(); await settle();
  assert.equal(hung === "creation" ? doc.querySelector("#create-tour").disabled : doc.querySelector("#retry-composer").hidden, false);
  assert.equal(hungCalls, 1); dom.window.close();
});
test("editing an accepted route records held stops and every changed order, then reloads the saved draft", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc); await saveAndAccept(doc);
  const prior = [...store.tours.values()][0].routes[0];
  doc.querySelector(`#route-stops [data-property-id="${propB}"] .stop-controls button`).click();
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="stop_state"]`, "held");
  assert.match(doc.querySelector("#route-changes").textContent, /order 2 → 1/);
  assert.match(doc.querySelector("#route-changes").textContent, /active → held/);
  doc.querySelector("#save-composer").click(); await settle();
  const draft = [...store.tours.values()][0].routes[0];
  assert.equal(draft.route_version, 2); assert.equal(draft.accepted, false); assert.equal(prior.stops[0].stop_state, "active");
  assert.deepEqual(store.transitions.filter(x => x.new_route_version_id === draft.id).map(x => x.disposition), ["reordered", "held"]);
  dom.window.close();
  const next = await open(store); next.doc.querySelector(".tour-button").click(); await settle();
  assert.match(next.doc.querySelector("#route-changes").textContent, /order 2 → 1/);
  assert.match(next.doc.querySelector("#route-changes").textContent, /active → held/);
  next.doc.querySelector("#route-reviewed").click(); next.doc.querySelector("#accept-route").click(); await settle();
  assert.equal(draft.accepted, true); next.dom.window.close();
});
test("stale version refusal preserves edits, prevents acceptance and fresh-key retries, and permits deliberate reload", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc); await saveAndAccept(doc);
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="dwell_minutes"]`, "55");
  store.fail("/api/tours/route-draft", "stale"); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /refused.*draft remains/i);
  assert.equal(doc.querySelector('[data-field="dwell_minutes"]').value, "55");
  assert.equal(doc.querySelector("#save-composer").disabled, true); assert.equal(doc.querySelector("#accept-route").disabled, true);
  assert.equal(doc.querySelector("#retry-composer").hidden, true);
  doc.querySelector("#reload-composer").click(); await settle();
  assert.equal(doc.querySelector('[data-field="dwell_minutes"]').value, "30");
  assert.match(doc.querySelector("#composer-state").textContent, /reloaded/); dom.window.close();
});
test("lost stop response requires a successful reconciliation read and retries the same request without duplicates", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  store.fail("/api/tours/route-stop", "lost"); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Outcome unknown/);
  assert.equal(doc.querySelector("#retry-composer").hidden, true); assert.equal(doc.querySelector("#accept-route").disabled, true);
  const callsBeforeRead = store.calls.filter(c => c.path === "/api/tours/route-stop").length;
  doc.querySelector("#reconcile-composer").click(); await settle();
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-stop").length, callsBeforeRead);
  doc.querySelector("#retry-composer").click(); doc.querySelector("#retry-composer").click(); await settle();
  const stopCalls = store.calls.filter(c => c.path === "/api/tours/route-stop");
  assert.deepEqual(stopCalls[0].body, stopCalls[1].body);
  assert.equal([...store.tours.values()][0].routes[0].stops.length, 2);
  assert.match(doc.querySelector("#composer-state").textContent, /Draft saved/); dom.window.close();
});
test("lost acceptance response is visibly reconciled without sending another acceptance", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  doc.querySelector("#save-composer").click(); await settle(); doc.querySelector("#route-reviewed").click();
  store.fail("/api/tours/route-accept", "lost"); doc.querySelector("#accept-route").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Outcome unknown/);
  doc.querySelector("#reconcile-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Reconciled.*accepted/);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-accept").length, 1); dom.window.close();
});
test("unknown creation outcome cannot retry before checking the library; the retained key creates one Tour", async () => {
  const store = domain(), { dom, doc } = await open(store);
  store.fail("/api/tours/create", "lost"); await create(doc);
  assert.match(doc.querySelector("#create-tour-state").textContent, /outcome unknown/i);
  assert.equal(doc.querySelector("#create-tour").disabled, true);
  doc.querySelector("#reconcile-create").click(); await settle();
  doc.querySelector("#create-tour-form").requestSubmit(); await settle();
  const creates = store.calls.filter(c => c.path === "/api/tours/create");
  assert.deepEqual(creates[0].body, creates[1].body); assert.equal(store.tours.size, 1); dom.window.close();
});
test("reloading after a lost stop response retains the pending plan and still requires reconciliation", async () => {
  const store = domain(), first = await open(store); await create(first.doc); await addCart(first.doc);
  store.fail("/api/tours/route-stop-transition", "lost"); first.doc.querySelector("#save-composer").click(); await settle();
  const storage = Object.fromEntries(Object.keys(first.dom.window.sessionStorage).map(key => [key, first.dom.window.sessionStorage.getItem(key)]));
  assert.ok(Object.keys(storage).length); first.dom.window.close();
  const next = await open(store, storage); next.doc.querySelector(".tour-button").click(); await settle();
  assert.match(next.doc.querySelector("#composer-state").textContent, /Outcome unknown/);
  assert.equal(next.doc.querySelector("#accept-route").disabled, true);
  next.doc.querySelector("#reconcile-composer").click(); await settle(); next.doc.querySelector("#retry-composer").click(); await settle();
  assert.equal([...store.tours.values()][0].routes[0].stops.length, 2);
  const transitions = store.calls.filter(c => c.path === "/api/tours/route-stop-transition");
  assert.deepEqual(transitions[0].body, transitions[1].body); next.dom.window.close();
});
test("refused writes keep the draft and fixed appointments cannot be held or edited on later versions", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_start"]`, "2026-10-05T09:00");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_end"]`, "2026-10-05T09:45");
  doc.querySelector('[data-field="locked_appointment"]').click(); await saveAndAccept(doc);
  const fixed = doc.querySelector(`#route-stops [data-property-id="${propA}"]`);
  for (const field of ["stop_state", "appointment_start", "appointment_end", "locked_appointment", "dwell_minutes", "buffer_minutes"])
    assert.equal(fixed.querySelector(`[data-field="${field}"]`).disabled, true, field);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "B2");
  store.fail("/api/tours/route-draft", "refused"); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Write refused.*draft remains/);
  assert.equal(doc.querySelector(`#route-stops [data-property-id="${propB}"] [data-field="route_label"]`).value, "B2"); dom.window.close();
});
test("invalid appointments and duplicate labels do not write a partial draft", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "1");
  doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /unique route label/);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-stop").length, 0);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "2");
  doc.querySelector('[data-field="locked_appointment"]').click(); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /time window/);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-stop").length, 0); dom.window.close();
});
test("a failed read after creation retains its key and never labels a committed write refused", async () => {
  const store = domain(), { dom, doc } = await open(store); store.fail("/api/tours/detail", "missing"); await create(doc);
  assert.equal(store.tours.size, 1);
  assert.match(doc.querySelector("#create-tour-state").textContent, /outcome unknown/i);
  doc.querySelector("#reconcile-create").click(); await settle(); doc.querySelector("#create-tour-form").requestSubmit(); await settle();
  assert.equal(store.tours.size, 1);
  const creates = store.calls.filter(c => c.path === "/api/tours/create"); assert.equal(creates[0].body.idempotency_key, creates[1].body.idempotency_key); dom.window.close();
});
test("reconciliation failure keeps retry disabled and never sends another write", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  store.fail("/api/tours/route-stop", "lost"); doc.querySelector("#save-composer").click(); await settle();
  const posts = store.calls.filter(c => c.body).length; store.fail("/api/tours/detail", "missing");
  doc.querySelector("#reconcile-composer").click(); await settle();
  assert.equal(store.calls.filter(c => c.body).length, posts);
  assert.equal(doc.querySelector("#retry-composer").hidden, true);
  assert.match(doc.querySelector("#composer-state").textContent, /Reconciliation read failed/); dom.window.close();
});
test("an unresolved creation prevents another composer from overwriting the retained request", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc);
  store.fail("/api/tours/create", "lost"); await create(doc);
  doc.querySelector(".tour-button").click(); await settle(); await addCart(doc);
  assert.equal(doc.querySelector("#add-cart-stops").disabled, true);
  assert.equal(doc.querySelector("#save-composer").disabled, true);
  const pending = JSON.parse(dom.window.sessionStorage.getItem("doctorcre-tour-pending-v1"));
  assert.equal(pending.create.idempotency_key, store.calls.filter(c => c.path === "/api/tours/create")[1].body.idempotency_key); dom.window.close();
});
test("a reloaded accepted Tour requests route endpoints in the composer before opening a new version", async () => {
  const store = domain(), first = await open(store); await create(first.doc); await addCart(first.doc); await saveAndAccept(first.doc); first.dom.window.close();
  const next = await open(store); next.doc.querySelector(".tour-button").click(); await settle();
  fill(next.doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "B2");
  next.doc.querySelector("#save-composer").click(); await settle();
  assert.match(next.doc.querySelector("#composer-state").textContent, /route endpoints/i);
  assert.equal(next.doc.querySelector("#route-endpoint-editor").hidden, false);
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-draft").length, 0);
  for (const role of ["start", "end"]) { fill(next.doc, `#edit-${role}-latitude`, "30.6"); fill(next.doc, `#edit-${role}-longitude`, "-87.3"); fill(next.doc, `#edit-${role}-source`, `fixture:${role}`); }
  next.doc.querySelector("#save-composer").click(); await settle();
  assert.equal(store.calls.find(call => call.path === "/api/tours/route-draft").body.start_point.latitude, 30.6);
  assert.match(next.doc.querySelector("#composer-state").textContent, /Draft saved/); next.dom.window.close();
});
async function touchLayout(page) {
  return page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth,
    overflowing: [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, id: el.id, className: el.getAttribute("class"), right: el.getBoundingClientRect().right })).slice(0, 12),
    rows: [...document.querySelectorAll(".composer-stop")].map(row => ({ width: row.clientWidth, scroll: row.scrollWidth })),
    targets: [...document.querySelectorAll("button, input, select, textarea, summary, a[href], [role=button]")]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => {
        const target = el.matches("input[type=checkbox]") && el.labels?.length ? el.labels[0] : el;
        const { width, height } = target.getBoundingClientRect();
        return { tag: el.tagName, id: el.id, field: el.dataset.field, width, height };
      }) }));
}

test("phone and iPad composers fit the viewport and reduced motion leaves every state legible", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const store = domain(), page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const css = await readFile(new URL("../tours/app.css", import.meta.url), "utf8");
    const evidenceCss = await readFile(new URL("../tours/property-panel.css", import.meta.url), "utf8");
    const shellCss = await readFile(new URL("../css/app-shell.css", import.meta.url), "utf8");
    const shellScript = (await readFile(new URL("../js/app-shell.js", import.meta.url), "utf8")).replace(/^export /gm, "");
    const pageHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "").replace("</head>", `<style>${css}\n${evidenceCss}\n${shellCss}</style></head>`);
    await page.route("https://tour.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: pageHtml });
      const response = await store.fetch(url.pathname + url.search, { headers: request.headers(), body: request.postData() || undefined });
      await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(await response.json()) });
    });
    await page.goto("https://tour.test/tours"); await page.addScriptTag({ content: shellScript }); await page.addScriptTag({ content: script });
    await page.locator("#create-tour-panel summary").click();
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await touchLayout(page);
      assert.ok(layout.document <= width, `${width}px creation overflow`);
      assert.ok(layout.targets.every(target => target.height >= 44 && target.width >= 44), `${width}px creation touch targets: ${JSON.stringify(layout.targets)}`);
      await page.getByLabel("Navigation menu", { exact: true }).click();
      const navigation = await touchLayout(page);
      assert.ok(navigation.document <= width, `${width}px navigation overflow`);
      assert.ok(navigation.targets.every(target => target.height >= 44 && target.width >= 44), `${width}px open navigation touch targets`);
      await page.getByLabel("Navigation menu", { exact: true }).click();
    }
    for (const [selector, value] of [["#create-tour-name", "Synthetic Tour"], ["#create-subject-id", "work:fixture"], ["#create-dataset", "synthetic-v1"]]) await page.locator(selector).fill(value);
    for (const role of ["start", "end"]) {
      await page.locator(`#${role}-latitude`).fill("30.5"); await page.locator(`#${role}-longitude`).fill("-87.2"); await page.locator(`#${role}-source`).fill(`fixture:${role}`);
    }
    await page.locator("#create-tour").click(); await page.locator("#tour-panel").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Find properties", exact: true }).click();
    await page.locator("#property-results button[data-property-id]").first().waitFor();
    for (const button of await page.locator("#property-results button[data-property-id]").all()) await button.click();
    await page.locator("#add-cart-stops").click(); await page.locator(".composer-stop").first().waitFor();
    const firstStop = page.locator(`.composer-stop[data-property-id="${propA}"]`);
    await firstStop.getByRole("button", { name: "Down", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".composer-stop")?.dataset.propertyId), propA);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Up");
    await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".composer-stop")?.dataset.propertyId), propA);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Down");
    // Sample the entrance itself: a computed 44px input can have fractional
    // bounds just below the touch floor while its ancestor is translating.
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const undersized = await page.evaluate(() => {
        const undersized = [];
        for (const frame of [0, 1, 17, 137.1, 211, 349, 549, 550]) {
          for (const animation of document.querySelector("#route-stops").getAnimations({ subtree: true })) {
            animation.pause(); animation.currentTime = frame;
          }
          for (const el of document.querySelectorAll(".stop-fields input, .stop-fields select")) {
            const height = el.getBoundingClientRect().height;
            if (height < 44) undersized.push({ frame, field: el.dataset.field, height });
          }
        }
        return undersized;
      });
      assert.deepEqual(undersized, [], `${width}px animated touch targets`);
    }
    for (const width of [320, 375, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await touchLayout(page);
      assert.ok(layout.document <= layout.viewport, `${width}px document overflow: ${JSON.stringify(layout)}`);
      assert.ok(layout.rows.every(row => row.scroll <= row.width), `${width}px stop overflow`);
      assert.ok(layout.targets.every(target => target.height >= 44 && target.width >= 44), `${width}px touch targets: ${JSON.stringify(layout.targets.filter(target => target.height < 44 || target.width < 44))}`);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    for (const label of await page.locator(".share-scopes label").all()) {
      const box = label.locator("input");
      const checked = await box.isChecked();
      await label.click(); assert.equal(await box.isChecked(), !checked, "the full scope label toggles its checkbox");
    }
    await page.getByRole("button", { name: "Filter Bay county", exact: true }).click();
    assert.equal(await page.locator("#property-county").inputValue(), "Bay", "the last county is reachable inside the phone scroller");
    await page.getByRole("button", { name: "Filter Escambia county", exact: true }).press("Enter");
    assert.equal(await page.locator("#property-county").inputValue(), "Escambia", "county keyboard activation remains available");
    await page.locator(".property-fact").first().click();
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const close = await page.locator(".property-dialog-close").boundingBox();
      assert.ok(close.width >= 44 && close.height >= 44, `${width}px evidence dialog close touch target`);
    }
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.ok(await page.locator("#composer-badge").evaluate(el => el.getAnimations({ subtree: true }).length > 0), "live status has motion");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await page.locator(".route-card").evaluate(el => ({ animations: el.getAnimations({ subtree: true }).length, opacity: getComputedStyle(el).opacity, text: el.textContent }));
    assert.equal(motion.animations, 0); assert.equal(motion.opacity, "1"); assert.match(motion.text, /Changes to review/);
  } finally { await browser.close(); }
});


test("Dot Tour: default cart labels satisfy accepted membership and accept without edits", async t => {
  const store = domain(), normal = store.fetch;
  store.fetch = async (path, options) => {
    if (path === "/api/tours/route-accept") {
      const body = JSON.parse(options.body);
      const route = [...store.tours.values()].flatMap(tour => tour.routes).find(route => route.id === body.route_version_id);
      // Accepted membership guard at CARR 72bac3e9: alphanumeric, 1-3 characters.
      if (route.stops.some(stop => stop.stop_state === "active" && !/^[A-Za-z0-9]{1,3}$/.test(stop.route_label))) return response(null, 400);
    }
    return normal(path, options);
  };
  const { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc); await saveAndAccept(doc);
  assert.equal([...store.tours.values()][0].routes[0].accepted, true);
  assert.deepEqual(store.calls.filter(call => call.path === "/api/tours/route-stop").map(call => call.body.route_label), ["1", "2"]);
});


for (const next of ["open", "create"]) test(`Dot Tour: ${next} another Tour clears the previous confidential link`, async t => {
  const store = domain(), normal = store.fetch;
  store.fetch = async (path, options) => {
    if (path === "/api/tours/share/issue") return response({ share_grant_id: uuid() });
    if (path.startsWith("/api/tours/feedback")) return response({ feedback: { items: [] } });
    return normal(path, options);
  };
  const { dom, doc } = await open(store); t.after(() => dom.window.close());
  let copied = null;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async value => { copied = value; } } });
  await create(doc);
  const tour = [...store.tours.values()][0]; tour.projection_id = uuid();
  doc.querySelector(".tour-button").click(); await settle();
  fill(doc, "#receipt-digest", `sha256:${"a".repeat(64)}`);
  doc.querySelector("#share-form").requestSubmit(); await settle();
  const priorLink = doc.querySelector("#share-url").value;
  assert.match(priorLink, /^https:\/\/reports.doctorcre.com\/share#token=/);
  doc.querySelector("#copy-share").click(); await settle(); assert.equal(copied, priorLink);
  if (next === "open") {
    const other = uuid(); store.tours.set(other, { id: other, name: "Synthetic other Tour", routes: [{ id: uuid(), route_version: 1, accepted: false, stops: [] }] });
    doc.querySelector("#refresh").click(); await settle();
    doc.querySelectorAll(".tour-button")[1].click(); await settle();
  } else await create(doc);
  assert.equal(doc.querySelector("#share-url").value, "");
  assert.equal(doc.querySelector("#share-link").hidden, true);
  doc.querySelector("#copy-share").click(); await settle(); assert.equal(copied, "");
});


test("Dot Tour: keyboard reorder keeps focus on the moved property at route boundaries", async t => {
  const store = domain(), { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc);
  const down = [...doc.querySelector(`[data-property-id="${propA}"] .stop-controls`).children].find(button => button.textContent === "Down");
  down.focus(); down.click();
  assert.equal(doc.querySelector("#route-stops").lastElementChild.dataset.propertyId, propA);
  assert.equal(doc.activeElement.closest(".composer-stop")?.dataset.propertyId, propA);
  assert.equal(doc.activeElement.textContent, "Up"); assert.equal(doc.activeElement.disabled, false);
  doc.activeElement.click();
  assert.equal(doc.querySelector("#route-stops").firstElementChild.dataset.propertyId, propA);
  assert.equal(doc.activeElement.closest(".composer-stop")?.dataset.propertyId, propA);
  assert.equal(doc.activeElement.textContent, "Down");
});


test("Dot Tour: acceptance submits the digest of the reviewed stop set and handles refusal", async t => {
  const store = domain(), normal = store.fetch;
  const reviewedDigest = `sha256:${"b".repeat(64)}`; let acceptance;
  store.fetch = async (path, options) => {
    if (path === "/api/tours/route-accept") {
      acceptance = JSON.parse(options.body);
      return response(null, 409);
    }
    const result = await normal(path, options);
    if (!path.startsWith("/api/tours/detail")) return result;
    const payload = await result.json();
    if (payload.data) payload.data.routes[0].acceptance_digest = reviewedDigest;
    return { ...result, json: async () => payload };
  };
  const { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc);
  doc.querySelector("#save-composer").click(); await settle();
  doc.querySelector("#route-reviewed").click();
  // A second operator appends a stop after the displayed two-stop review.
  const route = [...store.tours.values()][0].routes[0];
  route.stops.push({ ...route.stops[0], id: uuid(), property_id: uuid(), route_sequence: 3, route_label: "C" });
  doc.querySelector("#accept-route").click(); await settle();
  assert.equal(acceptance.acceptance_digest, reviewedDigest);
  assert.equal(doc.querySelector("#route-stops").children.length, 2);
  assert.match(doc.querySelector("#composer-state").textContent, /changed.*refused.*Reload/i);
  assert.equal(doc.querySelector("#accept-route").disabled, true);
  assert.equal(route.accepted, false);
});


for (const label of ["Stop 1", "ABCD", "A_", "A B", ""]) test(`Dot Tour: invalid membership label ${JSON.stringify(label)} cannot write a draft`, async t => {
  const store = domain(), { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc);
  fill(doc, `[data-property-id="${propA}"] [data-field="route_label"]`, label);
  doc.querySelector("#save-composer").click(); await settle();
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-stop").length, 0);
  assert.match(doc.querySelector("#composer-state").textContent, /1–3 letters or numbers/);
});
for (const missing of [undefined, "invalid"]) test(`Dot Tour: missing or invalid reviewed digest ${missing} withholds acceptance`, async t => {
  const store = domain(), normal = store.fetch;
  store.fetch = async (path, options) => {
    const result = await normal(path, options);
    if (!path.startsWith("/api/tours/detail")) return result;
    const payload = await result.json();
    if (payload.data) payload.data.routes[0].acceptance_digest = missing;
    return { ...result, json: async () => payload };
  };
  const { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc);
  doc.querySelector("#save-composer").click(); await settle();
  assert.equal(doc.querySelector("#route-reviewed").disabled, true);
  assert.equal(doc.querySelector("#accept-route").disabled, true);
  assert.match(doc.querySelector("#composer-state").textContent, /digest unavailable/);
  doc.querySelector("#accept-route").click(); await settle();
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-accept").length, 0);
});


test("Dot Tour: the composer contract binds review to an exact CARR digest producer", async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  assert.equal(contract.version, "1.1.0");
  assert.equal(contract.reviewed_route.schema, "doctorcre-tour-reviewed-route-digest.v1");
  assert.equal(contract.reviewed_route.response_digest, "routes[0].acceptance_digest");
  assert.equal(contract.reviewed_route.acceptance_field, "acceptance_digest");
  assert.equal(contract.reviewed_route.changed_draft_status, 409);
  assert.equal(contract.reviewed_route.producer.source_commit, "ff7251b5dab04e5a73c614d712bf0d16fd3d7a33");
  assert.equal(contract.reviewed_route.producer.migration, "migrations/0759_tour_reviewed_route_digest.sql");
});

test("the digest-bearing detail read and release prerequisite bind the composer producer", async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(contract.reviewed_route.producer.source_commit, contract.producer.source_commit);
  assert.deepEqual(contract.reads["/api/tours/detail"], {
    method: "GET", query_fields: ["tour_id"], envelope: "data",
    routes_order: "route_version descending",
    route_fields: ["id", "route_version", "accepted", "stops", "acceptance_digest"],
    acceptance_digest_pattern: "^sha256:[0-9a-f]{64}$",
    legacy_response_digest: "route_acceptance_digest",
  });
  assert.deepEqual(contract.release_prerequisite, {
    producer_source_commit: contract.producer.source_commit,
    migration: contract.reviewed_route.producer.migration,
    order: ["apply producer migration", "deploy producer", "deploy consumer"],
    older_producer_behavior: "withhold review and acceptance",
  });
});

// Opt-in verification follows the existing committed-producer check convention.
// It reads git blobs only. SQL execution and production deployment stay in CARR.
test("the committed digest producer detail reaches composer acceptance unchanged", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned detail producer",
}, async t => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  const committed = path => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  const migration = committed(contract.reviewed_route.producer.migration);
  assert.match(migration, /create or replace function ops\.read_tour_internal_detail\b/);
  assert.match(migration, /'acceptance_digest',ops\.tour_route_review_digest\(v\.organization_tenant_id,v\.id\)/);
  assert.match(migration, /p_acceptance_digest is distinct from ops\.tour_route_review_digest\(p_tenant,p_route_version_id\)/);
  assert.match(migration, /order by v\.route_version desc/);
  const runtime = committed("mcp-server/src/tour-runtime.js");
  // Load the committed public pure projection, without importing database or
  // renderer adapters. The function body is unmodified and never reimplemented.
  const start = runtime.indexOf("export function projectTourDetail(");
  const end = runtime.indexOf("\nasync function invoke(", start);
  assert.ok(start >= 0 && end > start);
  const { projectTourDetail } = await import(`data:text/javascript;base64,${Buffer.from(runtime.slice(start, end)).toString("base64")}`);
  const timestampModule = `data:text/javascript;base64,${Buffer.from(committed("mcp-server/src/tour-route-timestamp.js")).toString("base64")}`;
  const source = committed("mcp-server/src/tour-internal-web.js").replace('"./tour-route-timestamp.js"', JSON.stringify(timestampModule));
  const { createTourInternalWebHandler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const store = domain(), normalFetch = store.fetch;
  const actor = { id: "synthetic-partner" }, session = { csrfToken: "synthetic-csrf" };
  const handler = createTourInternalWebHandler({ readTourFn: async ({ input }) => {
    const tour = store.tours.get(input.tour_id);
    if (!tour) return { ok: false, status: 404 };
    const routes = structuredClone(tour.routes);
    for (const route of routes) route.acceptance_digest = fixtureReviewDigest(route);
    return { ok: true, data: projectTourDetail({ id: tour.id, tour_name: tour.name, tour_status: "draft", routes }) };
  } });
  let displayedDigest;
  store.fetch = async (path, options) => {
    if (!path.startsWith("/api/tours/detail")) return normalFetch(path, options);
    const result = await handler.fetch(new Request(`https://app.doctorcre.com${path}`), { APP_HOST: "app.doctorcre.com" }, {}, actor, session);
    const payload = await result.clone().json();
    if (payload.data) {
      displayedDigest = payload.data.routes[0].acceptance_digest;
      assert.equal(payload.data.route_acceptance_digest, displayedDigest);
    }
    return result;
  };
  const { dom, doc } = await open(store); t.after(() => dom.window.close());
  await create(doc); await addCart(doc);
  doc.querySelector("#save-composer").click(); await settle();
  const reviewedDigest = displayedDigest;
  assert.match(reviewedDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(doc.querySelector("#route-reviewed").disabled, false);
  doc.querySelector("#route-reviewed").click();
  assert.equal(doc.querySelector("#accept-route").disabled, false);
  doc.querySelector("#accept-route").click(); await settle();
  assert.equal(store.calls.find(call => call.path === "/api/tours/route-accept").body.acceptance_digest, reviewedDigest);
  assert.equal([...store.tours.values()][0].routes[0].accepted, true);
});
