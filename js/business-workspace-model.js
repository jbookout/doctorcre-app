// V5-UX-B01 — what the business Home shows, decided without a DOM.
//
// The command-center payload itself is validated and summarised by
// js/workspace-command-center-model.js, which this slice reuses unchanged. What
// lives here is only what that model does not decide: the ORDER of the Home
// sections, which read feeds each one, the Team review arithmetic, the This
// week and Waiting on others projections, and the words a section uses when
// its read cannot be verified.
//
// Team review is the viewer's share of the team totals and nothing else. It is
// never a per-partner comparison: the payload carries exactly two scopes, team
// and mine, so a comparison between two named people cannot be computed from it
// and must not be implied by the words around it.
//
// This week and Waiting on others do NOT come from the command-centre payload.
// Its `this_week` and `recent_calls` arrays are declared always-empty by that
// contract, so reading them would paint a verified-looking zero nobody asked
// for. Each section reads its own pinned verb instead — `today-triage` and
// `loop-board` — and is verified or unverified by that read alone.
import {
  MY_FLAGGED_DESTINATION, SCOPES, TEAM_ACTIVE_DESTINATION, TEAM_FLAGGED_DESTINATION,
  safeDestination, validWorkspacePayload,
} from "./workspace-command-center-model.js";
import { normalizeBoardRow, scopeRows, validBoardPayload } from "./task-records-model.js";

/** The Home sections, in the order the page renders them. */
export const HOME_SECTIONS = Object.freeze(["needs_action", "this_week", "waiting_on_others", "pipeline", "changes", "doc_at_work", "calls", "quick_add", "team_review"]);

export const SECTION_TITLE = Object.freeze({
  needs_action: "Needs action",
  this_week: "This week",
  waiting_on_others: "Waiting on others",
  pipeline: "Pipeline",
  changes: "Changes",
  doc_at_work: "Doc at work",
  calls: "Calls",
  quick_add: "Quick add",
  team_review: "Team review",
});

/**
 * Which read feeds each section. `null` is a section no read feeds: Quick add
 * is a form, and Calls has no read because none exists — `log-outreach` writes
 * a call to the record layer, and no verb returns logged calls back.
 */
export const SECTION_READ = Object.freeze({
  needs_action: "command-center",
  this_week: "today-triage",
  waiting_on_others: "loop-board",
  pipeline: "command-center",
  changes: "command-center",
  doc_at_work: "command-center",
  calls: null,
  quick_add: null,
  team_review: "command-center",
});

/** The one sentence Calls says. It is literal in the page; no renderer writes it. */
export const CALLS_ABSENT = "Calls: no record-layer read returns logged calls yet";

/** `today-triage` answers at most this many rows (`limit 50` in its handler). */
export const TRIAGE_ROW_CAP = 50;

/** `loop-board`'s own ceiling on `limit`. */
export const WAITING_ROW_CAP = 300;

/** How many days, today included, the This week section covers. */
export const THIS_WEEK_DAYS = 7;

/** The triage kinds that are dated work. `ingest` is an inbox, not a date. */
const THIS_WEEK_KIND = Object.freeze({
  next_action: "Follow-up",
  post_call_action: "After the call",
  critical_date: "Critical date",
});
const KIND_ORDER = Object.freeze(["next_action", "post_call_action", "critical_date"]);

const NEED_LABEL = {
  team_flagged_deals: "Flagged team deals",
  my_flagged_deals: "Your flagged deals",
  needs_joe_work: "System requests for Joe",
};

/** The one sentence a section is allowed to say when its own read is not verified. */
export function unavailableCopy(section) {
  return ({
    needs_action: "Flagged work could not be verified",
    this_week: "This week's dates could not be verified",
    waiting_on_others: "Waiting work could not be verified",
    pipeline: "Deal counts could not be verified",
    changes: "Recent changes could not be verified",
    doc_at_work: "Work in progress could not be verified",
    team_review: "Your share could not be verified",
  })[section] || "This read could not be verified";
}

export function needLabel(kind) {
  return NEED_LABEL[kind] || "Flagged work";
}

/**
 * Ordered section descriptors. A command-centre section is verified by that
 * payload; a section with a read of its own is verified by `reads[id]` and by
 * nothing else, so one failed read never blanks a section it does not feed.
 * A section that cannot be verified is still a section a person is looking at,
 * so it is listed with `state: "unavailable"` rather than dropped.
 */
