import { PDFDocument, StandardFonts } from "pdf-lib";
import type { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";

export async function packetProofPdf(packet: ReturnType<typeof parsePublicTourPacket>, nearMiss: boolean) {
  const document = await PDFDocument.create();
  document.setSubject("Tour template 2.0.0");
  document.setProducer("CARR deterministic PDF renderer 2.0.0");
  const font = await document.embedFont(StandardFonts.Helvetica);
  const pages = [
    [
      packet.template.brand,
      packet.template.title,
      packet.template.summary,
      packet.template.overview,
      ...packet.map((stop, index) => `${index + 1}. ${stop.route_label} · ${stop.name} · ${stop.address}`),
      packet.template.map,
      packet.template.properties,
    ],
    ...packet.map((stop, index) => [
      `Stop ${stop.route_label}`,
      stop.name,
      stop.address,
      ...stop.facts.map(
        (fact, field) => `${fact.label} ${fact.value}${nearMiss && index === 0 && field === 0 ? " extra" : ""}`,
      ),
      stop.notes,
    ]),
  ];
  for (const lines of pages) {
    const page = document.addPage([612, 792]);
    lines.forEach((line, index) => {
      page.drawText(line, { x: 42, y: 740 - index * 22, size: 11, font });
    });
  }
  return Buffer.from(await document.save());
}
