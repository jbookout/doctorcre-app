import assert from "node:assert/strict";
import test from "node:test";
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
