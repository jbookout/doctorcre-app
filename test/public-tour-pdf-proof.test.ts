import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { assertPublishedPacketText } from "../scripts/public-tour-pdf-proof.ts";
import { requireTourEvidence } from "../scripts/tour-proof-evidence.ts";
import { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { presentedPacket } from "./packet-presentation.fixture.ts";

const packet = parsePublicTourPacket(
  presentedPacket(
    [3, 1, 2].map((n) => ({
      property_ref: `property:public:synthetic_stop_000${n}`,
      route_sequence: n,
      route_label: String(n),
      name: `Example ${n}`,
      address: `${n} Example Street`,
    })),
  ),
);
const pages = packet.map((stop) =>
  [
    `Stop ${stop.route_label}`,
    stop.name,
    stop.address,
    ...stop.facts.map((fact) => `${fact.label} ${fact.value}`),
    "My Notes",
  ].join("\n"),
);
pages.unshift(
  [
    "CARR Healthcare Real Estate",
    "Your property tour",
    "3 properties in tour order.",
    "Tour day at a glance",
    ...packet.map((stop, index) => `${index + 1}. ${stop.route_label} · ${stop.name} · ${stop.address}`),
    "Tour map",
    "Properties",
  ].join("\n"),
);
test("published PDF compares exact ordered facts and visible unknowns", () => {
  assertPublishedPacketText(`${pages.join("\f")}\f`, packet);
});
for (const [name, text] of [
  ["reordered pages", [pages[0], pages[2], pages[1], pages[3]].join("\f")],
  ["near miss scalar", pages.join("\f").replace("Suite Unknown", "Suite Unknown extra")],
  ["hidden canonical identifier", `${pages.join("\f")}\nproperty:public:synthetic_stop_0001`],
  ["outside allowlist field", `${pages.join("\f")}\nbroker_notes PRIVATE_SENTINEL`],
  ["silent unknown", pages.join("\f").replace("Parking Unknown", "PARKING")],
  ["extra property page", [...pages, pages[0]].join("\f")],
] as const)
  test(`published PDF refuses ${name}`, () => {
    assert.throws(() => assertPublishedPacketText(text, packet));
  });

for (const kind of ["template", "renderer"] as const)
  test(`stored PDF with legacy ${kind} is insufficient before current-content assertions`, async () => {
    const document = await PDFDocument.create();
    document.setSubject(`Tour template ${kind === "template" ? "1.1.0" : "2.0.0"}`);
    document.setProducer(`CARR deterministic PDF renderer ${kind === "renderer" ? "1.1.0" : "2.0.0"}`);
    document.addPage();
    await assert.rejects(
      requireTourEvidence("containing", [{ kind: "pdf", value: Buffer.from(await document.save()) }]),
      {
        name: "Error",
        exitCode: 78,
        message: `This report uses an older PDF ${kind} (1.1.0). Please reopen the shared link after the report service is updated.`,
      },
    );
  });
