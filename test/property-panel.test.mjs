import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { propertyPanelView, propertyFactDetail, renderPropertyPanel } from "../tours/property-panel.js";

const source = { locator: "https://county.example.invalid/parcel/17", evidence_class: "direct_source", retrieved_at: "2026-09-20T12:00:00Z" };
const reviewed = (value, overrides = {}) => ({ status: "reviewed", value, as_of: "2026-09-21T12:00:00Z",
  effective_from: "2026-01-01T00:00:00Z", effective_to: null, geometry_precision: "jurisdiction_reference",
  geometry_method: null, source_crs: "EPSG:4326", review_state: "reviewed", source,
  determination_status: "context_only", conflicts: [], ...overrides });
const unknown = { status: "unavailable", value: null, reason: "authoritative_coverage_missing", as_of: null,
  effective_from: null, effective_to: null, geometry_precision: "unknown", geometry_method: null,
  source_crs: null, review_state: "unknown", source: null, determination_status: "context_only", conflicts: [] };
const evidence = { schema: "tour-property-evidence.v1", property_id: "10000000-0000-4000-8000-000000000001",
  as_of: "2026-09-29T12:00:00.000Z", facts: { county: reviewed("Escambia"), municipality: unknown,
    special_authority: unknown, parcel: reviewed("17-3S-29-0000-001", { geometry_precision: "parcel_reference" }),
    site_address: reviewed("100 Clinic Way"), building: reviewed("Clinic Plaza") } };

const panelSource = await readFile(new URL("../tours/property-panel.js", import.meta.url), "utf8");
test("property evidence is an explicit additive CARR contract read above main's 1.33 release", async () => {
  const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
  assert.equal(contract.version, "1.37.0");
  assert.ok(contract.http_surfaces.includes("/api/tours/property-evidence/v1"));
});
const otherProperty = "10000000-0000-4000-8000-000000000002";
const tour = { stops: [{ property_id: evidence.property_id, name: "Clinic Plaza" },
  { property_id: otherProperty, name: "Second property" }] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function openPanel(t, request) {
  const dom = new JSDOM('<section id="property-evidence"></section>', { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.eval(`${panelSource.replace(/^export /gm, "")}\nwindow.mount = mountPropertyPanel;`);
  const root = dom.window.document.getElementById("property-evidence");
  return { window: dom.window, root, mount: (value = tour) => dom.window.mount({ tour: value, request }),
    change(selector, value) { const input = root.querySelector(selector); input.value = value;
      input.dispatchEvent(new dom.window.Event("change")); } };
}

test("clearing the date removes reviewed facts through a property switch and remount until a date is supplied", async t => {
  const calls = [];
  const panel = openPanel(t, async path => {
    const url = new URL(path, "https://app.example.invalid");
    calls.push(url);
    return url.searchParams.get("property_id") === otherProperty
      ? { ...evidence, property_id: otherProperty, facts: { county: reviewed("Walton") } } : evidence;
  });
  panel.mount(); await settle();
  assert.match(panel.root.textContent, /Escambia/);
  panel.change("#property-evidence-date", ""); await settle();
  function dateRequired() {
    assert.equal(panel.root.querySelector("#property-evidence-date").value, "");
    assert.match(panel.root.querySelector("#property-evidence-content").textContent, /Choose an as-of date/);
    assert.equal(panel.root.querySelectorAll(".property-fact, .property-layer-node").length, 0);
    assert.doesNotMatch(panel.root.textContent, /Escambia|Reviewed/);
    assert.equal(calls.length, 1);
  }
  dateRequired();
  panel.change("#property-evidence-select", otherProperty); await settle();
  dateRequired();
  panel.mount(); await settle();
  dateRequired();
  assert.equal(panel.root.querySelector("#property-evidence-select").value, otherProperty);
  panel.change("#property-evidence-date", "2026-01-15"); await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1).searchParams.get("property_id"), otherProperty);
  assert.equal(calls.at(-1).searchParams.get("as_of"), "2026-01-15T23:59:59.999Z");
  assert.match(panel.root.textContent, /Walton/);
  assert.doesNotMatch(panel.root.textContent, /Escambia/);
});

test("clearing the date rejects a pending evidence result", async t => {
  let resolve;
  const panel = openPanel(t, () => new Promise(done => { resolve = done; }));
  panel.mount();
  panel.change("#property-evidence-date", "");
  resolve(evidence); await settle();
  assert.match(panel.root.querySelector("#property-evidence-content").textContent, /Choose an as-of date/);
  assert.equal(panel.root.querySelectorAll(".property-fact").length, 0);
});

test("reorder and save remounts preserve the selected property, historical date and loaded evidence without refetching", async t => {
  const calls = [];
  const panel = openPanel(t, async path => { calls.push(new URL(path, "https://app.example.invalid")); return evidence; });
  panel.mount(); await settle();
  panel.change("#property-evidence-select", otherProperty); await settle();
  panel.change("#property-evidence-date", "2026-01-15"); await settle();
  const count = calls.length;
  const html = panel.root.querySelector("#property-evidence-content").innerHTML;
  panel.mount({ stops: [...tour.stops].reverse() }); await settle();
  panel.mount(); await settle();
  assert.equal(panel.root.querySelector("#property-evidence-date").value, "2026-01-15");
  assert.equal(panel.root.querySelector("#property-evidence-select").value, otherProperty);
  assert.equal(calls.length, count);
  assert.equal(panel.root.querySelector("#property-evidence-content").innerHTML, html);
  panel.change("#property-evidence-date", "2026-01-16"); await settle();
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).searchParams.get("as_of"), "2026-01-16T23:59:59.999Z");
  panel.change("#property-evidence-select", evidence.property_id); await settle();
  assert.equal(calls.length, count + 2);
  assert.equal(calls.at(-1).searchParams.get("property_id"), evidence.property_id);
});

