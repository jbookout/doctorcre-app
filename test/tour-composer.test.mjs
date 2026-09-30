import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";

const html = await readFile(new URL("../tours/index.html", import.meta.url), "utf8");
const format = (await readFile(new URL("../tours/tour-format.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const panel = (await readFile(new URL("../tours/property-panel.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const app = (await readFile(new URL("../tours/app.js", import.meta.url), "utf8")).replace(/^import [^\n]*\n/gm, "");
const script = `${format}\nconst mountPropertyPanel = (() => { ${panel}\nreturn mountPropertyPanel; })();\n${app}`;
const uuid = () => webcrypto.randomUUID();
const propA = "44444444-4444-4444-8444-444444444444", propB = "55555555-5555-4555-8555-555555555555";
const properties = [propA, propB].map((property_id, i) => ({ property_id, name: `Synthetic site ${i + 1}`, address: `${100 + i} Example Way`, county: "Escambia", state: "FL" }));
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
test("composer contracts pin the exact server PR revision and each authenticated assembly route", async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/tour-composer.v1.json", import.meta.url), "utf8"));
  assert.equal(contract.schema, "doctorcre-tour-composer.v1");
  assert.equal(contract.producer.source_commit, "fff4e29a7eeb5f33ed2a5bcf7d6a44b81ef592a3");
  assert.equal(contract.producer.pull_request, "https://github.com/jbookout/carr-system/pull/1437");
  assert.deepEqual(Object.keys(contract.writes), ["/api/tours/create", "/api/tours/route-draft", "/api/tours/route-stop", "/api/tours/route-stop-transition", "/api/tours/route-accept"]);
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc); await saveAndAccept(doc);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "B revised"); doc.querySelector("#save-composer").click(); await settle();
  for (const call of store.calls.filter(call => contract.writes[call.path])) assert.deepEqual(Object.keys(call.body).sort(), [...contract.writes[call.path].fields].sort(), call.path);
  dom.window.close();
});
function response(data, status = 200) { return { ok: status < 400, status, json: async () => status < 400 ? { data, csrf_token: "synthetic-csrf" } : { error: status === 409 ? "conflict" : status === 404 ? "not_found" : "tour_unavailable" } }; }
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
      return response({ ...structuredClone(tour), route_version: accepted?.route_version || 1,
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
      assert.ok(r.stops.some(s => s.stop_state === "active"));
      assert.ok(r.stops.every(s => transitions.some(x => x.new_route_stop_id === s.id && x.new_route_version_id === r.id)));
      if (prior) assert.ok(prior.stops.every(s => transitions.some(x => x.old_route_stop_id === s.id && x.new_route_version_id === r.id)));
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
  for (const [key, value] of Object.entries(storage)) dom.window.sessionStorage.setItem(key, value);
  dom.window.eval(script); await settle();
  return { dom, doc: dom.window.document };
}
function fill(doc, selector, value) { const node = doc.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new doc.defaultView.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }
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
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="route_label"]`, "Appointment A");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="dwell_minutes"]`, "45");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="buffer_minutes"]`, "15");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_start"]`, "2026-10-05T09:00");
  fill(doc, `#route-stops [data-property-id="${propA}"] [data-field="appointment_end"]`, "2026-10-05T09:45");
  row.querySelector('[data-field="locked_appointment"]').click();
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="stop_state"]`, "excluded");
  assert.match(doc.querySelector("#route-changes").textContent, /Synthetic site 2.*excluded/i);
  doc.querySelector("#save-composer").click(); await settle();
  const saved = store.calls.filter(c => c.path === "/api/tours/route-stop").map(c => c.body);
  assert.equal(saved.length, 2); assert.equal(saved[0].property_id, propA); assert.equal(saved[0].route_label, "Appointment A");
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
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "Updated B");
  store.fail("/api/tours/route-draft", "refused"); doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /Write refused.*draft remains/);
  assert.equal(doc.querySelector(`#route-stops [data-property-id="${propB}"] [data-field="route_label"]`).value, "Updated B"); dom.window.close();
});
test("invalid appointments and duplicate labels do not write a partial draft", async () => {
  const store = domain(), { dom, doc } = await open(store); await create(doc); await addCart(doc);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "Stop 1");
  doc.querySelector("#save-composer").click(); await settle();
  assert.match(doc.querySelector("#composer-state").textContent, /unique route label/);
  assert.equal(store.calls.filter(c => c.path === "/api/tours/route-stop").length, 0);
  fill(doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "Stop 2");
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
  fill(next.doc, `#route-stops [data-property-id="${propB}"] [data-field="route_label"]`, "B revised");
  next.doc.querySelector("#save-composer").click(); await settle();
  assert.match(next.doc.querySelector("#composer-state").textContent, /route endpoints/i);
  assert.equal(next.doc.querySelector("#route-endpoint-editor").hidden, false);
  assert.equal(store.calls.filter(call => call.path === "/api/tours/route-draft").length, 0);
  for (const role of ["start", "end"]) { fill(next.doc, `#edit-${role}-latitude`, "30.6"); fill(next.doc, `#edit-${role}-longitude`, "-87.3"); fill(next.doc, `#edit-${role}-source`, `fixture:${role}`); }
  next.doc.querySelector("#save-composer").click(); await settle();
  assert.equal(store.calls.find(call => call.path === "/api/tours/route-draft").body.start_point.latitude, 30.6);
  assert.match(next.doc.querySelector("#composer-state").textContent, /Draft saved/); next.dom.window.close();
});
test("phone and iPad composers fit the viewport and reduced motion leaves every state legible", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const store = domain(), page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const css = await readFile(new URL("../tours/app.css", import.meta.url), "utf8");
    const evidenceCss = await readFile(new URL("../tours/property-panel.css", import.meta.url), "utf8");
    const pageHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "").replace("</head>", `<style>${css}\n${evidenceCss}</style></head>`);
    await page.route("https://tour.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: pageHtml });
      const response = await store.fetch(url.pathname + url.search, { headers: request.headers(), body: request.postData() || undefined });
      await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(await response.json()) });
    });
    await page.goto("https://tour.test/tours"); await page.addScriptTag({ content: script });
    await page.locator("#create-tour-panel summary").click();
    for (const [selector, value] of [["#create-tour-name", "Synthetic Tour"], ["#create-subject-id", "work:fixture"], ["#create-dataset", "synthetic-v1"]]) await page.locator(selector).fill(value);
    for (const role of ["start", "end"]) {
      await page.locator(`#${role}-latitude`).fill("30.5"); await page.locator(`#${role}-longitude`).fill("-87.2"); await page.locator(`#${role}-source`).fill(`fixture:${role}`);
    }
    await page.locator("#create-tour").click(); await page.locator("#tour-panel").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Find properties", exact: true }).click();
    await page.locator("#property-results button[data-property-id]").first().waitFor();
    for (const button of await page.locator("#property-results button[data-property-id]").all()) await button.click();
    await page.locator("#add-cart-stops").click(); await page.locator(".composer-stop").first().waitFor();
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth,
        overflowing: [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, id: el.id, className: el.getAttribute("class"), right: el.getBoundingClientRect().right })).slice(0, 12),
        rows: [...document.querySelectorAll(".composer-stop")].map(row => ({ width: row.clientWidth, scroll: row.scrollWidth })),
        targets: [...document.querySelectorAll(".composer-toolbar button, .stop-controls button, .stop-fields input, .stop-fields select")].filter(el => !el.disabled).map(el => el.getBoundingClientRect().height) }));
      assert.ok(layout.document <= layout.viewport, `${width}px document overflow: ${JSON.stringify(layout)}`);
      assert.ok(layout.rows.every(row => row.scroll <= row.width), `${width}px stop overflow`);
      assert.ok(layout.targets.every(height => height >= 44), `${width}px touch targets`);
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.ok(await page.locator("#composer-badge").evaluate(el => el.getAnimations({ subtree: true }).length > 0), "live status has motion");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await page.locator(".route-card").evaluate(el => ({ animations: el.getAnimations({ subtree: true }).length, opacity: getComputedStyle(el).opacity, text: el.textContent }));
    assert.equal(motion.animations, 0); assert.equal(motion.opacity, "1"); assert.match(motion.text, /Changes to review/);
  } finally { await browser.close(); }
});
