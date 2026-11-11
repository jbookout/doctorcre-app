type SourceEvent = {
  date: string;
  date_type: "date";
  date_basis: "enumeration" | "registry_update" | "publication";
  source: "nppes" | "pecos";
  record_key: string;
  revision: string;
  source_url: string;
  published_on: string;
  observed_at: string;
  meaning: string;
  uncertainty: string;
};
type Timing = { contract: "lead-opportunity-timing.v1"; record_added_at: string } & (
  | { status: "unknown"; events: [] }
  | { status: "supported"; events: [SourceEvent, ...SourceEvent[]] }
);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function day(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}
function instant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  return (
    !!m &&
    day(m[1]) &&
    Number(m[2]) < 24 &&
    Number(m[3]) < 60 &&
    Number(m[4]) < 60 &&
    Number(m[5] ?? 0) < 24 &&
    Number(m[6] ?? 0) < 60 &&
    Number.isFinite(Date.parse(v))
  );
}
function event(v: unknown): v is SourceEvent {
  return (
    object(v) &&
    day(v.date) &&
    v.date_type === "date" &&
    day(v.published_on) &&
    instant(v.observed_at) &&
    ((v.source === "nppes" && (v.date_basis === "enumeration" || v.date_basis === "registry_update")) ||
      (v.source === "pecos" && v.date_basis === "publication")) &&
    [v.record_key, v.revision, v.source_url, v.meaning, v.uncertainty].every(text)
  );
}
function timing(v: unknown): v is Timing {
  return (
    object(v) &&
    v.contract === "lead-opportunity-timing.v1" &&
    instant(v.record_added_at) &&
    Array.isArray(v.events) &&
    ((v.status === "unknown" && v.events.length === 0) ||
      (v.status === "supported" && v.events.length > 0 && v.events.every(event)))
  );
}
export function parseOpportunityTiming(value: unknown): Timing {
  if (!timing(value)) throw Object.assign(Error("Lead timing read refused"), { code: "invalid_projection" });
  return value;
}
const escapeText = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const sourceDay = (v: string) =>
  new Date(`${v}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const businessInstant = (v: string) =>
  new Date(v).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const time = (v: string, label: string) => `<time datetime="${escapeText(v)}">${escapeText(label)}</time>`;
export function timingMarkup(value: Timing | undefined, detail = false): string {
  const added = value
    ? `Added ${time(value.record_added_at, businessInstant(value.record_added_at))}`
    : "Added unavailable";
  const events = value?.events ?? [];
  const evidence = events.length
    ? events
        .map(
          (e) =>
            `<span data-timing-event="${escapeText(e.record_key)}">${escapeText(e.meaning)} ${time(e.date, sourceDay(e.date))}</span>`,
        )
        .join(" · ")
    : "Opportunity timing unknown";
  const full =
    detail && value?.status === "supported"
      ? `<details data-entry-key="opportunity-evidence"><summary>Opportunity evidence details</summary><ul>${value.events
          .map((e) => {
            const source = /^https?:\/\/\S+$/.test(e.source_url)
              ? `<a href="${escapeText(e.source_url)}" rel="noreferrer">${escapeText(e.source_url)}</a>`
              : escapeText(e.source_url);
            return `<li><strong>${escapeText(e.meaning)}</strong><dl><dt>Evidence date</dt><dd>${time(e.date, sourceDay(e.date))}</dd><dt>Date basis</dt><dd>${escapeText(e.date_basis)}</dd><dt>Source</dt><dd>${escapeText(e.source)}</dd><dt>Source record</dt><dd>${escapeText(e.record_key)}</dd><dt>Revision</dt><dd>Revision ${escapeText(e.revision)}</dd><dt>Published</dt><dd>${time(e.published_on, sourceDay(e.published_on))}</dd><dt>Observed</dt><dd>${time(e.observed_at, businessInstant(e.observed_at))}</dd><dt>Source reference</dt><dd>${source}</dd></dl><p>${escapeText(e.uncertainty)}</p></li>`;
          })
          .join("")}</ul></details>`
      : "";
  return `<section class="lead-timing${detail ? " detail-panel" : ""}" aria-label="Lead dates"><p data-timing-added>${added}</p><p data-timing-evidence>${evidence}</p>${full}</section>`;
}
