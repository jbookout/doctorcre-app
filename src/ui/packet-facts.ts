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
