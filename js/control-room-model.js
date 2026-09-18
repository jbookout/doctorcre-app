// V5-UX-C01 — what the Control Room shows, decided without a DOM.
//
// Five operational questions, answered ONLY from reads that actually answered:
// broken, running, stuck, needs Joe, changed. The rules that make that safe are
// all in this file, so the page cannot quietly invent a number:
//
//   1. A tile whose producer did not answer carries `value: null` and the word
//      `unknown` with the reason. It NEVER carries 0. Zero and unknown are
//      different answers and a dashboard that confuses them is worse than one
//      that shows nothing.
//   2. The coverage line is built from the reads that were attempted, each with
//      its own clock. There is no denominator: "N of 8 collectors" would be a
//      number nobody produces, and inventing one is the failure this surface
//      exists to prevent.
//   3. Stuck is a comparison against an approved silence cadence. No cadence is
//      approved, so this file refuses to render a verdict and lists the facts
//      instead — longest since change, descending. `stallCandidates` already
//      takes the cadence, so the ruling that approves one turns the tile on
//      without a rewrite.
//   4. A panel with no producer at all is a named scope statement, not an empty
//      list and not a zero.
import { formatClock } from "./visual-system.js";

/** The four reads this page attempts, in the order the coverage line states them. */
export const READS = Object.freeze(["incidents", "work", "needs_joe", "census"]);

export const READ_LABEL = Object.freeze({
  incidents: "Incidents",
  work: "Active work",
  needs_joe: "Requests for Joe",
  census: "Work census",
});

/** The five questions, in doctrine order. */
export const TILES = Object.freeze(["broken", "running", "stuck", "needs_joe", "changed"]);

export const TILE_TITLE = Object.freeze({
  broken: "Broken",
  running: "Running",
  stuck: "Stuck",
  needs_joe: "Needs Joe",
  changed: "Changed",
});

export const NO_CADENCE_REASON = "no silence cadence is approved yet";

/**
 * The approved silence cadence for held work, in hours.
 *
 * Approved 2026-09-17 by the v5 refinement pass; reopen by changing this
 * constant and the decision that set it. Until that ruling there was no
 * approved number at all, and the Stuck tile said so rather than inventing
 * one — `NO_CADENCE_REASON` and the `cadence: null` path are kept for exactly
 * that state, because a cadence this app made up would be a claim about work
 * nobody agreed to measure that way.
 */
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
    if (read.state === "read" && clock) return { id, name, state: "read", text: `${name}: read at ${clock}` };
    const reason = read.state === "read" && !clock
      ? "the read carried no readable time"
      : read.reason || "this read did not answer";
    return { id, name, state: "unknown", reason, text: `${name}: unknown (${reason})` };
  });
}

/** What the page as a whole is doing, before any tile is painted. */
export function readPhase({ status, reads }) {
  if (status === "loading") return "loading";
  if (status === "unauthorized") return "no_access";
  const chips = coverageLine(reads);
  const answered = chips.filter((chip) => chip.state === "read").length;
  const attempted = chips.length;
  if (attempted === 0) return "loading";
  if (answered === 0) return "offline";
  return answered === attempted ? "ready" : "partial";
}

/* -------------------------------------------------------------------- tiles */

const unanswered = (id, reason, open) => ({
  id, title: TILE_TITLE[id], state: "unknown", value: null, word: "unknown",
  reason, sentence: `This is unknown: ${reason}.`, open,
});

/**
 * The five question tiles. Each answered tile carries a verified count; each
 * unanswered one carries null and says why. One read failing therefore makes
 * exactly one tile unknown and leaves the other four alone.
 *
 * @param {{incidents?: object, work?: object, needsJoe?: object, census?: object}} reads
 *   each entry is {state: "read", payload} or {state: "unknown", reason}
 */
