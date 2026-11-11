import { z } from "zod";

const stop = z.object({
  property_ref: z.string(),
  route_sequence: z.number().int().positive(),
  route_label: z.string(),
  name: z.string(),
  address: z.string(),
  appointment: z.string().nullable(),
  public_packet_note: z.string().nullable(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })).length(6),
});
const presentation = z.object({
  contractVersion: z.literal("2.1.0"),
  version: z.literal("2.0.0"),
  brand: z.literal("CARR Healthcare Real Estate"),
  title: z.string(),
  summary: z.string(),
  overview: z.string(),
  map: z.string(),
  properties: z.string(),
  notes: z.string(),
  stops: z.array(stop).min(1).max(50),
});
const packet = z.object({ contract_version: z.literal("2.1.0"), renderer_version: z.literal("2.0.0"), presentation });
export function readPacketPresentation(value: unknown) {
  const parsed = packet.safeParse(value);
  return parsed.success ? parsed.data.presentation : null;
}
export function appendPacketPresentation(
  root: HTMLElement,
  value: z.infer<typeof stop> | undefined,
  notesLabel: string,
): void {
  if (!value) throw new Error("Packet stop presentation unavailable");
  const document = root.ownerDocument;
  const paragraph = (className: string, text: string) => {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    root.append(p);
  };
  if (value.appointment) paragraph("packet-appointment", value.appointment);
  const list = document.createElement("dl");
  for (const fact of value.facts) {
    const term = document.createElement("dt"),
      detail = document.createElement("dd");
    term.textContent = fact.label;
    detail.textContent = fact.value;
    list.append(term, detail);
  }
  root.append(list);
  if (value.public_packet_note) paragraph("packet-public-note", value.public_packet_note);
  const notes = document.createElement("h4");
  notes.textContent = notesLabel;
  root.append(notes);
}
