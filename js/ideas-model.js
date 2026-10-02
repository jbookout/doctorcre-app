// V5-UX-B04 — Ideas and Events browse/detail: every decision, no DOM.
//
// AN IDEA IS A LOOP OF KIND `idea` — what add-loop parks when a partner says
// "park that idea". The list is `loop-board` in its summary shape (number,
// label, owner, due date, version) and the detail is one fresh `read-loop`, both
// already pinned for Tasks. This page only reads; parking, editing and closing
// an idea stay where they are written today.
//
// Events are sourced industry-event records. The read's shape decides whether
// this page may say there are zero events; a failed read never becomes empty.

import { toDay } from "./calendar-model.js";
import { partnerName } from "./task-records-model.js";
import { formatCalendarDate } from "./visual-system.js";

export const IDEA_BOARD_ARGS = Object.freeze({ kind: "idea", status: "open", limit: 300, summary: true });
export const IDEA_TABS = Object.freeze(["ideas", "events"]);
export const EVENT_LIST_LIMIT = 100; // CARR's list-industry-events maximum; it has no next-page input.

const NOT_RECORDED = "not recorded";

export function validIdeaBoard(payload) {
  return Array.isArray(payload?.loops);
}

/** One summary row, or null when it is not an idea this page can open. */
export function normalizeIdea(row) {
  if (!row || typeof row !== "object") return null;
  if (row.kind !== undefined && row.kind !== "idea") return null;
  const number = row.number === null || row.number === undefined ? "" : String(row.number).trim();
  if (!number) return null;
  const label = typeof row.label === "string" && row.label.trim() ? row.label.trim()
    : typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled idea";
  return {
    number,
    label,
    owner: typeof row.owner === "string" && row.owner ? row.owner : null,
    since_text: typeof row.since_text === "string" && row.since_text ? row.since_text : null,
    due_on: toDay(row.due_on ?? null),
    version: Number.isInteger(row.version) ? row.version : null,
  };
}

/** Case-insensitive match on the label, the number (with or without #) and the owner. */
export function filterIdeas(rows, query) {
  const needle = String(query || "").trim().toLowerCase().replace(/^#/, "");
  if (!needle) return rows.slice();
  return rows.filter((row) => row.label.toLowerCase().includes(needle)
    || row.number.toLowerCase() === needle
    || (row.owner && (row.owner.toLowerCase() === needle || partnerName(row.owner).toLowerCase() === needle)));
}

export function ideasPhase({ status, rows = [], shown = [] } = {}) {
  if (status === "loading") return "loading";
  if (status === "unauthorized") return "unauthorized";
  if (status !== "ready") return "unavailable";
  if (rows.length === 0) return "empty";
  if (shown.length === 0) return "no_match";
  return "ready";
}

export function eventReadState(answer) {
  if (answer?.ok !== true || !Array.isArray(answer.events) || answer.count !== answer.events.length
    || answer.count > EVENT_LIST_LIMIT) {
    return { status: "error", rows: [] };
  }
  const valid = answer.events.every((row) => row && typeof row.id === "string"
    && typeof row.title === "string" && typeof row.source === "string"
    && typeof row.owner_partner === "string" && Number.isInteger(row.version)
    && !Number.isNaN(Date.parse(row.starts_at)) && !Number.isNaN(Date.parse(row.ends_at)));
  if (!valid) return { status: "error", rows: [] };
  return { status: answer.count === EVENT_LIST_LIMIT ? "partial" : "ready", rows: [...answer.events].sort((a, b) =>
    Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id)) };
}

export function eventPhase({ status, rows = [] } = {}) {
  if (status === "loading") return "loading";
  if (status === "unauthorized") return "unauthorized";
  if (status === "partial") return "partial";
  if (status !== "ready") return "unavailable";
  return rows.length ? "ready" : "empty";
}

const EVENT_KINDS = ["conference", "association_meeting", "trade_show", "networking"];
const ATTENDANCE = ["considering", "plan_to_attend", "not_attending"];
const EVENT_STATUSES = ["planned", "attended", "skipped", "cancelled"];

