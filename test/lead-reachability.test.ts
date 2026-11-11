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
const ajv = new Ajv({
  strict: false,
  formats: {
    "date-time": (value) =>
      /^\d{4}-\d\d-\d\d[tT ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[zZ]|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    date: (value) => /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)),
    uuid: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,
  },
});
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

type Schema = {
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: Schema;
};
type Mutation = { name: string; change: (root: unknown) => unknown };
function changeAt(root: unknown, path: (string | number)[], change: (value: unknown) => unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return change(root);
  if (Array.isArray(root)) return root.map((value, index) => (index === key ? changeAt(value, rest, change) : value));
  assert.ok(root && typeof root === "object");
  return Object.fromEntries(
    Object.entries(root).map(([field, value]) => [field, field === key ? changeAt(value, rest, change) : value]),
  );
}
function contractMutations(value: unknown, definition: Schema, path: (string | number)[] = []): Mutation[] {
  const mutations: Mutation[] = [];
  const add = (name: string, change: (value: unknown) => unknown) => {
    mutations.push({
      name: `${path.join(".") || "projection"} ${name}`,
      change: (root) => changeAt(root, path, change),
    });
  };
  if (path.length) {
    for (const replacement of [null, {}, [], true, 17, "invalid", ""])
      add(`replace with ${JSON.stringify(replacement)}`, () => replacement);
  }
  if (definition.enum) {
    add("unknown enum", () => "future_value");
    for (const option of definition.enum) add(`enum ${option}`, () => option);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of definition.required || [])
      add(`missing ${key}`, (value) =>
        Object.fromEntries(Object.entries(value || {}).filter(([field]) => field !== key)),
      );
    if (definition.additionalProperties === false)
      add("extra property", (value) => ({ ...Object(value), future_field: true }));
    for (const [key, child] of Object.entries(definition.properties || {}))
      if (Object.hasOwn(value, key))
        mutations.push(...contractMutations(Reflect.get(value, key), child, [...path, key]));
  }
  if (Array.isArray(value)) {
    if (definition.maxItems !== undefined) {
      const length = definition.maxItems + 1;
      add("array over bound", () => Array.from({ length }, () => value[0]));
    }
    if (definition.uniqueItems && value.length) add("duplicate item", () => [...value, value[0]]);
    if (definition.items)
      for (const [index, item] of value.entries())
        mutations.push(...contractMutations(item, definition.items, [...path, index]));
  }
  return mutations;
}

test("parser agrees with pinned schema on every recording and nested recording mutation", (t) => {
  let checked = 0;
  for (const [name, row] of Object.entries(recording.cases)) {
    assert.ok(row && typeof row === "object" && "reachability" in row);
    for (const mutation of contractMutations(row.reachability, schema)) {
      const value = mutation.change(structuredClone(row.reachability));
      const accepted = validate(value);
      let parsed: ReturnType<typeof parseReachability> = null;
      try {
        parsed = parseReachability(value);
      } catch {
        parsed = null;
      }
      assert.equal(parsed !== null, accepted, `${name}: ${mutation.name}: ${JSON.stringify(validate.errors)}`);
      if (accepted) {
        assert.ok(parsed && value && typeof value === "object" && "classification" in value);
        assert.equal(parsed.classification, value.classification);
      }
      checked++;
    }
  }
  t.diagnostic(`${checked} recording mutations agree with the pinned schema`);
});

for (const [name, mutate] of Object.entries({
  route: (value: Record<string, unknown>) => {
    assert.ok(value.usable_route && typeof value.usable_route === "object");
    Reflect.set(value.usable_route, "kind", "telepathy");
  },
  contact: (value: Record<string, unknown>) => {
    value.successful_contact = {};
  },
  evidence: (value: Record<string, unknown>) => {
    value.evidence = [{}];
  },
  inputs: (value: Record<string, unknown>) => {
    delete value.source_inputs;
  },
}))
  test(`malformed reachable ${name} never produces verified Reachable copy`, () => {
    const value = structuredClone(recording.cases.reachable.reachability);
    mutate(value);
    assert.equal(validate(value), false);
    assert.throws(() => reachabilityText(value), { code: "invalid_projection" });
  });
