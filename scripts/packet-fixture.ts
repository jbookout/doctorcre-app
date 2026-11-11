import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function packetFixturePdf(): Promise<Uint8Array> {
  const recording: unknown = JSON.parse(
    await readFile(new URL("../test/fixtures/packet-parity/text-recording.json", import.meta.url), "utf8"),
  );
  assert.ok(
    recording &&
      typeof recording === "object" &&
      "schema" in recording &&
      recording.schema === "doctorcre-carr-packet-text-recording.v1" &&
      "as_of" in recording &&
      typeof recording.as_of === "string" &&
      "pages" in recording &&
      Array.isArray(recording.pages) &&
      recording.pages.length > 0 &&
      recording.pages.length <= 50,
  );
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const strong = await document.embedFont(StandardFonts.HelveticaBold);
  const fixedDate = new Date(recording.as_of);
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
  document.setTitle("Synthetic packet text fixture");
  for (const draws of recording.pages) {
    assert.ok(Array.isArray(draws) && draws.length > 0 && draws.length <= 200);
    const page = document.addPage([612, 792]);
    for (const draw of draws) {
      assert.ok(
        draw &&
          typeof draw === "object" &&
          "text" in draw &&
          "x" in draw &&
          "y" in draw &&
          "size" in draw &&
          "bold" in draw,
      );
      const { text, x, y, size, bold } = draw;
      assert.ok(
        typeof text === "string" &&
          text.length <= 600 &&
          typeof x === "number" &&
          Number.isFinite(x) &&
          x >= 0 &&
          x <= 612 &&
          typeof y === "number" &&
          Number.isFinite(y) &&
          y >= 0 &&
          y <= 792 &&
          typeof size === "number" &&
          Number.isFinite(size) &&
          size > 0 &&
          size <= 50 &&
          typeof bold === "boolean",
      );
      page.drawText(text, { x, y, size, font: bold ? strong : regular });
    }
  }
  return document.save({ useObjectStreams: false });
}
