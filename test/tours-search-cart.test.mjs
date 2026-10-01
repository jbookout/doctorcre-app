import { mapScript } from "./tours-map-script.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../tours/index.html", import.meta.url), "utf8");
// Inline the app's module dependencies for the classic-script browser harness.
const tourFormat = (await readFile(new URL("../tours/tour-format.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const propertyPanel = (await readFile(new URL("../tours/property-panel.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const script = `${mapScript}\n${tourFormat}\nconst mountPropertyPanel = (() => { ${propertyPanel}\nreturn mountPropertyPanel; })();\n${(await readFile(new URL("../tours/app.js", import.meta.url), "utf8")).replace(/^import [^\n]*\n/gm, "")}`;
const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
const tourId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const property = { property_id: propertyId, name: "Medical Plaza", address: "100 Clinic Way", county: "Escambia", state: "FL",
  availability: "unknown", source_label: "CARR reviewed property register", rights_status: "unknown", coordinate_precision: "unknown",
  fact_as_of: "2026-09-01T00:00:00Z", entrance_verified: true, caveat: "Reviewed register entry." };

test("Tour search and cart are bound to the merged CARR producer revision", () => {
  assert.equal(contract.producer.source_commit, "e853b6c1e9b6c306a43f8589b38d39406c37cc9d");
  for (const operation of ["search-tour-properties", "read-tour-selection-cart", "append-tour-selection-cart-version"])
    assert.ok(contract.mcp_operations.includes(operation), `${operation} is missing from the interface`);
  for (const path of ["/api/tours/properties/search", "/api/tours/selection-cart"])
    assert.ok(contract.http_surfaces.includes(path), `${path} is missing from the interface`);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 8; i += 1) await tick(); }
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), message);
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return status >= 400 ? { error: status === 404 ? "not_found" : status === 409 ? "conflict" : "tour_unavailable" } : { data, csrf_token: "csrf" }; } }; }
async function openApp(store, { refuseSave = false, conflictOnce = false, readFailsAfterSave = false, holdSave = null, searchResponder = null, detail = null, holdReload = null } = {}) {
  const dom = new JSDOM(html, { url: "https://app.doctorcre.com/tours", runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window, "crypto", { value: webcrypto });
  window.TextEncoder = TextEncoder;
  const calls = [];
  window.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/api/tours/library") return response({ tours: [{ id: tourId, name: "Test Tour", status: "draft" }] });
    if (path.startsWith("/api/tours/detail")) {
      if (holdReload && calls.some(call => call.options.method === "POST")) await holdReload.promise;
      return response({ id: tourId, name: "Test Tour", status: "draft", routes: [], ...detail });
    }
    if (["/api/tours/route-version", "/api/tours/route-reorder", "/api/tours/route-accept", "/api/tours/cheat-sheet/autosave", "/api/tours/cheat-sheet/restore"].includes(path)) {
      if (holdSave) await holdSave.promise;
      return response({});
    }
    if (path.startsWith("/api/tours/selection-cart?") && readFailsAfterSave && store.version) return response(null, 503);
    if (path.startsWith("/api/tours/selection-cart?")) return store.version ? response({ cart: { tour_id: tourId, selection_version_id: versionId,
      selection_version: store.version, property_ids: [...store.ids] } }) : response(null, 404);
    if (path === "/api/tours/properties/search") return response({ search: searchResponder ? await searchResponder(JSON.parse(options.body)) : { items: [property], count: 1, has_more: false } });
    if (path === "/api/tours/selection-cart") {
      if (holdSave) await holdSave.promise;
      if (refuseSave) return response(null, 503);
      if (conflictOnce) { conflictOnce = false; store.version += 1; return response(null, 409); }
      const body = JSON.parse(options.body); store.version += 1; store.ids = [...body.property_ids];
      return response({ selection_version_id: versionId, selected_count: store.ids.length });
    }
    throw new Error(`unexpected path ${path}`);
  };
  window.eval(script);
  await settle();
  window.document.querySelector(".tour-button").click();
  await settle();
  return { dom, window, calls };
}

