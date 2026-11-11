import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PacketStop = {
  property: string;
  label: string;
  name: string;
  address: string;
  facts: string[];
  brand: string;
  asOf: string;
  appointment: string;
  note: string;
};
export async function observePdf(bytes: Uint8Array): Promise<PacketStop[]> {
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)),
  });
  try {
    const doc = await loading.promise;
    assert.ok(doc.numPages > 0 && doc.numPages <= 51, "One overview and up to fifty property pages required");
    const { info } = await doc.getMetadata();
    if (!info || typeof info !== "object" || !("Creator" in info) || info.Creator !== "CARR Tour Operations 2.0.0")
      throw Object.assign(Error("Packet renderer version is outside the recorded 2.0.0 contract"), { exitCode: 78 });
    const { PDFDocument, PDFName } = await import("pdf-lib");
    const metadata = await PDFDocument.load(bytes);
    const overview = await doc.getPage(1);
    const overviewText = (await overview.getTextContent()).items
      .filter((item) => "str" in item)
      .map((item) => item.str)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const stops: PacketStop[] = [];
    for (let n = 2; n <= doc.numPages; n++) {
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
      const labels = ["Suite", "Property type", "Size", "Asking economics", "Availability", "Parking"];
      const facts = labels.map((label, i) => {
        const y = 570 - i * 49;
        assert.equal(band(y, y, 0, 210), label, "Known PDF fact label and layout required");
        return band(y - 14, y, 210);
      });
      const reference = metadata.getPages()[n - 1]?.node.get(PDFName.of("CARRPropertyRef"));
      assert.ok(reference && "decodeText" in reference && typeof reference.decodeText === "function");
      const ref = String(reference.decodeText());
      const appointment = band(580, 592);
      const note = band(278, 290);
      const label = band(741, 741).replace(/^Stop /, "");
      const name = band(650, 700),
        address = band(607, 622);
      const allowed = [
        `Stop ${label}`,
        name,
        address,
        appointment,
        ...labels.flatMap((label, i) => [label, facts[i]]),
        note,
        "My Notes",
      ];
      const actual = items
        .map((item) => item.str)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const expected = allowed.join(" ").replace(/\s+/g, " ").trim();
      assert.ok(actual === expected, "PDF contains text outside the approved packet fields");
      assert.ok(
        !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/.test(actual),
        "PDF contains contact information",
      );
      assert.ok(/^property:public:[A-Za-z0-9_-]{16,128}$/.test(ref), "Public packet reference required");
      stops.push({
        property: ref,
        label,
        name,
        address,
        facts,
        brand: "CARR Healthcare Real Estate",
        asOf: "",
        appointment,
        note,
      });
    }
    const expectedOverview = [
      "CARR Healthcare Real Estate",
      "Your property tour",
      `${stops.length} ${stops.length === 1 ? "property" : "properties"} in tour order.`,
      "Tour day at a glance",
      ...stops.map(
        (p, i) => `${i + 1}. ${p.label} · ${p.name} · ${p.address}${p.appointment ? ` · ${p.appointment}` : ""}`,
      ),
      "Tour map",
      "Properties",
    ].join(" ");
    assert.ok(
      overviewText === expectedOverview,
      "PDF contains text outside the approved packet fields or ordered overview",
    );
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