export function homeSections(payload, reads = {}) {
  const valid = validWorkspacePayload(payload);
  return HOME_SECTIONS.map((id) => {
    const read = SECTION_READ[id];
    let state;
    if (id === "quick_add") state = "static";
    else if (read === null) state = "absent";
    else if (read === "command-center") state = valid ? "read" : "unavailable";
    else state = reads?.[id] === "read" ? "read" : "unavailable";
    return { id, title: SECTION_TITLE[id], state, fromRead: read !== null };
  });
}

/* ---------------------------------------------------------------- dates */

/**
 * A calendar day as `YYYY-MM-DD`, or null. The record layer's DATE columns
 * reach the browser either as that string or — through node-pg, which turns a
 * DATE into a Date — as a midnight timestamp, so the leading day is taken from
 * either, and only when it is a real day.
 */
export function isoDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value.slice(0, 10) : null;
}

const DAY_MS = 86_400_000;
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const addDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How far a due day is from today, in words a person reads without arithmetic. */
export function dueWords(offset) {
  if (offset < 0) return `${-offset} ${offset === -1 ? "day" : "days"} overdue`;
  if (offset === 0) return "Due today";
  if (offset === 1) return "Due tomorrow";
  return `Due in ${offset} days`;
}

/* ------------------------------------------------------------ This week */

const UNAVAILABLE_WEEK = Object.freeze({ state: "unavailable", rows: Object.freeze([]), overdue: 0, capped: false });

/**
 * This week, from one `today-triage` answer: the dated work due between now and
 * the seventh day, with anything already overdue kept at the top rather than
 * dropped. The inbox rows the same verb returns are not dates and are left out.
 *
 * A dated row this page cannot read — no identity, no real day — refuses the
 * whole read. Showing the rows around it would present a week with a hole in
 * it as though it were the whole week.
 *
 * `capped` is true when the answer is exactly as long as the verb's own row
 * limit: later dates may exist that it did not return, and the section says so.
 */
export function thisWeekView(payload, { today } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.items)) return UNAVAILABLE_WEEK;
  const now = isoDay(today);
  if (!now) return UNAVAILABLE_WEEK;
  const last = addDays(now, THIS_WEEK_DAYS - 1);
  const rows = [];
  for (const item of payload.items) {
    if (!item || typeof item !== "object" || !Object.hasOwn(THIS_WEEK_KIND, item.item_kind)) continue;
    const due = isoDay(item.due_on);
    const id = item.id === null || item.id === undefined ? "" : String(item.id);
    if (!due || !id) return UNAVAILABLE_WEEK;
    if (due > last) continue;
    const offset = dayNumber(due) - dayNumber(now);
    const kindLabel = THIS_WEEK_KIND[item.item_kind];
    rows.push(Object.freeze({
      id,
      kind: item.item_kind,
      kindLabel,
      what: typeof item.what === "string" && item.what.trim() ? item.what.trim() : kindLabel,
      subject: typeof item.subject_name === "string" && item.subject_name.trim() ? item.subject_name.trim() : null,
      ref: typeof item.subject_ref === "string" && item.subject_ref ? item.subject_ref : null,
      owner: typeof item.owner === "string" && item.owner ? item.owner.toLowerCase() : null,
      due,
      offset,
      overdue: offset < 0,
    }));
  }
  rows.sort((a, b) => a.due.localeCompare(b.due) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.what.localeCompare(b.what));
  return Object.freeze({
    state: "read",
    rows: Object.freeze(rows),
    overdue: rows.filter((row) => row.overdue).length,
    capped: payload.items.length >= TRIAGE_ROW_CAP,
  });
}

/**
 * The seven-day rail drawn above the list: one cell per day, counting the SAME
 * rows the list shows, plus how many are already overdue. It is paint — the
 * list is the content — so it never carries a row the list does not.
 */
export function weekRail(rows, today) {
  const now = isoDay(today);
  if (!now) return { overdue: 0, days: [] };
  const list = Array.isArray(rows) ? rows : [];
  const days = Array.from({ length: THIS_WEEK_DAYS }, (_, index) => {
    const day = addDays(now, index);
    return {
      day,
      label: WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()],
      count: list.filter((row) => row.due === day).length,
      today: index === 0,
    };
  });
  return { overdue: list.filter((row) => row.overdue).length, days };
}

/* ---------------------------------------------------- Waiting on others */

const UNAVAILABLE_WAITING = Object.freeze({ state: "unavailable", rows: Object.freeze([]), held: 0, capped: false });

