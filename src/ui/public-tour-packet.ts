type Fact = { label: string; value: string };
type PublicStop = {
  property_ref: string;
  route_sequence: number;
  route_label: string;
  name: string;
  address: string;
  facts: Fact[];
};
type PublicPoint = {
  property_ref: string;
  route_sequence: number;
  route_label: string;
  latitude: number;
  longitude: number;
};
const fields = [
  ["suite", "Suite"],
  ["property_type", "Property type"],
  ["size", "Size"],
  ["asking_economics", "Asking economics"],
  ["availability", "Availability"],
  ["parking", "Parking"],
] as const;
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid public tour");
  return value;
}
function text(value: unknown): string {
  if (value == null || value === "") return "Unknown";
  if (typeof value !== "string" || value.length > 120) throw new Error("Invalid public fact");
  return value.trim() || "Unknown";
}
function metric(value: unknown): string {
  if (value == null) return "Unknown";
  const row = record(value);
  const number = (n: unknown) => (n == null ? "" : typeof n === "number" && Number.isFinite(n) ? String(n) : text(n));
  const quantity =
    row.value != null ? number(row.value) : [number(row.min), number(row.max)].filter(Boolean).join(" to ");
  if (!quantity) return "Unknown";
  return [
    row.currency == null ? "" : text(row.currency),
    quantity,
    row.unit == null ? "" : text(row.unit),
    row.period == null ? "" : `per ${text(row.period)}`,
  ]
    .filter(Boolean)
    .join(" ");
}
function identity(row: Record<string, unknown>) {
  if (
    typeof row.property_ref !== "string" ||
    !/^property:public:[A-Za-z0-9_-]{16,128}$/.test(row.property_ref) ||
    typeof row.route_sequence !== "number" ||
    !Number.isInteger(row.route_sequence) ||
    row.route_sequence < 1 ||
    typeof row.route_label !== "string" ||
    !/^[A-Za-z0-9]{1,3}$/.test(row.route_label)
  )
    throw new Error("Invalid public stop");
  return { property_ref: row.property_ref, route_sequence: row.route_sequence, route_label: row.route_label };
}
export function parsePublicTourPacket(value: unknown): PublicStop[] {
  const input = record(value);
  if (!Array.isArray(input.stops) || !input.stops.length || input.stops.length > 50)
    throw new Error("Invalid public packet");
  const stops = input.stops
    .map((value) => {
      const row = record(value);
      return {
        ...identity(row),
        name: text(row.name),
        address: text(row.address),
        facts: fields.map(([key, label]) => ({
          label,
          value: key === "size" || key === "asking_economics" ? metric(row[key]) : text(row[key]),
        })),
      };
    })
    .sort((a, b) => a.route_sequence - b.route_sequence);
  if (
    new Set(stops.map((stop) => stop.property_ref)).size !== stops.length ||
    new Set(stops.map((stop) => stop.route_sequence)).size !== stops.length
  )
    throw new Error("Duplicate public stop");
  return stops;
}
export function packetMapPoints(stops: PublicStop[] | null, value: unknown): PublicPoint[] {
  const input = record(value);
  if (!Array.isArray(input.points) || input.points.length > 50) throw new Error("Invalid public map");
  const points = input.points
    .map((value) => {
      const row = record(value);
      if (
        typeof row.latitude !== "number" ||
        !Number.isFinite(row.latitude) ||
        Math.abs(row.latitude) > 90 ||
        typeof row.longitude !== "number" ||
        !Number.isFinite(row.longitude) ||
        Math.abs(row.longitude) > 180
      )
        throw new Error("Invalid public point");
      return { ...identity(row), latitude: row.latitude, longitude: row.longitude };
    })
    .sort((a, b) => a.route_sequence - b.route_sequence);
  if (
    new Set(points.map((point) => point.property_ref)).size !== points.length ||
    new Set(points.map((point) => point.route_sequence)).size !== points.length
  )
    throw new Error("Duplicate public point");
  if (
    stops &&
    (stops.length !== points.length ||
      stops.some((stop, index) => {
        const point = points[index];
        return (
          !point ||
          stop.property_ref !== point.property_ref ||
          stop.route_sequence !== point.route_sequence ||
          stop.route_label !== point.route_label
        );
      }))
  )
    throw new Error("Public packet and map differ");
  return points;
}
export function appendPublicTourFacts(row: HTMLElement, stop: PublicStop) {
  const doc = row.ownerDocument;
  const facts = doc.createElement("dl");
  facts.className = "packet-facts";
  for (const fact of stop.facts) {
    const pair = doc.createElement("div");
    const label = doc.createElement("dt");
    label.textContent = fact.label;
    const value = doc.createElement("dd");
    value.textContent = fact.value;
    pair.append(label, value);
    facts.append(pair);
  }
  const notes = doc.createElement("section");
  notes.className = "packet-notes";
  const title = doc.createElement("h4");
  title.textContent = "My Notes";
  notes.append(title);
  notes.append(...Array.from({ length: 6 }, () => doc.createElement("div")));
  row.append(facts, notes);
}