test("editing filters invalidates the old page cursor and prevents mixed results", async () => {
  const office = { ...property, name: "Office A" };
  const clinic = { ...property, property_id: "44444444-4444-4444-8444-444444444444", name: "Clinic B" };
  const app = await openApp({ version: 0, ids: [] }, { searchResponder: filters => {
    if (filters.query === "office") return { items: [office], count: 1, has_more: true, cursor: "1" };
    if (filters.query === "clinic" && filters.cursor === null) return { items: [clinic], count: 1, has_more: false };
    throw new Error(`mixed search ${JSON.stringify(filters)}`);
  } });
  const doc = app.window.document;
  const query = doc.querySelector("#property-query");
  query.value = "office";
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  assert.match(doc.querySelector("#property-results").textContent, /Office A/);
  query.value = "clinic";
  query.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  assert.equal(doc.querySelector("#more-properties").hidden, true);
  doc.querySelector("#more-properties").click();
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  assert.doesNotMatch(doc.querySelector("#property-results").textContent, /Office A/);
  assert.match(doc.querySelector("#property-results").textContent, /Clinic B/);
  const searches = app.calls.filter(call => call.path === "/api/tours/properties/search").map(call => JSON.parse(call.options.body));
  assert.equal(searches.length, 2);
  assert.equal(searches[1].cursor, null);
  app.window.close();
});

test("a late page for prior filters cannot replace a newer search", async () => {
  let releaseOld;
  const oldPage = new Promise(resolve => { releaseOld = resolve; });
  const app = await openApp({ version: 0, ids: [] }, { searchResponder: filters =>
    filters.query === "office" ? oldPage : { items: [{ ...property, name: "Clinic B" }], count: 1, has_more: false }
  });
  const doc = app.window.document;
  const query = doc.querySelector("#property-query");
  query.value = "office";
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  query.value = "clinic";
  query.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  releaseOld({ items: [{ ...property, name: "Office A" }], count: 1, has_more: false });
  await settle();
  assert.match(doc.querySelector("#property-results").textContent, /Clinic B/);
  assert.doesNotMatch(doc.querySelector("#property-results").textContent, /Office A/);
  app.window.close();
});

test("unsearched and edited filters do not claim that no property matches", async () => {
  const app = await openApp({ version: 0, ids: [] });
  const doc = app.window.document;
  assert.doesNotMatch(doc.querySelector("#property-results").textContent, /No properties match/);
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  doc.querySelector("#property-query").value = "new";
  doc.querySelector("#property-query").dispatchEvent(new app.window.Event("input", { bubbles: true }));
  assert.doesNotMatch(doc.querySelector("#property-results").textContent, /No properties match/);
  app.window.close();
});

