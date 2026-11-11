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
