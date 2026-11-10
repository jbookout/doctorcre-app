import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
export function assertPublishedPacketText(text: string, packet: ReturnType<typeof parsePublicTourPacket>) {
  const pages = text.split("\f");
  if (!pages.at(-1)?.trim()) pages.pop();
  assert.equal(pages.length, packet.length + 1, "Exactly one PDF page per public property required");
  const expected = [
    normalize(
      [
        "CARR Healthcare Real Estate",
        "Your property tour",
        `${packet.length} ${packet.length === 1 ? "property" : "properties"} in tour order.`,
        "Tour day at a glance",
        ...packet.map((stop, index) => `${index + 1}. ${stop.route_label} · ${stop.name} · ${stop.address}`),
        "Tour map",
        "Properties",
      ].join(" "),
    ),
    ...packet.map((stop) =>
      normalize(
        [
          `Stop ${stop.route_label}`,
          stop.name,
          stop.address,
          ...stop.facts.map((fact) => `${fact.label} ${fact.value}`),
          "My Notes",
        ].join(" "),
      ),
    ),
  ];
  const observed = pages.map(normalize);
  const overview = expected[0];
  if (overview && observed[0] === `${overview} ${packet.map((stop) => stop.route_label).join(" ")}`)
    observed[0] = overview;
  assert.deepEqual(observed, expected, "Published PDF differs from the fixed public template");
}
export async function assertPublishedPacketPdf(bytes: Buffer, packet: ReturnType<typeof parsePublicTourPacket>) {
  assert.ok(bytes.length > 0 && bytes.length <= 5_000_000, "Bounded PDF required");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-", "PDF response required");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, packet.length + 1);
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      assert.ok(
        Math.abs(viewport.width - 612) < 0.01 && Math.abs(viewport.height - 792) < 0.01,
        "Letter PDF page required",
      );
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? " " : "") : "")).join(""));
      page.cleanup();
    }
    assertPublishedPacketText(pages.join("\f"), packet);
  } finally {
    await task.destroy();
  }
}
