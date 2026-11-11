type Metric = {
  value?: string | number;
  min?: string | number;
  max?: string | number;
  currency?: string;
  unit?: string;
  period?: string;
  label?: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
export function packetText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") || fallback : fallback;
}
function packetMetric(value: unknown): string {
  if (!record(value)) return "Not provided";
  for (const [key, entry] of Object.entries(value)) {
    if (
      ["value", "min", "max"].includes(key)
        ? !scalar(entry)
        : !["currency", "unit", "period", "label"].includes(key) || typeof entry !== "string"
    )
      return "Not provided";
  }
  const metric: Metric = value;
  const range =
    metric.value !== undefined
      ? String(metric.value)
      : metric.min !== undefined && metric.max !== undefined
        ? `${metric.min}–${metric.max}`
        : String(metric.min ?? metric.max ?? "");
  if (!range) return "Not provided";
  const amount = metric.currency ? `${metric.currency} ${range}` : range;
  const unit = metric.unit ? `${amount} ${metric.unit}` : amount;
  const period = metric.period ? `${unit} / ${metric.period}` : unit;
  return packetText(metric.label ? `${metric.label}: ${period}` : period);
}
export function packetFacts(value: unknown): [string, string][] {
  const facts = record(value) ? value : {};
  return [
    ["Property type", "property_type"],
    ["Size", "size"],
    ["Asking economics", "asking_economics"],
    ["Availability", "availability"],
    ["Parking", "parking"],
  ].map(([label = "", key = ""]) => [
    label,
    ["size", "asking_economics"].includes(key) ? packetMetric(facts[key]) : packetText(facts[key], "Not provided"),
  ]);
}
export function appendPacketFacts(root: HTMLElement, value: unknown): void {
  const list = document.createElement("dl");
  for (const [label, fact] of packetFacts(value)) {
    const term = document.createElement("dt"),
      detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = fact;
    list.append(term, detail);
  }
  root.append(list);
}

export function packetAsOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1]) return "";
  const date = new Date(value);
  const wallDate = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || wallDate.toISOString().slice(0, 10) !== match[1]) return "";
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `As of ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function appendPacketMetadata(root: HTMLElement, asOf: unknown): void {
  const document = root.ownerDocument;
  const brand = document.createElement("p");
  brand.className = "packet-brand";
  brand.textContent = "CARR";
  root.append(brand);
  const display = packetAsOf(asOf);
  if (display && typeof asOf === "string") {
    const time = document.createElement("time");
    time.className = "packet-as-of";
    time.dateTime = new Date(asOf).toISOString();
    time.textContent = display;
    root.append(time);
  }
}
