import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { packetFixturePdf } from "../scripts/packet-fixture.ts";
import { comparePacketStops, observePdf } from "../scripts/packet-pdf-observation.ts";
import { packetFacts } from "../src/ui/packet-facts.ts";
import packet from "./fixtures/packet-parity/packet.json" with { type: "json" };

const expected = packet.properties.map((p) => ({
  property: p.property_ref,
  label: p.route_label,
  name: p.name,
  address: `${p.address} - ${p.suite}`,
  facts: packetFacts(p).map(([, value]) => value),
}));
test("recorded CARR PDF text agrees exactly with the current client fact formatter", async () => {
  const pdf = await observePdf(await packetFixturePdf());
  comparePacketStops(pdf, pdf, expected);
  for (const key of ["property", "label", "name", "address"] as const) {
    const changed = structuredClone(expected);
    assert.ok(changed[0]);
    changed[0][key] += "x";
    assert.throws(() => comparePacketStops(pdf, pdf, changed));
  }
  const changed = structuredClone(expected);
  assert.ok(changed[0]);
  changed[0].facts[1] = "11600 SF";
  assert.throws(() => comparePacketStops(pdf, pdf, changed));
  assert.throws(() => comparePacketStops(pdf, pdf, []));
  assert.throws(() => comparePacketStops(pdf, pdf, [...expected].reverse()));
  assert.throws(() => comparePacketStops(pdf, pdf, expected.slice(1)));
  assert.throws(() => comparePacketStops(pdf, pdf, [...expected, ...expected]));
});
for (const [fixture, code] of [
  ["pass", 0],
  ["near-miss", 1],
] as const)
  test(`packet fact CLI ${fixture} exits ${code}`, () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/prove-packet-facts.ts", "--expected-commit", "1".repeat(40), "--fixture-case", fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, code, result.stdout + result.stderr);
    if (fixture === "near-miss")
      assert.doesNotMatch(result.stdout, /Alpha Health Center|Beta Medical Plaza|11600 SF|1600 SF/);
  });

for (const deadline of ["0", "30001", "NaN"])
  test(`the CLI refuses deadline ${deadline} before acquiring evidence`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/prove-packet-facts.ts",
        "--expected-commit",
        "1".repeat(40),
        "--fixture-case",
        "pass",
        "--timeout-ms",
        deadline,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 78, result.stdout + result.stderr);
  });
