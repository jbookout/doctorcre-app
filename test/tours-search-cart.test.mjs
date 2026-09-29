import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../tours/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../tours/app.js", import.meta.url), "utf8");
const tourId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const property = { property_id: propertyId, name: "Medical Plaza", address: "100 Clinic Way", county: "Escambia", state: "FL",
  availability: "unknown", source_label: "CARR reviewed property register", rights_status: "unknown", coordinate_precision: "unknown",
  fact_as_of: "2026-09-01T00:00:00Z", caveat: "Reviewed register entry." };

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 8; i += 1) await tick(); }
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return status >= 400 ? { error: status === 404 ? "not_found" : status === 409 ? "conflict" : "tour_unavailable" } : { data, csrf_token: "csrf" }; } }; }
async function openApp(store, { refuseSave = false, conflictOnce = false, readFailsAfterSave = false, holdSave = null } = {}) {
  const dom = new JSDOM(html, { url: "https://app.doctorcre.com/tours", runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window, "crypto", { value: webcrypto });
  window.TextEncoder = TextEncoder;
  const calls = [];
  window.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/api/tours/library") return response({ tours: [{ id: tourId, name: "Test Tour", status: "draft" }] });
    if (path.startsWith("/api/tours/detail")) return response({ id: tourId, name: "Test Tour", status: "draft", routes: [] });
    if (path.startsWith("/api/tours/selection-cart?") && readFailsAfterSave && store.version) return response(null, 503);
    if (path.startsWith("/api/tours/selection-cart?")) return store.version ? response({ cart: { tour_id: tourId, selection_version_id: versionId,
      selection_version: store.version, property_ids: [...store.ids] } }) : response(null, 404);
    if (path === "/api/tours/properties/search") return response({ search: { items: [property], count: 1, has_more: false } });
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

test("search results disclose unknowns; saved stable IDs survive reload; refused save retains retry key", async () => {
  const store = { version: 0, ids: [] };
  const first = await openApp(store);
  const doc = first.window.document;
  doc.querySelector("#property-search-form").dispatchEvent(new first.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const result = doc.querySelector("#property-results");
  assert.match(result.textContent, /Medical Plaza/);
  assert.match(result.textContent, /CARR reviewed property register/);
  assert.match(result.textContent, /Rights unknown/);
  assert.match(result.textContent, /Precision unknown/);
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
  assert.match(saved.querySelector("#selection-list").textContent, /Medical Plaza|Saved property/);
  saved.querySelector("#property-search-form").dispatchEvent(new second.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
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
