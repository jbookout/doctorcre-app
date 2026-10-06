// Incident, held-work and request contracts shared by Home, Status and the Control Room.
import { formatClock } from "./visual-system.js";

/** The four reads this page attempts, in the order the coverage line states them. */
export const READS = Object.freeze(["incidents", "work", "needs_joe", "census"]);

export const READ_LABEL = Object.freeze({
  incidents: "Incidents",
  work: "Active work",
  needs_joe: "Requests for Joe",
  census: "Work census",
});

export const STUCK_SILENCE_HOURS = 48;

const SEVERITY = /^SEV-[0-9]$/;
const WORK_REQUEST_REF = /^WR-[0-9]{1,12}$/;
const INCIDENT_REF = /^INC-[0-9]{8}-[0-9]{2}$/;
const HELD_STATES = Object.freeze(["claimed", "in_progress", "verification", "needs_joe", "blocked"]);

const isInteger = (value) => Number.isInteger(value);
const isText = (value) => typeof value === "string" && value.length > 0;
const orNull = (value, check) => value === null || value === undefined || check(value);

/* ------------------------------------------------------------------ payloads */

/**
 * `incident-board`'s own shape. The row keys are the ledger's, not this page's:
 * the recurrence count is `occurrences`, the age is `age_days`, and the ledger's
 * next step is `next_action`.
 */
export function validIncidentBoardPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!isInteger(payload.count) || payload.count < 0) return false;
  if (!Array.isArray(payload.incidents)) return false;
  if (payload.incidents.length !== payload.count) return false;
  if (!payload.by_severity || typeof payload.by_severity !== "object") return false;
  if (!isInteger(payload.ready_to_close) || payload.ready_to_close < 0) return false;
  return payload.incidents.every((row) => row && typeof row === "object"
    && isText(row.ref) && isText(row.title)
    && SEVERITY.test(String(row.severity)) && isText(row.state)
    && orNull(row.age_days, isInteger)
    && orNull(row.owner_actor, isText)
    && isInteger(row.occurrences)
    && orNull(row.next_action, isText)
    && typeof row.ready_to_close === "boolean");
}

/** `current-work-item`'s own shape: held work, plus the work-in-progress limit. */
export function validCurrentWorkItemPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.current)) return false;
  if (!isInteger(payload.count) || payload.count !== payload.current.length) return false;
  const wip = payload.wip;
  if (!wip || typeof wip !== "object") return false;
  if (!isInteger(wip.limit_system_wide) || !isInteger(wip.in_flight)) return false;
  return payload.current.every((row) => row && typeof row === "object"
    && isText(row.human_ref) && isText(row.title)
    && HELD_STATES.includes(row.state)
    && orNull(row.owner, isText) && orNull(row.executor, isText)
    && (row.blocker === null || (row.blocker && isText(row.blocker.code)))
    && typeof row.hours_since_last_change === "number" && row.hours_since_last_change >= 0);
}

/** `current-work-requests`' own shape: the bounded human next actions. */
export function validCurrentWorkRequestsPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.items)) return false;
  return payload.items.every((row) => row && typeof row === "object"
    && isText(row.human_ref) && isText(row.title) && isText(row.state)
    && row.source && typeof row.source === "object"
    && orNull(row.source.label, isText) && orNull(row.source.freshness, isText)
    && orNull(row.next_human_action, isText));
}

/* ------------------------------------------------------------ read bookkeeping */

/**
 * One chip per read that was ATTEMPTED, each stating its own clock. No
 * denominator is produced, because no producer counts collectors and a fixed
 * "of 8" would be a number this page made up.
 *
 * @param {Record<string, {state?: string, observed_at?: string, reason?: string}>} reads
 */
export function coverageLine(reads) {
  const source = reads && typeof reads === "object" ? reads : {};
  return READS.filter((id) => source[id]).map((id) => {
    const read = source[id] || {};
    const name = READ_LABEL[id];
    const clock = read.state === "read" ? formatClock(read.observed_at) : null;
    if (read.state === "read" && clock) return { id, name, state: "read", text: `${name}: updated ${clock}` };
    const reason = read.state === "read" && !clock
      ? "the read carried no readable time"
      : read.reason || "this read did not answer";
    return { id, name, state: "unknown", reason, text: `${name}: unknown (${reason})` };
  });
}

/* --------------------------------------------------------------- incidents */

/** The age the ledger measured, in days, or the word unknown. */
function incidentAgeLabel(days) {
  if (!Number.isInteger(days) || days < 0) return "unknown";
  return days === 1 ? "1 day old" : `${days} days old`;
}

/** One card per incident, carrying only what the read said. */
function incidentCard(row) {
  return {
    ref: row.ref,
    title: row.title,
    severity: row.severity,
    state: row.state,
    age: incidentAgeLabel(row.age_days),
    owner: row.owner_actor || "unknown",
    occurrences: Number.isInteger(row.occurrences) ? row.occurrences : null,
    // VERBATIM, or absent. A recommended next step this page composed itself
    // would be advice the ledger never gave.
    recommendedNext: isText(row.next_action) ? row.next_action : null,
    readyToClose: row.ready_to_close === true,
    blockedBy: isText(row.blocked_by) ? row.blocked_by : null,
    href: canonicalHref(row),
  };
}

/** Grouped by severity, severest first, oldest first inside a severity. */
export function groupedIncidents(incidents, { severity = "all" } = {}) {
  const rows = (Array.isArray(incidents) ? incidents : []).filter((row) => row && SEVERITY.test(String(row.severity)));
  const chosen = severity === "all" ? rows : rows.filter((row) => row.severity === severity);
  const severities = [...new Set(chosen.map((row) => row.severity))].sort();
  return severities.map((value) => ({
    severity: value,
    count: chosen.filter((row) => row.severity === value).length,
    incidents: chosen.filter((row) => row.severity === value).map(incidentCard),
  }));
}

/** Explicit chips, built only from the severities the read actually returned. */
export function incidentFilters(incidents) {
  const rows = Array.isArray(incidents) ? incidents : [];
  const severities = [...new Set(rows.map((row) => row.severity).filter((value) => SEVERITY.test(String(value))))].sort();
  return [
    { id: "all", label: "All", count: rows.length },
    ...severities.map((value) => ({ id: value, label: value, count: rows.filter((row) => row.severity === value).length })),
  ];
}

/**
 * The canonical page for a record, or null. A work request has one, and since
 * V5-UX-C14 an operational incident has one too: `/incidents?ref=<ref>`. Every
 * other kind still has none, and a link invented for it would lead nowhere.
 */
export function canonicalHref(item) {
  const ref = item && typeof item === "object" ? (item.human_ref || item.ref) : item;
  if (typeof ref !== "string") return null;
  if (WORK_REQUEST_REF.test(ref)) return "/work-requests";
  if (INCIDENT_REF.test(ref)) return `/incidents?ref=${encodeURIComponent(ref)}`;
  return null;
}