export function dashboardTiles({ incidents, work, needsJoe, census, cadence = null } = {}) {
  const tiles = [];

  const brokenOpen = { tab: "attention", label: "Open the incident queue" };
  if (incidents?.state === "read" && validIncidentBoardPayload(incidents.payload)) {
    const count = incidents.payload.count;
    tiles.push({
      id: "broken", title: TILE_TITLE.broken, state: "read", value: count, word: String(count), reason: null,
      sentence: count === 1
        ? "One operational incident is open on the ledger."
        : `${count} operational incidents are open on the ledger.`,
      open: brokenOpen,
    });
  } else {
    tiles.push(unanswered("broken", incidents?.reason || "the incident ledger did not answer", brokenOpen));
  }

  const runningOpen = { tab: "dashboard", section: "activeWork", label: "Open the active work list" };
  if (work?.state === "read" && validCurrentWorkItemPayload(work.payload)) {
    const count = work.payload.count;
    tiles.push({
      id: "running", title: TILE_TITLE.running, state: "read", value: count, word: String(count), reason: null,
      sentence: count === 1
        ? "One work request is held by a person or a session right now."
        : `${count} work requests are held by a person or a session right now.`,
      open: runningOpen,
    });
  } else {
    tiles.push(unanswered("running", work?.reason || "the held-work read did not answer", runningOpen));
  }

  const stuckOpen = { tab: "dashboard", section: "longestSinceChange", label: "Open longest since change" };
  if (work?.state === "read" && validCurrentWorkItemPayload(work.payload)) {
    const stalls = stallCandidates(work.payload.current, { cadence });
    if (stalls.state === "read") {
      // The read answered, so 0 is a real answer and stays 0. Only an
      // unanswered read is ever the word unknown on this tile.
      const count = stalls.items.length;
      tiles.push({
        id: "stuck", title: TILE_TITLE.stuck, state: "read", value: count, word: String(count), reason: null,
        sentence: `Held work with no change for ${stalls.cadence} hours or more.`,
        open: stuckOpen,
      });
    } else {
      tiles.push({
        id: "stuck", title: TILE_TITLE.stuck, state: "unknown", value: null, word: "unknown",
        reason: stalls.reason,
        sentence: `This is unknown: ${stalls.reason}. The held work is listed by how long it has gone without a change instead.`,
        open: stuckOpen,
      });
    }
  } else {
    tiles.push(unanswered("stuck", work?.reason || "the held-work read did not answer", stuckOpen));
  }

  const joeOpen = { tab: "dashboard", section: "needsJoe", label: "Open the request list" };
  if (needsJoe?.state === "read" && validCurrentWorkRequestsPayload(needsJoe.payload)) {
    const count = needsJoe.payload.items.length;
    tiles.push({
      id: "needs_joe", title: TILE_TITLE.needs_joe, state: "read", value: count, word: String(count), reason: null,
      sentence: count === 1
        ? "One shared request carries a bounded next action for a partner."
        : `${count} shared requests carry a bounded next action for a partner.`,
      open: joeOpen,
    });
  } else {
    tiles.push(unanswered("needs_joe", needsJoe?.reason || "the shared request read did not answer", joeOpen));
  }

  tiles.push({
    id: "changed", title: TILE_TITLE.changed, state: "not_in_release", value: null, word: "not in this release",
    reason: "no release feed exists to read",
    sentence: "Not in this release: no release feed exists to read, so no change is claimed.",
    open: null,
  });

  // `census` answers the delivery-evidence summary rather than a tile; it is
  // taken here only so a caller passing it is not silently ignored.
  void census;
  return tiles;
}

/* -------------------------------------------------------------------- stuck */

/**
 * Facts, not a verdict. Without an approved cadence this states `unknown` and
 * still returns the held items ordered by how long they have gone unchanged,
 * longest first. With a cadence in hours it returns the items at or past it.
 */
export function stallCandidates(items, { cadence = null } = {}) {
  const rows = (Array.isArray(items) ? items : [])
    .filter((row) => row && typeof row.hours_since_last_change === "number")
    .slice()
    .sort((left, right) => right.hours_since_last_change - left.hours_since_last_change
      || String(left.human_ref).localeCompare(String(right.human_ref)));
  if (!Number.isFinite(cadence) || cadence === null || cadence <= 0) {
    return { state: "unknown", reason: NO_CADENCE_REASON, cadence: null, items: rows };
  }
  return { state: "read", reason: null, cadence, items: rows.filter((row) => row.hours_since_last_change >= cadence) };
}

