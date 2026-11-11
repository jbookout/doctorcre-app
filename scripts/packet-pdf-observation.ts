import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PacketStop = { property: string; label: string; name: string; address: string; facts: string[] };
export async function observePdf(bytes: Uint8Array): Promise<PacketStop[]> {
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)),
  });
  try {
    const doc = await loading.promise;
    assert.ok(doc.numPages > 0 && doc.numPages <= 50, "One to fifty packet pages required");
    const stops: PacketStop[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const items = (await page.getTextContent()).items.filter((item) => "str" in item);
      const band = (low: number, high: number, left = 0, right = 612) =>
        items
          .filter(
            (item) =>
              item.transform[5] >= low &&
              item.transform[5] <= high &&
              item.transform[4] >= left &&
              item.transform[4] < right,
          )
          .map((item) => item.str)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ");
      assert.ok(band(740, 742, 0, 210) === "CARR", "PDF branding mismatch");
      const labels = ["PROPERTY TYPE", "SIZE", "ASKING ECONOMICS", "AVAILABILITY", "PARKING"];
      const facts = labels.map((label, i) => {
        const y = 563 - i * 58;
        assert.ok(band(y, y, 0, 210) === label, "Known PDF fact label and layout required");
        return band(y - 14, y, 210);
      });
      const ref = band(75, 77);
      assert.ok(/^Packet ref: property:public:[A-Za-z0-9_-]{16,128}$/.test(ref), "Public packet reference required");
      stops.push({
        property: ref.slice("Packet ref: ".length),
        label: band(745, 747),
        name: band(650, 700),
        address: band(590, 640),
        facts,
      });
    }
    return stops;
  } finally {
    await loading.destroy();
  }
}
export function comparePacketStops(preview: PacketStop[], download: PacketStop[], share: PacketStop[]): void {
  assert.ok(preview.length > 0, "Populated packet required");
  assert.ok(isDeepStrictEqual(preview, download), "Preview property fields differ from downloaded PDF");
  assert.ok(isDeepStrictEqual(share, download), "Client share property fields differ from downloaded PDF");
}
