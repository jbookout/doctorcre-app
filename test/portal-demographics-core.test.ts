import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const result = await build({
  entryPoints: ["src/ui/portal/demographics-core.tsx"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const { createRequire } = await import("node:module");
const module = { exports: {} };
function required<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined);
  return value;
}
new Function("require", "module", "exports", required(result.outputFiles[0]).text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
// The bundle comes directly from this typed source in the same checkout.
const { DemographicsCore, projectDemographics } =
  module.exports as typeof import("../src/ui/portal/demographics-core.tsx");
const fixture = JSON.parse(await readFile("test/fixtures/portal-demographics-core.market-study.json", "utf8"));
const render = (demographics: import("../src/ui/portal/demographics-core.tsx").DemographicsCoreData | undefined) =>
  new JSDOM(renderToStaticMarkup(createElement(DemographicsCore, { demographics }))).window.document;

test("published years, units, denominators, notes and sources survive rendering", () => {
  const doc = render(fixture.demographics);
  const growth = required(doc.querySelector("[data-growth]"));
  assert.match(growth.textContent, /2020 census/);
  assert.match(growth.textContent, /2025 estimate/);
  assert.match(growth.textContent, /2030 projection/);
  assert.match(growth.textContent, /60,000/);
  assert.match(growth.textContent, /Population/);
  assert.equal(
    growth.querySelector('a[href="https://example.com/census"]')?.getAttribute("href"),
    "https://example.com/census",
  );
  assert.match(doc.body.textContent, /6,000 of 20,000 households/);
  assert.match(doc.body.textContent, /30%/);
  assert.match(doc.body.textContent, /Synthetic households note/);
  assert.equal(doc.querySelector("[data-age] a")?.getAttribute("href"), "https://example.com/age");
});

test("missing module renders nothing", () => {
  assert.equal(render(undefined).body.textContent, "");
});

test("unknown counts stay unknown while a published zero stays zero", () => {
  const data = structuredClone(fixture.demographics);
  data.income_bands.areas[0].counts = { "150000": 0 };
  delete data.income_bands.combined;
  assert.match(render(data).querySelector("[data-income-bands]")?.textContent ?? "", /Unknown of 20,000 households/);
  data.income_bands.thresholds = [150000];
  assert.match(render(data).querySelector("[data-income-bands]")?.textContent ?? "", /0 of 20,000 households/);
  data.income_bands.areas[0].households = 0;
  assert.match(render(data).querySelector("[data-income-bands]")?.textContent ?? "", /Unknown share/);
});

test("ten times the geography rows remain present with their values", () => {
  const data = structuredClone(fixture.demographics);
  data.median_income.geographies = Array.from({ length: 10 }, (_, index) => ({
    name: `Example area ${index}`,
    value: 80000 + index,
  }));
  assert.match(render(data).querySelector("[data-median]")?.textContent ?? "", /Example area 9/);
  assert.match(render(data).querySelector("[data-median]")?.textContent ?? "", /\$80,009/);
});

test("source rendering refuses unsafe and malformed URLs without hiding values", () => {
  for (const url of ["javascript:alert(1)", "https://[", "https://user:pass@example.com/"]) {
    const data = structuredClone(fixture.demographics);
    data.growth.geographies[0].source_url = url;
    const doc = render(data);
    assert.match(doc.querySelector("#regional-growth-chart")?.textContent ?? "", /60,000/);
    assert.equal(doc.querySelector("#regional-growth-chart a"), null);
  }
});

test("positional projection is stable within a package and cannot share keys with another package", () => {
  const data = structuredClone(fixture.demographics);
  data.growth.geographies.push({ ...data.growth.geographies[0] });
  data.age.geographies.push({ ...data.age.geographies[0] });
  data.median_income.geographies.push({ ...data.median_income.geographies[0], value: 99000 });
  const first = projectDemographics(data);
  const again = projectDemographics(data);
  for (const section of ["growth", "household"] as const) {
    assert.deepEqual(
      first[section].map((row) => row.key),
      again[section].map((row) => row.key),
    );
    assert.equal(required(first[section][1]).key, required(again[section][1]).key);
    assert.notEqual(required(first[section][0]).key, required(first[section][1]).key);
    assert.equal(required(first[section][1]).key.position, 1);
    assert.equal(required(first[section][1]).key.publication, data);
  }
  const replacement = projectDemographics(structuredClone(data));
  assert.notEqual(required(first.growth[1]).key.namespace, required(replacement.growth[1]).key.namespace);
  assert.notEqual(required(first.growth[1]).key, required(replacement.growth[1]).key);
  assert.notEqual(required(first.household[1]).key, required(replacement.household[1]).key);
  assert.notEqual(required(first.growth[1]).key.section, required(first.household[1]).key.section);
  assert.equal(required(required(first.household[1]).income).value, 99000);
});

test("mismatched positions remain separate instead of borrowing another row by name", () => {
  const data = structuredClone(fixture.demographics);
  data.median_income.geographies = [{ name: "Income only", value: 90000 }, ...data.median_income.geographies];
  const doc = render(data);
  const rows = [...doc.querySelectorAll("[data-median] tbody tr")];
  assert.equal(rows.length, 3);
  assert.match(required(rows[0]).textContent, /Sample County.*Unknown/);
  assert.match(required(rows[1]).textContent, /Income only.*\$90,000/);
  assert.match(required(rows[2]).textContent, /Sample County.*\$70,000/);
});

test("ordinal labels cannot collide with another published label", () => {
  const data = structuredClone(fixture.demographics);
  data.growth.geographies.push(
    { ...data.growth.geographies[0] },
    { ...data.growth.geographies[0], name: "Sample County (1)" },
  );
  const doc = render(data);
  const labels = [...doc.querySelectorAll('[aria-label="Growth geography"] button')].map(
    (button) => button.textContent,
  );
  assert.equal(new Set(labels).size, labels.length);
});
