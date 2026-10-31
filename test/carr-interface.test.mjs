import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { composeCarrInterface, entryFileName } from "../scripts/carr-interface.mjs";
import { carrInterface } from "./carr-contract.mjs";
import { routeEntries } from "../js/routes.js";

// Every feature that adds a verb or a route touches these. They stay mergeable
// only if each addition is its own file (or sorted line) and no test keeps a
// second copy of a list or pin that the next feature would have to edit.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = (value) => JSON.stringify(value);

test("one file per entry composes into the contract object every consumer reads", () => {
  const contract = composeCarrInterface([
    ["version.json", json("1.0.0")],
    ["schema.json", json("s")],
    ["mcp_operations/read-b.json", json("read-b")],
    ["mcp_operations/add-a.json", json("add-a")],
    ["http_surfaces/api-v1-x-id.json", json({ value: "/api/v1/x/{id}", order: 0 })],
    ["http_surfaces/api-tours-all.json", json({ value: "/api/tours/*", order: 1 })],
    ["mcp_read_contracts/read-b.json", json({ write: false })],
    ["zeta_feature.json", json({ read: "read-b {}" })],
  ]);
  assert.deepEqual(contract, {
    http_surfaces: ["/api/v1/x/{id}", "/api/tours/*"],
    mcp_operations: ["add-a", "read-b"],
    mcp_read_contracts: { "read-b": { write: false } },
    schema: "s",
    version: "1.0.0",
    zeta_feature: { read: "read-b {}" },
  });
  assert.deepEqual(Object.keys(contract), Object.keys(contract).toSorted(), "the composed text is deterministic");
});

test("a list entry is a string named after itself, so the same addition is the same file", () => {
  assert.equal(entryFileName("/api/v1/call-sessions/{id}/report"), "api-v1-call-sessions-id-report.json");
  assert.equal(entryFileName("read-room"), "read-room.json");
  assert.throws(() => composeCarrInterface([["mcp_operations/other-name.json", json("read-room")]]), /name it read-room\.json/);
  assert.throws(() => composeCarrInterface([["mcp_operations/read-room.json", json({ verb: "read-room" })]]), /JSON string/);
  assert.throws(() => composeCarrInterface([["mcp_read_contracts/a/b.json", json({})]]), /one directory deep/);
  assert.throws(() => composeCarrInterface([["version.txt", "1"]]), /\.json file/);
  assert.throws(() => composeCarrInterface([["producer.json", json({})], ["producer/x.json", json({})]]), /both a file and a directory/);
});

test("parallel surface additions with the same order compose deterministically", () => {
  const files = [
    ["http_surfaces/api-z.json", json({ value: "/api/z", order: 2 })],
    ["http_surfaces/api-a.json", json({ value: "/api/a", order: 2 })],
    ["http_surfaces/api-first.json", json({ value: "/api/first", order: 0 })],
  ];
  assert.deepEqual(composeCarrInterface(files).http_surfaces, ["/api/first", "/api/a", "/api/z"]);
  assert.deepEqual(composeCarrInterface(files.toReversed()), composeCarrInterface(files));
  for (const order of [undefined, -1, 0.5]) {
    assert.throws(() => composeCarrInterface([["http_surfaces/api-a.json", json({ value: "/api/a", order })]]), /nonnegative integer order/);
  }
});

test("the checked-in interface composes with its header and lists", () => {
  assert.equal(carrInterface.schema, "doctorcre-carr-interface.v1");
  assert.match(carrInterface.version, /^\d+\.\d+\.\d+$/);
  assert.ok(carrInterface.mcp_operations.length > 0 && carrInterface.http_surfaces.length > 0);
});

test("route entries are sorted by path so new routes insert apart", () => {
  const paths = routeEntries.map(([path]) => path);
  assert.deepEqual(paths, [...new Set(paths)].sort());
});

test("tests read moving pins and lists from the contract instead of copying them", async () => {
  const copies = [
    [new RegExp(carrInterface.producer.source_commit), "a literal copy of the producer pin"],
    [/routes?\.version,\s*["']\d/, "a literal copy of the route contract version"],
    [/deepEqual\(\s*\w+\.http_surfaces\s*,\s*\[/, "a full copy of http_surfaces"],
    [/mcp_operations\[\s*\w+\s*[-+]\s*\d+\s*\]|mcp_operations\.slice\(/, "an assertion on a verb's sorted neighbours"],
    [/carr-interface\.v1\.json/, "a read of the retired single-file contract"],
  ];
  const offenders = [];
  for (const name of (await readdir(new URL("./", import.meta.url))).filter((file) => file.endsWith(".mjs"))) {
    if (name === "carr-interface.test.mjs") continue;
    const source = await read(`test/${name}`);
    for (const [pattern, what] of copies) if (pattern.test(source)) offenders.push(`${name}: ${what}`);
  }
  assert.deepEqual(offenders, []);
});
