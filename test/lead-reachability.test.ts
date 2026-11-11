import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv } from "ajv";
import { marketCounts, visibleLeads } from "../js/leads-model.js";
import { parseReachability, reachabilityText } from "../src/ui/lead-reachability.ts";

const recording = JSON.parse(
  readFileSync(new URL("./fixtures/lead-reachability/producer.json", import.meta.url), "utf8"),
);
const schema = JSON.parse(
  readFileSync(new URL("../contracts/lead-reachability.v2/contract.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, formats: { "date-time": true, date: true, uuid: true } });
const validate = ajv.compile(schema);

test("producer recordings pass copied contract and production reachability parser", () => {
  const pin = JSON.parse(
    readFileSync(new URL("../contracts/lead-reachability.v2/source.json", import.meta.url), "utf8"),
  );
  assert.equal(pin.revision, "6096367f1254d83702ea2ebd86eda8dd7e3bf95d");
  assert.equal(
    pin.sha256,
    createHash("sha256")
      .update(readFileSync(new URL("../contracts/lead-reachability.v2/contract.json", import.meta.url)))
      .digest("hex"),
  );
  for (const row of Object.values(recording.cases)) {
    assert.ok(row && typeof row === "object" && "reachability" in row);
    assert.equal(validate(row.reachability), true, JSON.stringify(validate.errors));
    assert.notEqual(parseReachability(row.reachability), null);
  }
  assert.equal(parseReachability(undefined), null);
  assert.throws(() => parseReachability({ classification: "reachable" }));
});

test("view and composed filters keep exact map and unlocated membership", () => {
  const leads = Object.entries(recording.cases).map(([id, row]) => {
    assert.ok(row && typeof row === "object" && "reachability" in row);
    return {
      ...row,
      id,
      reachability: parseReachability(row.reachability),
      market: "Austin",
      owner: "joe",
      specialty: "Dental",
    };
  });
  const reachable = leads.filter((row) => row.reachability?.classification === "reachable");
  assert.deepEqual(
    visibleLeads(leads, { reachability: "reachable" }).map((row) => row.id),
    reachable.map((row) => row.id),
  );
  for (const reachability of ["", "reachable", "research"]) {
    const filters = { reachability, market: "Austin", owner: "joe", specialty: "Dental", stage: "new" };
    const displayed = visibleLeads(leads, filters)
      .map((row) => row.id)
      .sort();
    const members = marketCounts(leads, filters, (row) => (row.id === "reachable" ? { id: "exact" } : null))
      .flatMap((group) => [...group.unlocatedIds, ...group.locations.flatMap((location) => location.leadIds)])
      .sort();
    assert.deepEqual(members, displayed);
  }
  const unknown = { ...leads[0], id: "legacy", reachability: undefined };
  assert.equal(visibleLeads([unknown], { reachability: "research" }).length, 1);
  assert.match(reachabilityText(undefined), /Unknown/);
});

function contractMutations(value, definition, path = []) {
  const mutations = [];
  const add = (name, change) => mutations.push({ name: `${path.join(".") || "projection"} ${name}`, change });
  const at = (root) => path.reduce((node, key) => node[key], root);
  const replace = (replacement) => (root) => {
    const parent = path.slice(0, -1).reduce((node, key) => node[key], root);
    parent[path.at(-1)] = replacement;
  };
  if (path.length) {
    for (const replacement of [null, {}, [], true, 17, "invalid"])
      add(`replace with ${JSON.stringify(replacement)}`, replace(replacement));
  }
  if (definition.enum) {
    add("unknown enum", replace("future_value"));
    for (const option of definition.enum) add(`enum ${option}`, replace(option));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of definition.required || [])
      add(`missing ${key}`, (root) => { delete at(root)[key]; });
    if (definition.additionalProperties === false)
      add("extra property", (root) => { at(root).future_field = true; });
    for (const [key, child] of Object.entries(definition.properties || {}))
      if (Object.hasOwn(value, key)) mutations.push(...contractMutations(value[key], child, [...path, key]));
  }
  if (Array.isArray(value)) {
    if (definition.maxItems !== undefined)
      add("array over bound", replace(Array.from({ length: definition.maxItems + 1 }, () => value[0])));
    if (definition.uniqueItems && value.length)
      add("duplicate item", replace([...value, value[0]]));
    value.forEach((item, index) => mutations.push(...contractMutations(item, definition.items, [...path, index])));
  }
  return mutations;
}

test("parser agrees with pinned schema on every recording and nested recording mutation", () => {
  for (const [name, row] of Object.entries(recording.cases)) {
    for (const mutation of contractMutations(row.reachability, schema)) {
      const value = structuredClone(row.reachability);
      mutation.change(value);
      const accepted = validate(value);
      let parsed;
      try { parsed = parseReachability(value); } catch { parsed = null; }
      assert.equal(parsed !== null, accepted, `${name}: ${mutation.name}: ${JSON.stringify(validate.errors)}`);
      if (accepted) assert.equal(parsed.classification, value.classification);
    }
  }
});

test("malformed reachable evidence never produces verified Reachable copy", () => {
  const mutations = [
    (value) => { value.usable_route.kind = "telepathy"; },
    (value) => { value.successful_contact = {}; },
    (value) => { value.evidence = [{}]; },
    (value) => { delete value.source_inputs; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(recording.cases.reachable.reachability);
    mutate(value);
    assert.equal(validate(value), false);
    assert.throws(() => reachabilityText(value), { code: "invalid_projection" });
  }
});
