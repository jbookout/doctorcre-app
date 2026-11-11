export type MeetingQuery = { view: "suggested" | "research"; q: string; limit: number; cursor?: string };
type Contact = { id: string; name: string; email: string | null; phone: string | null; cell: string | null };
type Office = {
  street_address: string;
  city: string;
  state: string;
  finding_id: string;
  source: string;
  observed_at: string;
  expires_on: string | null;
};
type Meeting = { title: string; start: string; end: string; location: string | null };
type MeetingPerson = {
  vendor_id: string;
  ref: string;
  contact: Contact | null;
  company: { id: string; name: string } | null;
  office: Office | null;
  reason: string | null;
  missing: string[];
  possible_meetings: Meeting[];
};
export type MeetingPage = {
  schema: "vendor-meetings.v1";
  view: MeetingQuery["view"];
  total: number;
  items: MeetingPerson[];
  has_more: boolean;
  next_cursor: string | null;
  calendar: { state: "ready" | "empty" | "partial" | "unavailable"; notes?: string[] };
};
const missingLabels: Record<string, string> = {
  named_contact: "A named contact is needed",
  company: "Company is not recorded",
  category: "Vendor category is not recorded",
  workable_vendor: "Vendor is not marked workable",
  in_market: "Vendor is outside the market",
  meeting_reason: "A meeting reason is needed",
  verified_office: "A verified office is needed",
  contact_permission: "Contact permission needs review",
};
export const researchReason = (key: string) => missingLabels[key] ?? `Needs research: ${key}`;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
function contact(value: unknown): value is Contact {
  return (
    object(value) &&
    text(value.id) &&
    text(value.name) &&
    nullableText(value.email) &&
    nullableText(value.phone) &&
    nullableText(value.cell)
  );
}
function office(value: unknown): value is Office {
  return (
    object(value) &&
    [value.street_address, value.city, value.state, value.finding_id, value.source, value.observed_at].every(
      (v) => text(v) && v.trim().length > 0,
    ) &&
    nullableText(value.expires_on)
  );
}
function person(value: unknown): value is MeetingPerson {
  return (
    object(value) &&
    text(value.vendor_id) &&
    text(value.ref) &&
    (value.contact === null || contact(value.contact)) &&
    (value.company === null || (object(value.company) && text(value.company.id) && text(value.company.name))) &&
    (value.office === null || office(value.office)) &&
    nullableText(value.reason) &&
    Array.isArray(value.missing) &&
    value.missing.every(text) &&
    Array.isArray(value.possible_meetings) &&
    value.possible_meetings.every(
      (m) => object(m) && text(m.title) && text(m.start) && text(m.end) && nullableText(m.location),
    )
  );
}
export function parseMeetingPage(value: unknown, query: MeetingQuery): MeetingPage {
  if (
    !object(value) ||
    value.schema !== "vendor-meetings.v1" ||
    value.view !== query.view ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > query.limit ||
    !value.items.every(person) ||
    typeof value.has_more !== "boolean" ||
    !nullableText(value.next_cursor) ||
    (value.has_more ? !value.next_cursor : value.next_cursor !== null) ||
    !object(value.calendar) ||
    !["ready", "empty", "partial", "unavailable"].includes(String(value.calendar.state)) ||
    (value.calendar.notes !== undefined && (!Array.isArray(value.calendar.notes) || !value.calendar.notes.every(text)))
  )
    throw new Error("Invalid vendor meeting response");
  if (
    value.items.some((row) =>
      query.view === "suggested"
        ? !row.contact?.name.trim() || !row.office || !row.reason?.trim() || row.missing.length !== 0
        : row.missing.length === 0,
    )
  )
    throw new Error("Invalid vendor meeting membership");
  const state = value.calendar.state;
  if (state !== "ready" && state !== "empty" && state !== "partial" && state !== "unavailable")
    throw new Error("Invalid calendar state");
  return {
    schema: "vendor-meetings.v1",
    view: query.view,
    total: value.total,
    items: value.items,
    has_more: value.has_more,
    next_cursor: value.next_cursor,
    calendar: { state, ...(Array.isArray(value.calendar.notes) ? { notes: value.calendar.notes } : {}) },
  };
}
