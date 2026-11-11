import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import type { ReleaseEvidence } from "../scripts/containing-release.ts";
import { classifyTourEvidence, requireTourEvidence } from "../scripts/tour-proof-evidence.ts";

const current = JSON.parse(await readFile(new URL("./fixtures/tour-packet/response.json", import.meta.url), "utf8"));
const legacy = JSON.parse(
  await readFile(new URL("./fixtures/client-links/legacy-producer.json", import.meta.url), "utf8"),
);
async function pdf(template?: string, renderer = "2.0.0") {
  const document = await PDFDocument.create();
  document.addPage();
  if (template) document.setSubject(`Tour template ${template}`);
  document.setProducer(`CARR deterministic PDF renderer ${renderer}`);
  return Buffer.from(await document.save());
}
const packets = [
  { kind: "json", value: current, category: "json_current", ready: true },
  { kind: "json", value: legacy.inputs.packet, category: "json_legacy", ready: false },
  { kind: "pdf", value: await pdf("2.0.0"), category: "pdf_current", ready: true },
  { kind: "pdf", value: await pdf("1.1.0"), category: "pdf_legacy_or_missing", ready: false },
  { kind: "pdf", value: await pdf(), category: "pdf_legacy_or_missing", ready: false },
  { kind: "pdf", value: await pdf("2.0.0", "1.1.0"), category: "pdf_legacy_or_missing", ready: false },
  { kind: "pdf", value: Buffer.from("unreadable"), category: "unreadable", ready: false },
  { kind: "json", value: {}, category: "unreadable", ready: false },
] as const;
for (const release of ["containing", "older", "unrelated", "unknown"] satisfies ReleaseEvidence[])
  for (const [index, packet] of packets.entries())
    test(`evidence matrix ${release} x ${packet.category} (${index})`, async () => {
      const result = await classifyTourEvidence(release, [packet]);
      assert.deepEqual(result.packets, [packet.category]);
      const ready = release === "containing" && packet.ready;
      assert.equal(result.status, ready ? "ready" : "insufficient_evidence");
      if (ready) await requireTourEvidence(release, [packet]);
      else {
        assert.equal(result.status, "insufficient_evidence");
        if (result.status === "insufficient_evidence") assert.ok(result.reason);
        await assert.rejects(requireTourEvidence(release, [packet]), { exitCode: 78 });
      }
    });
test("current JSON cannot hide a stored legacy PDF", async () => {
  await assert.rejects(requireTourEvidence("containing", [packets[0], packets[3]]), { exitCode: 78 });
});