test("search results disclose unknowns; saved stable IDs survive reload; refused save retains retry key", async () => {
  const store = { version: 0, ids: [] };
  const first = await openApp(store);
  const doc = first.window.document;
  doc.querySelector("#property-type").value = "Medical office";
  doc.querySelector("#property-search-form").dispatchEvent(new first.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const searchCall = first.calls.find(call => call.path === "/api/tours/properties/search");
  assert.deepEqual(JSON.parse(searchCall.options.body).property_types, ["medical_office"]);
  const result = doc.querySelector("#property-results");
  assert.match(result.textContent, /Medical Plaza/);
  assert.match(result.textContent, /CARR reviewed property register/);
  assert.match(result.textContent, /Rights unknown/);
  assert.match(result.textContent, /Precision unknown/);
  assert.match(result.textContent, /Entrance verified/);
  assert.match(result.textContent, /Latest fact date/);
  assert.match(result.textContent, /Sep 1, 2026/);
  assert.match(result.textContent, /Candidate facts need review before a route or client use/);
  result.querySelector("button[data-property-id]").click();
  assert.match(doc.querySelector("#selection-list").textContent, /Medical Plaza/);
  doc.querySelector("#save-selection").click();
  await settle();
  assert.deepEqual(store.ids, [propertyId]);
  assert.equal(store.version, 1);
  first.window.close();

  const second = await openApp(store, { refuseSave: true });
  const saved = second.window.document;
  assert.doesNotMatch(saved.querySelector("#selection-list").textContent, /Saved property \d+/);
  assert.match(saved.querySelector("#selection-list").textContent, /Medical Plaza/);
  assert.ok(saved.querySelector("#selection-list button"), "an identified saved property can be removed after reload");
  const hydration = second.calls.find(call => call.path === "/api/tours/properties/search");
  assert.deepEqual(JSON.parse(hydration.options.body).counties, []);
  assert.equal(JSON.parse(hydration.options.body).limit, 100);
  saved.querySelector("#property-search-form").dispatchEvent(new second.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  assert.match(saved.querySelector("#selection-list").textContent, /Medical Plaza/);
  assert.ok(saved.querySelector("#selection-list button"), "identified search results restore row actions");
  saved.querySelector("#property-results button[data-property-id]").click(); // remove from draft
  saved.querySelector("#save-selection").click();
  await settle();
  assert.match(saved.querySelector("#selection-state").textContent, /could not be saved|conflict/i);
  assert.equal(store.version, 1);
  assert.deepEqual(store.ids, [propertyId]);
  saved.querySelector("#save-selection").click();
  await settle();
  const posts = second.calls.filter(call => call.path === "/api/tours/selection-cart" && call.options.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].options.body).idempotency_key, JSON.parse(posts[1].options.body).idempotency_key);
  second.window.close();
});

test("saved property details hydrate across search pages without changing visible search", async () => {
  const other = { ...property, property_id: "44444444-4444-4444-8444-444444444444", name: "Other property" };
  const app = await openApp({ version: 1, ids: [propertyId] }, { searchResponder: filters =>
    filters.cursor === null ? { items: [other], count: 1, has_more: true, cursor: "1" } :
      { items: [property], count: 1, has_more: false }
  });
  const doc = app.window.document;
  assert.match(doc.querySelector("#selection-list").textContent, /Medical Plaza/);
  assert.doesNotMatch(doc.querySelector("#property-results").textContent, /Other property|Medical Plaza/);
  const calls = app.calls.filter(call => call.path === "/api/tours/properties/search").map(call => JSON.parse(call.options.body));
  assert.deepEqual(calls.map(call => call.cursor), [null, "1"]);
  app.window.close();
});

test("a saved property absent from reviewed search can be removed and saved by version", async () => {
  const store = { version: 1, ids: [propertyId] };
  const app = await openApp(store, { searchResponder: () => ({ items: [], count: 0, has_more: false }) });
  const doc = app.window.document;
  assert.match(doc.querySelector("#selection-list").textContent, /Details unavailable/i);
  assert.doesNotMatch(doc.querySelector("#selection-list").textContent, new RegExp(propertyId));
  const remove = doc.querySelector("#selection-list button");
  assert.equal(remove?.textContent, "Remove");
  assert.equal(doc.querySelector("#save-selection").disabled, true);
  remove.click();
  assert.equal(doc.querySelector("#selection-list").textContent, "No properties selected.");
  assert.equal(doc.querySelector("#save-selection").disabled, false);
  doc.querySelector("#save-selection").click();
  await settle();
  const write = app.calls.find(call => call.path === "/api/tours/selection-cart" && call.options.method === "POST");
  assert.equal(JSON.parse(write.options.body).expected_selection_version, 1);
  assert.deepEqual(JSON.parse(write.options.body).property_ids, []);
  assert.deepEqual(store.ids, []);
  assert.equal(store.version, 2);
  assert.equal(doc.querySelector("#save-selection").disabled, true);
  app.window.close();
  const reloaded = await openApp(store, { searchResponder: () => ({ items: [], count: 0, has_more: false }) });
  assert.equal(reloaded.window.document.querySelector("#selection-list").textContent, "No properties selected.");
  reloaded.window.close();
});