/**
 * Waiting on others, from one `loop-board` answer: the partnership's open work
 * whose blocker is a named counterparty — a landlord, broker, client or vendor
 * outside the team. A `human_only` blocker is the partner's own task, not a
 * wait, so it never appears here.
 *
 * The row rules are the Tasks page's own (normalizeBoardRow, scopeRows), so a
 * record looks the same here as it does there. A wait owned by the system or
 * by two people at once is counted in `held` rather than dropped: the board
 * holds it, and the section says where to find it.
 *
 * Overdue follow-ups first, then the soonest follow-up date, then undated waits.
 */
export function waitingView(payload, { today } = {}) {
  if (!validBoardPayload(payload)) return UNAVAILABLE_WAITING;
  const now = isoDay(today);
  const rows = payload.loops.map(normalizeBoardRow).filter((row) => row && row.blocker_class === "counterparty");
  const { visible, systemOwned } = scopeRows(rows, { scope: "team" });
  const shaped = visible.map((row) => {
    const due = isoDay(row.due_on);
    const offset = due && now ? dayNumber(due) - dayNumber(now) : null;
    return Object.freeze({
      number: row.number,
      kind: row.kind,
      title: row.title,
      owner: row.owner,
      waitingOn: row.blocker_detail || null,
      since: row.since_text || null,
      due,
      offset,
      overdue: offset !== null && offset < 0,
    });
  });
  const numeric = (value) => Number.parseInt(String(value).replace(/\D/g, ""), 10) || Number.MAX_SAFE_INTEGER;
  shaped.sort((a, b) => Number(b.overdue) - Number(a.overdue)
    || (a.due === null) - (b.due === null)
    || (a.due && b.due ? a.due.localeCompare(b.due) : 0)
    || numeric(a.number) - numeric(b.number));
  return Object.freeze({
    state: "read",
    rows: Object.freeze(shaped),
    held: systemOwned.length,
    capped: payload.count >= WAITING_ROW_CAP,
  });
}

/* ------------------------------------------------------ ambient + motion */

/**
 * The orb beside a section's title, chosen from what the section actually
 * holds: overdue is urgent, due within a day asks for attention, anything else
 * on the list breathes calmly, and an empty list is still. A read that has not
 * answered refreshes; one that failed is unknown.
 */
export function sectionPulse(view) {
  if (!view || typeof view !== "object") return "unknown";
  if (view.state === "loading") return "refreshing";
  if (view.state !== "read") return "unknown";
  const rows = Array.isArray(view.rows) ? view.rows : [];
  if (rows.some((row) => row.overdue)) return "urgent";
  if (rows.some((row) => Number.isInteger(row.offset) && row.offset <= 1)) return "attention";
  return rows.length ? "healthy" : "still";
}

/**
 * The integers a count passes through on its way to `to`. Reduced motion, or a
 * count that has not changed, is the final value alone: the number lands, it
 * does not travel.
 */
export function countFrames(from, to, { reduced = false, frames = 12 } = {}) {
  const target = Number.isInteger(to) ? to : 0;
  const start = Number.isInteger(from) ? from : 0;
  if (reduced || start === target) return [target];
  const easeOut = (t) => 1 - (1 - t) ** 3;
  return Array.from({ length: frames }, (_, index) => {
    const step = (index + 1) / frames;
    return index === frames - 1 ? target : Math.round(start + (target - start) * easeOut(step));
  });
}

/**
 * The viewer's share of the team totals: two rows, each stating the personal
 * number and the team number it sits inside. `of` is deliberately part of the
 * label — "3 of 11" is a share, and no ordering between partners exists here.
 */
export function teamReviewRows(metrics) {
  if (!Array.isArray(metrics) || metrics.length !== SCOPES.length) return [];
  const [team, mine] = metrics;
  const integer = (value) => Number.isInteger(value) && value >= 0;
  if (![team?.active_deals, team?.flagged_deals, mine?.active_deals, mine?.flagged_deals].every(integer)) return [];
  if (mine.active_deals > team.active_deals || mine.flagged_deals > team.flagged_deals) return [];
  return [
    {
      id: "active",
      label: "Your active deals",
      mine: mine.active_deals,
      team: team.active_deals,
      value: `${mine.active_deals} of ${team.active_deals}`,
      // "mine, active" has no Deal Room URL form, so the row opens the team list it sits inside.
      destination: safeDestination(TEAM_ACTIVE_DESTINATION),
    },
    {
      id: "flagged",
      label: "Your flagged",
      mine: mine.flagged_deals,
      team: team.flagged_deals,
      value: `${mine.flagged_deals} of ${team.flagged_deals}`,
      destination: safeDestination(mine.flagged_deals ? MY_FLAGGED_DESTINATION : TEAM_FLAGGED_DESTINATION),
    },
  ];
}
