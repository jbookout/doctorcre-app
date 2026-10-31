import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { carrInterfaceText, composeCarrInterface, entryFileName } from "../scripts/carr-interface.mjs";
import { carrInterface } from "./carr-contract.mjs";
import { routeEntries } from "../js/routes.js";

// Every feature that adds a verb or a route touches these. They stay mergeable
// only if each addition is its own file (or sorted line) and no test keeps a
// second copy of a list or pin that the next feature would have to edit.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = (value) => JSON.stringify(value);
const file = (group, value) => `${group}/${entryFileName(value)}`;

test("one file per entry composes into the contract object every consumer reads", () => {
  const contract = composeCarrInterface([
    ["version.json", json("1.0.0")],
    ["schema.json", json("s")],
    [file("mcp_operations", "read-b"), json("read-b")],
    [file("mcp_operations", "add-a"), json("add-a")],
    [file("http_surfaces", "/api/v1/x/{id}"), json({ value: "/api/v1/x/{id}", order: 0 })],
    [file("http_surfaces", "/api/tours/*"), json({ value: "/api/tours/*", order: 1 })],
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
  assert.equal(entryFileName("/api/v1/call-sessions/{id}/report"), `${Buffer.from("/api/v1/call-sessions/{id}/report").toString("hex")}.json`);
  assert.equal(entryFileName("read-room"), "726561642d726f6f6d.json");
  assert.throws(() => entryFileName("\ud800"), /well-formed Unicode/);
  assert.throws(() => composeCarrInterface([["mcp_operations/other-name.json", json("read-room")]]), /name it/);
  assert.throws(() => composeCarrInterface([[file("mcp_operations", "read-room"), json({ verb: "read-room" })]]), /JSON string/);
  assert.throws(() => composeCarrInterface([["mcp_read_contracts/a/b.json", json({})]]), /one directory deep/);
  assert.throws(() => composeCarrInterface([["version.txt", "1"]]), /\.json file/);
  assert.throws(() => composeCarrInterface([["producer.json", json({})], ["producer/x.json", json({})]]), /both a file and a directory/);
});

test("parallel surface additions with the same order compose deterministically", () => {
  const files = [
    [file("http_surfaces", "/api/z"), json({ value: "/api/z", order: 2 })],
    [file("http_surfaces", "/api/a"), json({ value: "/api/a", order: 2 })],
    [file("http_surfaces", "/api/first"), json({ value: "/api/first", order: 0 })],
  ];
  assert.deepEqual(composeCarrInterface(files).http_surfaces, ["/api/first", "/api/a", "/api/z"]);
  assert.deepEqual(composeCarrInterface(files.toReversed()), composeCarrInterface(files));
  for (const order of [undefined, -1, 0.5]) {
    assert.throws(() => composeCarrInterface([[file("http_surfaces", "/api/a"), json({ value: "/api/a", order })]]), /nonnegative integer order/);
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

test("nested object key permutations retain the same canonical digest and array order", () => {
  const first = { section: { z: [{ y: 2, a: { z: 3, a: 1 } }, "last"], a: 0 } };
  const second = { section: { a: 0, z: [{ a: { a: 1, z: 3 }, y: 2 }, "last"] } };
  const digest = value => createHash("sha256").update(carrInterfaceText(value)).digest("hex");
  assert.equal(digest(first), digest(second));
  assert.deepEqual(JSON.parse(carrInterfaceText(first)), first);
  assert.notEqual(digest(first), digest({ section: { ...first.section, z: first.section.z.toReversed() } }));
});

test("near-identical surface paths have distinct reversible filenames and compose together", () => {
  const paths = ["/api/v1/review-items", "/api/v1/review/items", "GET /api/Items", "GET /api/items", "/api/café"];
  const names = paths.map(entryFileName);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, paths.length);
  for (const [i, name] of names.entries()) {
    assert.equal(Buffer.from(name.slice(0, -5), "hex").toString("utf8"), paths[i]);
  }
  const files = paths.map((value, order) => [`http_surfaces/${entryFileName(value)}`, json({ value, order })]);
  assert.deepEqual(composeCarrInterface(files).http_surfaces, paths);
  assert.throws(() => composeCarrInterface([files[0], [files[0][0], files[1][1]]]), /duplicate.*file/i);
});