test("removing an unavailable saved property preserves other saved properties", async () => {
  const knownId = "44444444-4444-4444-8444-444444444444";
  const store = { version: 1, ids: [propertyId, knownId] };
  const app = await openApp(store, { searchResponder: () => ({
    items: [{ ...property, property_id: knownId, name: "Known clinic" }], count: 1, has_more: false,
  }) });
  const doc = app.window.document;
  const rows = doc.querySelectorAll("#selection-list .selection-item");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /details unavailable/i);
  assert.match(rows[1].textContent, /Known clinic/);
  rows[0].querySelector("button").click();
  doc.querySelector("#save-selection").click();
  await settle();
  assert.deepEqual(store.ids, [knownId]);
  assert.match(doc.querySelector("#selection-list").textContent, /Known clinic/);
  assert.doesNotMatch(doc.querySelector("#selection-list").textContent, /details unavailable/i);
  app.window.close();
});

test("a search candidate without name or address cannot be added or removed by an anonymous button", async () => {
  const app = await openApp({ version: 1, ids: [propertyId] }, { searchResponder: () => ({
    items: [{ ...property, name: null, address: null }], count: 1, has_more: false,
  }) });
  const doc = app.window.document;
  doc.querySelector("#property-search-form").requestSubmit();
  await settle();
  const action = doc.querySelector("#property-results button[data-property-id]");
  assert.equal(action.disabled, true);
  assert.equal(doc.querySelector("#selection-list button")?.textContent, "Remove");
  app.window.close();
});

test("editing during a save keeps the newer selection as an unsaved draft", async () => {
  let release;
  const holdSave = { promise: new Promise(resolve => { release = resolve; }) };
  const store = { version: 0, ids: [] };
  const app = await openApp(store, { holdSave });
  const doc = app.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const toggle = doc.querySelector("#property-results button[data-property-id]");
  toggle.click();
  doc.querySelector("#save-selection").click();
  await settle();
  doc.querySelector("#property-results button[data-property-id]").click();
  release();
  await settle();
  assert.deepEqual(store.ids, [propertyId]);
  assert.equal(doc.querySelector("#selection-list").textContent, "No properties selected.");
  assert.equal(doc.querySelector("#save-selection").disabled, false);
  assert.match(doc.querySelector("#selection-state").textContent, /unsaved|save again/i);
  app.window.close();
});

test("a version conflict refreshes the saved base while keeping the broker's draft", async () => {
  const store = { version: 1, ids: [propertyId] };
  const app = await openApp(store, { conflictOnce: true });
  const doc = app.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  doc.querySelector("#property-results button[data-property-id]").click();
  doc.querySelector("#save-selection").click();
  await settle();
  assert.equal(store.version, 2);
  assert.match(doc.querySelector("#selection-state").textContent, /changed|version/i);
  assert.equal(doc.querySelector("#selection-list").textContent, "No properties selected.");
  doc.querySelector("#save-selection").click();
  await settle();
  const posts = app.calls.filter(call => call.path === "/api/tours/selection-cart" && call.options.method === "POST").map(call => JSON.parse(call.options.body));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].expected_selection_version, 1);
  assert.equal(posts[1].expected_selection_version, 2);
  assert.notEqual(posts[0].idempotency_key, posts[1].idempotency_key);
  assert.deepEqual(store.ids, []);
  app.window.close();
});

test("a successful write with failed readback stays unconfirmed and keeps the same retry request", async () => {
  const store = { version: 0, ids: [] };
  const app = await openApp(store, { readFailsAfterSave: true });
  const doc = app.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  doc.querySelector("#property-results button[data-property-id]").click();
  doc.querySelector("#save-selection").click();
  await settle();
  assert.equal(store.version, 1);
  assert.match(doc.querySelector("#selection-state").textContent, /could not be confirmed/i);
  assert.equal(doc.querySelector("#save-selection").disabled, false);
  assert.match(doc.querySelector("#selection-list").textContent, /Medical Plaza/);
  app.window.close();
});

