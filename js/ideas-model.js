// V5-UX-B04 — Ideas and Events browse/detail: every decision, no DOM.
//
// AN IDEA IS A LOOP OF KIND `idea` — what add-loop parks when a partner says
// "park that idea". The list is `loop-board` in its summary shape (number,
// label, owner, due date, version) and the detail is one fresh `read-loop`, both
// already pinned for Tasks. This page only reads; parking, editing and closing
// an idea stay where they are written today.
//
// EVENTS HAVE NO READ. No record-layer verb returns events (industry events,
// conferences, a partner's dated appearances), so the Events tab is an absent
// state that names the gap and sends no request. It is never filled with a
// guess, a fixture or another record type dressed up as events.

import { toDay } from "./calendar-model.js";
import { partnerName } from "./task-records-model.js";
import { formatCalendarDate } from "./visual-system.js";

export const IDEA_BOARD_ARGS = Object.freeze({ kind: "idea", status: "open", limit: 300, summary: true });
export const IDEA_TABS = Object.freeze(["ideas", "events"]);
export const EVENTS_ABSENT = "Events: no record-layer read returns events yet, so none are shown here. This is a missing read, not an empty calendar of events.";

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
    field("Source", loop?.source_note),
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
  return `/ideas?${params}`;
}
