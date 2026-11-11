type Fact = { label: string; value: string };
type PublicStop = {
  property_ref: string;
  route_sequence: number;
  route_label: string;
  name: string;
  address: string;
  facts: Fact[];
  notes: string;
};
type PublicPoint = {
  property_ref: string;
  route_sequence: number;
  route_label: string;
  latitude: number;
  longitude: number;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid public tour");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new Error("Invalid public fact");
  if (!value.trim()) throw new Error("Missing public fact");
  return value;
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
export class UnsupportedPublicTourPacketError extends Error {
  readonly exitCode = 78;
  constructor(version = "1.x", evidence = "packet format") {
    super(
      `This report uses an older ${evidence} (${version}). Please reopen the shared link after the report service is updated.`,
    );
    this.name = "UnsupportedPublicTourPacketError";
  }
}
export function requireCurrentTourVersion(version: unknown, evidence = "packet format") {
  if (typeof version === "string" && /^(?:(?:0|1)(?:\.x|\.\d+\.\d+(?:-[\w.-]+)?)|2\.0\.0-[\w.-]+)$/.test(version))
    throw new UnsupportedPublicTourPacketError(version, evidence);
  if (version !== "2.0.0") throw new Error(`Unsupported ${evidence}`);
}
export function parsePublicTourPacket(value: unknown) {
  const input = record(value);
  if (!Array.isArray(input.stops) || !input.stops.length || input.stops.length > 50)
    throw new Error("Invalid public packet");
  const presentation = input.presentation === undefined ? { version: "1.x" } : record(input.presentation);
  requireCurrentTourVersion(presentation.version);
  if (!Array.isArray(presentation.stops)) throw new Error("Invalid packet presentation");
  const stops = presentation.stops
    .map((value) => {
      const row = record(value);
      return {
        ...identity(row),
        name: text(row.name),
        address: text(row.address),
        notes: text(presentation.notes),
        facts: (() => {
          if (!Array.isArray(row.facts) || row.facts.length !== 6) throw new Error("Invalid packet facts");
          return row.facts.map((value) => {
            const fact = record(value);
            return { label: text(fact.label), value: text(fact.value) };
          });
        })(),
      };
    })
    .sort((a, b) => a.route_sequence - b.route_sequence);
  if (
    new Set(stops.map((stop) => stop.property_ref)).size !== stops.length ||
    new Set(stops.map((stop) => stop.route_sequence)).size !== stops.length
  )
    throw new Error("Duplicate public stop");
  const ordered = input.stops
    .map((value) => identity(record(value)))
    .sort((a, b) => a.route_sequence - b.route_sequence);
  if (
    stops.length !== ordered.length ||
    stops.some(
      (stop, index) =>
        stop.property_ref !== ordered[index]?.property_ref ||
        stop.route_label !== ordered[index]?.route_label ||
        stop.route_sequence !== ordered[index]?.route_sequence,
    )
  )
    throw new Error("Packet presentation differs from membership");
  return Object.assign(stops, {
    template: {
      title: text(presentation.title),
      summary: text(presentation.summary),
      overview: text(presentation.overview),
      properties: text(presentation.properties),
      brand: text(presentation.brand),
      map: text(presentation.map),
    },
  });
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
  title.textContent = stop.notes;
  notes.append(title);
  notes.append(...Array.from({ length: 6 }, () => doc.createElement("div")));
  row.append(facts, notes);
}