test("two immediate Save selection clicks send one idempotency key", async () => {
  const store = { version: 0, ids: [] };
  const app = await openApp(store);
  const doc = app.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  doc.querySelector("#property-results button[data-property-id]").click();
  const save = doc.querySelector("#save-selection");
  save.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
  save.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
  await settle();
  const keys = new Set(app.calls.filter(call => call.path === "/api/tours/selection-cart" && call.options.method === "POST")
    .map(call => JSON.parse(call.options.body).idempotency_key));
  assert.equal(keys.size, 1);
  assert.equal(store.version, 1);
  assert.deepEqual(store.ids, [propertyId]);
  assert.match(doc.querySelector("#selection-state").textContent, /saved with this Tour/);
  app.window.close();
});

test("a Save selection click while a save is in flight reuses it and the button stays disabled until it settles", async () => {
  let release;
  const holdSave = { promise: new Promise(resolve => { release = resolve; }) };
  const store = { version: 0, ids: [] };
  const app = await openApp(store, { holdSave });
  const doc = app.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  doc.querySelector("#property-results button[data-property-id]").click();
  const save = doc.querySelector("#save-selection");
  save.click();
  await settle();
  assert.equal(save.disabled, true);
  save.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
  await settle();
  release();
  await settle();
  const posts = app.calls.filter(call => call.path === "/api/tours/selection-cart" && call.options.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(store.version, 1);
  assert.equal(save.disabled, true);
  app.window.close();
});

test("two immediate clicks on each versioned route or cheat-sheet write send one idempotency key", async () => {
  const detail = { route_version_id: versionId, route_version: 1, accepted_route_version: 0, route_acceptance_digest: `sha256:${"a".repeat(64)}`, stops: [],
    cheat_sheet: { revision_number: 1, restore_revision_id: versionId } };
  for (const [button, path, completed] of [["#save-route", "/api/tours/route-version", "Route version saved."], ["#reorder-route", "/api/tours/route-reorder", "Route version saved."],
    ["#accept-route", "/api/tours/route-accept", "Route version accepted."], ["#save-sheet", "/api/tours/cheat-sheet/autosave", "Internal cheat sheet saved."], ["#restore-sheet", "/api/tours/cheat-sheet/restore", "Tour ready."]]) {
    let releaseSave, releaseReload;
    const holdSave = { promise: new Promise(resolve => { releaseSave = resolve; }) };
    const holdReload = { promise: new Promise(resolve => { releaseReload = resolve; }) };
    const app = await openApp({ version: 0, ids: [] }, { detail, holdSave, holdReload });
    const status = app.window.document.querySelector("#status");
    status.textContent = "Waiting for versioned write";
    const writes = () => app.calls.filter(call => call.path === path && call.options.method === "POST");
    const reloads = () => app.calls.filter(call => call.path.startsWith("/api/tours/detail"));
    const target = app.window.document.querySelector(button);
    target.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
    target.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.equal(writes().length, 1, `${button} sent more than one POST while saving`);
    assert.equal(reloads().length, 1, `${button} reloaded before its POST completed`);
    assert.equal(status.textContent, "Waiting for versioned write");
    releaseSave();
    await waitFor(() => reloads().length === 2, `${button} did not reload after its POST`);
    target.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.equal(writes().length, 1, `${button} sent another POST while reloading`);
    assert.equal(status.textContent, "Loading tour…");
    releaseReload();
    // A counted POST and started reload do not prove completion. Keep the DOM
    // open until the handler reports that both responses have been consumed.
    await waitFor(() => status.textContent === completed, `${button} did not finish its reload`);
    assert.equal(writes().length, 1, `${button} sent more than one POST`);
    assert.equal(reloads().length, 2, `${button} did not finish exactly one reload`);
    const keys = new Set(writes().map(call => JSON.parse(call.options.body).idempotency_key));
    assert.equal(keys.size, 1, `${button} sent ${keys.size} idempotency keys`);
    app.window.close();
  }
});