/** How long a held item has gone without a change, in words and never as a clock. */
export function sinceChangeLabel(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) return "unknown";
  const rounded = Math.round(hours * 10) / 10;
  return rounded === 1 ? "1 hour since change" : `${rounded} hours since change`;
}

/**
 * The work-in-progress line, and only when both numbers are integers the read
 * actually carried.
 */
export function workInProgressLine(wip) {
  if (!wip || !Number.isInteger(wip.in_flight) || !Number.isInteger(wip.limit_system_wide)) {
    return { known: false, text: "unknown" };
  }
  return { known: true, text: `${wip.in_flight} of ${wip.limit_system_wide} in flight` };
}

/* --------------------------------------------------------------- incidents */

/** The age the ledger measured, in days, or the word unknown. */
export function incidentAgeLabel(days) {
  if (!Number.isInteger(days) || days < 0) return "unknown";
  return days === 1 ? "1 day old" : `${days} days old`;
}

/** One card per incident, carrying only what the read said. */
export function incidentCard(row) {
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
  if (WORK_REQUEST_REF.test(ref)) return "/system-work.html";
  if (INCIDENT_REF.test(ref)) return `/incidents?ref=${encodeURIComponent(ref)}`;
  return null;
}

export const NO_CANONICAL_PAGE = "This record has no page in this application yet.";

/* ------------------------------------------------------- scope, not silence */

/**
 * Every panel the prototype drew that has NO producer, each naming the slice
 * that owns it. These are scope statements: not zeros, not outages, and not
 * empty lists.
 */
export function notInReleaseBlocks() {
  return [
    { id: "changed", title: "Changed: not in this release", slice: "V5-UX-C01", reason: "no release feed exists to read" },
    { id: "accomplishments", title: "Accomplishments: not in this release", slice: "V5-UX-C01", reason: "no verified-accomplishment producer exists" },
    { id: "detected_and_repaired", title: "Detected and repaired: not in this release", slice: "V5-UX-C01", reason: "no producer records a detection and its repair" },
    { id: "resources", title: "Resources: not in this release", slice: "V5-UX-C02 through V5-UX-C06", reason: "resource metering is read in those slices" },
    { id: "model_room", title: "Model Room: not in this release", slice: "V5-UX-C12 and V5-UX-C13", reason: "the ticket board and its history ship there" },
    { id: "atlas_renderer", title: "Atlas renderer: not in this release", slice: "V5-UX-C08 and V5-UX-C09", reason: "the anatomical renderer, incidents and tours ship there; the searchable index is on the Atlas tab now" },
  ];
}

/**
 * V5-UX-C14 Operations: the two questions this section is asked and cannot
 * honestly answer yet, each naming the missing READ rather than a missing
 * intention.
 *
 * Neither card carries a number, and that is the point. There is no read that
 * lists pending approvals of production effects — the approval verbs that
 * exist are partner-only and hash-pinned, so hosting them in a browser would
 * be the app claiming a gate CARR does not give it — and no read exposes a
 * schedule, a last run or a next run, so a count here would be invented.
 *
 * The `rule` on the approvals card is a statement about behaviour that is
 * already true of every command on this app, not a promise: the command kernel
 * re-checks an unknown outcome under its own key before anything is sent
 * again, which is what CR-AC-22 and C23 ask for.
 */
export function operationsBlocks() {
  return [
    {
      id: "approvals",
      title: "Approvals of production effects",
      body: "Not in this release. The approval verbs that exist (accept-ready-plan, accept-workflow, issue-execution-envelope) are partner-only and hash-pinned, and no read lists what is pending, so this card will appear when a pending-approvals read exists.",
      rule: "Reconcile before retry is already how every command on this app behaves: an unknown outcome is re-checked under its own key before anything is sent again.",
      slice: "V5-UX-C14",
    },
    {
      id: "automation",
      title: "Scheduled automation",
      body: "Not in this release. No read exposes scheduled jobs, last or next runs, and there is no pause, run or stop verb; this card will appear when a schedule read exists.",
      rule: null,
      slice: "V5-UX-C14",
    },
  ];
}