/** Browser-local date/time fields become explicit timezone-bearing timestamps. */
export function eventWriteRequest(fields, current = null) {
  const text = (name) => String(fields[name] ?? "").trim();
  const required = ["title", "organizer", "source"];
  if (required.some((name) => !text(name))) return { ok: false, error: "Enter a title, organizer, and reference." };
  if (!EVENT_KINDS.includes(fields.kind) || !ATTENDANCE.includes(fields.attendance_intent)
    || !EVENT_STATUSES.includes(fields.status) || !["joe", "dell"].includes(fields.owner_partner)) {
    return { ok: false, error: "Choose an event type, attendance plan, owner, and status." };
  }
  const start = new Date(fields.starts_at);
  const end = new Date(fields.ends_at);
  if (!fields.starts_at || !fields.ends_at || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())
    || end <= start) return { ok: false, error: "Enter an end time after the start time." };
  if (text("url")) {
    try {
      if (!["https:", "http:"].includes(new URL(text("url")).protocol)) throw new Error("protocol");
    } catch { return { ok: false, error: "Enter a website starting with https:// or http://." }; }
  }
  if (current && (!current.id || !Number.isInteger(current.version))) {
    return { ok: false, error: "Event updating." };
  }
  return { ok: true, args: {
    title: text("title"), organizer: text("organizer"), kind: fields.kind,
    starts_at: start.toISOString(), ends_at: end.toISOString(),
    location: text("location") || null, is_virtual: fields.is_virtual === true,
    url: text("url") || null, relevance_note: text("relevance_note") || null,
    attendance_intent: fields.attendance_intent, owner_partner: fields.owner_partner,
    status: fields.status, source: text("source"),
    ...(current ? { event_id: current.id, base_version: current.version } : {}),
  } };
}

export function eventWriteOutcome(error) {
  if (error?.status === 401 || error?.status === 403) return "unauthorized";
  if (error?.payload?.error === "industry_event_version_conflict") return "conflict";
  if (error?.payload?.error) return "refused";
  return "unknown";
}

const EVENT_FIELD_LABELS = [
  ["title", "Event name"], ["organizer", "Organizer"], ["kind", "Type"],
  ["starts_at", "Starts"], ["ends_at", "Ends"], ["location", "Location"],
  ["is_virtual", "Virtual event"], ["url", "Website"],
  ["relevance_note", "Why it matters"], ["attendance_intent", "Attendance"],
  ["owner_partner", "Owner"], ["status", "Status"], ["source", "Reference"],
];

export function eventChangedFields(before, latest) {
  return EVENT_FIELD_LABELS.filter(([field]) => before?.[field] !== latest?.[field])
    .map(([field, label]) => ({ field, label, value: latest?.[field] ?? null }));
}

export function eventLocalDateTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** What a fresh read-loop answer means for this page. */
export function ideaReadState(answer) {
  if (!answer || typeof answer !== "object") return { state: "unavailable" };
  if (answer.error === "ambiguous_number") return { state: "ambiguous" };
  if (answer.error || !answer.loop) return { state: "not_found" };
  if (answer.loop.kind !== "idea") return { state: "not_found" };
  return { state: "ready", loop: answer.loop };
}

function field(label, value) {
  const known = value !== null && value !== undefined && String(value).trim() !== "";
  return { label, known, text: known ? String(value) : NOT_RECORDED };
}

function capitalised(value) {
  if (!value) return null;
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

/** The label/value rows of the detail popup. A missing value says so. */
export function ideaDetailRows(loop) {
  const due = toDay(loop?.due_on ?? null);
  return [
    field("Number", loop?.number ? `#${loop.number}` : null),
    field("Owner", loop?.owner ? partnerName(loop.owner) : null),
    field("Domain", capitalised(loop?.domain)),
    field("Opened", loop?.created_at ? formatCalendarDate(loop.created_at) : null),
    field("Last changed", loop?.updated_at ? formatCalendarDate(loop.updated_at) : null),
    field("Due", due ? formatCalendarDate(due) : null),
    field("Reference", loop?.source_note),
    field("Status", loop?.status),
  ];
}

/* ---------------------------------------------------------------- URL memory */

export function parseIdeasState(search) {
  const params = new URLSearchParams(search || "");
  const tab = IDEA_TABS.includes(params.get("tab")) ? params.get("tab") : "ideas";
  const idea = /^\d{1,9}$/.test(params.get("idea") || "") ? params.get("idea") : null;
  const q = (params.get("q") || "").slice(0, 200);
  return { tab, q, idea };
}

export function ideasHref(state) {
  const params = new URLSearchParams({ tab: state.tab });
  if (state.q) params.set("q", state.q);
  if (state.idea) params.set("idea", state.idea);
  return `/ideas-events?${params}`;
}
