import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { packetFixturePdf } from "../scripts/packet-fixture.ts";
import { comparePacketStops, observePdf } from "../scripts/packet-pdf-observation.ts";
import { readPacketPresentation } from "../src/ui/packet-facts.ts";
import packet from "./fixtures/packet-parity/share.json" with { type: "json" };

const presentation = readPacketPresentation(packet);
assert.ok(presentation);
const expected = presentation.stops.map((p) => ({
  property: p.property_ref,
  label: p.route_label,
  name: p.name,
  address: p.address,
  facts: p.facts.map((f) => f.value),
  brand: presentation.brand,
  asOf: "",
  appointment: p.appointment || "",
  note: p.public_packet_note || "",
}));
test("recorded CARR PDF text agrees exactly with the current client fact formatter", async () => {
  const pdf = await observePdf(await packetFixturePdf());
  comparePacketStops(pdf, pdf, expected);
  for (const key of ["property", "label", "name", "address", "brand", "asOf", "appointment", "note"] as const) {
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

for (const field of [
  "brand",
  "asOf",
  "appointment",
  "note",
  "property",
  "label",
  "name",
  "address",
  "fact-0",
  "fact-1",
  "fact-2",
  "fact-3",
  "fact-4",
  "unavailable",
]) {
  test(`packet CLI rejects ${field} evidence`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/prove-packet-facts.ts",
        "--expected-commit",
        "1".repeat(40),
        "--fixture-case",
        field === "unavailable" ? field : `near-miss-${field}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, field === "unavailable" ? 78 : 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Alpha Health Center|Beta Medical Plaza|1600 SF/);
  });
}

test("PDF observations reject contacts and internal notes outside displayed fact bands", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  for (const text of ["private@example.invalid", "850-555-0199", "INTERNAL NOTE canary"]) {
    const doc = await PDFDocument.load(await packetFixturePdf());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0];
    assert.ok(page);
    page.drawText(text, { x: 42, y: 140, size: 9, font });
    await assert.rejects(observePdf(await doc.save()), /outside the approved packet fields/);
  }
});

test("a newer producer layout is insufficient evidence for the recorded observer", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await packetFixturePdf());
  doc.setCreator("CARR Tour Operations 3.0.0");
  await assert.rejects(observePdf(await doc.save()), { exitCode: 78 });
});

test("the recorded producer HTML has the same ordered fields as the actual PDF", async () => {
  const { readFile } = await import("node:fs/promises");
  const { JSDOM } = await import("jsdom");
  const html = new JSDOM(await readFile(new URL("./fixtures/packet-parity/packet.html", import.meta.url), "utf8"));
  const pages = Array.from(html.window.document.querySelectorAll('[data-deliverable-page="property"]'));
  assert.equal(pages.length, expected.length);
  for (const [index, page] of pages.entries()) {
    const stop = expected[index];
    assert.ok(stop);
    assert.equal(page.getAttribute("data-property-ref"), stop.property);
    assert.equal(page.querySelector("h2")?.textContent, `Stop ${stop.label}`);
    assert.equal(page.querySelector("h3")?.textContent, stop.name);
    assert.deepEqual(
      Array.from(page.querySelectorAll("dd"), (node) => node.textContent),
      stop.facts,
    );
    assert.deepEqual(
      Array.from(page.querySelectorAll(":scope > p"), (node) => node.textContent),
      [stop.address, ...[stop.appointment, stop.note].filter(Boolean)],
    );
  }
  const pdf = await observePdf(await packetFixturePdf());
  comparePacketStops(pdf, pdf, expected);
});