test("an unchanged remount reuses the pending read and renders its result into the current panel", async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const calls = [];
  const panel = openPanel(t, path => { calls.push(path); return pending; });
  panel.mount();
  panel.mount({ stops: [...tour.stops].reverse() });
  assert.equal(calls.length, 1);
  assert.match(panel.root.textContent, /Loading evidence/);
  resolve(evidence); await settle();
  assert.match(panel.root.querySelector("#property-evidence-content").textContent, /Escambia/);
});

test("changed selection rejects a late read; unavailable evidence retries on remount", async t => {
  let resolveOld;
  const pending = new Promise(done => { resolveOld = done; });
  let count = 0;
  const panel = openPanel(t, async () => {
    count += 1;
    if (count === 1) return pending;
    if (count === 2) throw new Error("unavailable");
    return { ...evidence, facts: { county: reviewed("Walton") } };
  });
  panel.mount();
  panel.change("#property-evidence-select", otherProperty); await settle();
  resolveOld(evidence); await settle();
  assert.match(panel.root.textContent, /unavailable/);
  assert.doesNotMatch(panel.root.textContent, /Escambia/);
  panel.mount(); await settle();
  assert.equal(count, 3);
  assert.match(panel.root.textContent, /Walton/);
});

for (const [timezone, instant, today, otherDay] of [
  ["America/Chicago", "2026-09-30T01:30:00.000Z", "2026-09-29", "2026-09-30"],
  ["Asia/Tokyo", "2026-09-29T16:30:00.000Z", "2026-09-30", "2026-09-29"],
]) test(`the default date and today read use the local calendar in ${timezone}`, async t => {
  const oldTimezone = process.env.TZ;
  process.env.TZ = timezone;
  t.after(() => { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; });
  const calls = [];
  const panel = openPanel(t, async path => { calls.push(new URL(path, "https://app.example.invalid")); return evidence; });
  const NativeDate = panel.window.Date;
  panel.window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return NativeDate.parse(instant); }
  };
  panel.mount(); await settle();
  assert.equal(panel.root.querySelector("#property-evidence-date").value, today);
  assert.equal(calls.at(-1).searchParams.get("as_of"), instant);
  panel.change("#property-evidence-date", otherDay); await settle();
  assert.equal(calls.at(-1).searchParams.get("as_of"), `${otherDay}T23:59:59.999Z`);
  panel.change("#property-evidence-date", today); await settle();
  assert.equal(calls.at(-1).searchParams.get("as_of"), instant);
});

test("panel carries the API provenance into every reviewed fact and shows unavailable governing layers", () => {
  const view = propertyPanelView(evidence);
  assert.deepEqual(view.map(item => item.label), ["County", "Municipality", "Special authority", "Parcel", "Site address", "Building"]);
  assert.equal(view[0].value, "Escambia");
  assert.equal(view[0].source.locator, source.locator);
  assert.equal(view[0].as_of, evidence.facts.county.as_of);
  assert.equal(view[0].source_crs, "EPSG:4326");
  assert.equal(view[1].value, "Unknown");
  assert.equal(view[1].status, "unavailable");
  assert.match(renderPropertyPanel(evidence), /<svg[\s\S]*<path/);
  assert.match(renderPropertyPanel(evidence), /https:\/\/county\.example\.invalid\/parcel\/17/);
  assert.match(renderPropertyPanel(evidence), /2026-09-21/);
  assert.match(renderPropertyPanel(evidence), /Coverage unavailable/);
  assert.match(renderPropertyPanel(evidence), /Context only/);
});

test("conflict is visible without choosing a governing county", () => {
  const conflict = { ...evidence, facts: { ...evidence.facts, county: { ...unknown, status: "conflicted", review_state: "conflicted",
    reason: "evidence_conflict", as_of: "2026-09-22T00:00:00Z", conflicts: [reviewed("Bay"), reviewed("Walton")] } } };
  const html = renderPropertyPanel(conflict);
  assert.equal(propertyPanelView(conflict)[0].value, "Unknown");
  assert.match(html, /Conflicting evidence/);
  assert.match(html, /Bay/);
  assert.match(html, /Walton/);
  assert.doesNotMatch(html, /legal determination/i);
  const detail = propertyFactDetail(propertyPanelView(conflict)[0]);
  assert.match(detail, /Bay[\s\S]*Effective[\s\S]*2026-01-01/);
  assert.match(detail, /Walton[\s\S]*Geometry precision[\s\S]*jurisdiction reference/);
  assert.match(detail, /Walton[\s\S]*Review[\s\S]*reviewed/);
  assert.match(detail, /https:\/\/county\.example\.invalid\/parcel\/17/);
});

test("source labels and values are escaped before entering the panel", () => {
  const hostile = { ...evidence, facts: { ...evidence.facts, building: reviewed('<img src=x onerror=alert(1)>',
    { source: { ...source, locator: 'javascript:alert(1)' } }) } };
  const html = renderPropertyPanel(hostile);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("long site names fit the diagram while the fact card keeps the full value", () => {
  const address = "123 Gulf View Drive, Santa Rosa Beach, Florida";
  const html = renderPropertyPanel({ ...evidence, facts: { ...evidence.facts,
    site_address: reviewed(address) } });
  assert.match(html, /<text[^>]*class="node-value">123 Gulf View Drive, San…<\/text>/);
  assert.match(html, /<strong>123 Gulf View Drive, Santa Rosa Beach, Florida<\/strong>/);
});
