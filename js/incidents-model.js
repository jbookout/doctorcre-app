// V5-UX-C14 — what the incident page shows, decided without a DOM.
//
// The page has one job the Control Room cannot do: stand on ONE incident and
// say what is known about it, what is only suspected about it, and who is
// allowed to clear it. Three rules shape everything below.
//
//   1. Facts and hypotheses are never mixed. `get-incident` keeps them apart
//      because they are different kinds of claim, and a page that interleaved
//      them would turn a guess into a finding. They are separate arrays here,
//      separate regions on the page, and the hypotheses region carries its own
//      eyebrow saying so.
//   2. Nothing on this page adjudicates or closes. Those are partner-only acts
//      for an interactive human session; the app states who can clear the
//      incident and stops. "Who can clear this" is built from the row the
//      ledger returned — `ready_to_close`, `blocked_by`, `next_action` — and
//      never from a judgement this file made.
//   3. A read that did not answer is unknown, in the app's own words. The
//      server's text never reaches a person: it can carry a stack, a hostname
//      or a row, and none of those are an explanation.
import { formatClock } from "./visual-system.js";
import { REFUSAL_SENTENCE } from "./status-model.js";

export { REFUSAL_SENTENCE };

/** The ledger's own reference shapes. Neither is widened for convenience. */
export const INCIDENT_REF = /^INC-\d{8}-\d{2}$/;
export const WORK_REQUEST_REF = /^WR-\d{1,12}$/;

/** The one sentence a page with no usable reference says. */
export const REF_REFUSAL = "This page needs an incident reference like INC-20260915-01.";

/** What a bad work-request reference is told, before anything is sent. */
export const WORK_REQUEST_REFUSAL = "A work request looks like WR-000123. Nothing was sent.";

export const HYPOTHESIS_EYEBROW = "Hypotheses, not facts";

const isText = (value) => typeof value === "string" && value.length > 0;

/**
 * The reference this page was opened on, read from the query string alone.
 *
 * Three answers, and the two failures are different on purpose: a bare page is
 * a person who arrived from a link with no reference and should be given the
 * list, while a malformed one is a person holding something that looks like a
 * reference and is not.
 */
export function refFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const raw = params.get("ref");
  if (raw === null || raw.trim() === "") return { state: "missing", ref: null, given: null };
  const ref = raw.trim();
  if (!INCIDENT_REF.test(ref)) return { state: "malformed", ref: null, given: ref };
  return { state: "ok", ref, given: ref };
}

/* ------------------------------------------------------------------ payload */

/** `get-incident`'s own shape: the row, and the four lists it keeps apart. */
export function validIncidentDetailPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const row = payload.incident;
  if (!row || typeof row !== "object") return false;
  if (!INCIDENT_REF.test(String(row.ref)) || !isText(row.title)) return false;
  if (!isText(row.severity) || !isText(row.state)) return false;
  for (const key of ["facts", "hypotheses", "occurrences", "links"]) {
    if (!Array.isArray(payload[key])) return false;
  }
  return true;
}

/* ------------------------------------------------------------------- header */

const orUnknown = (value) => (isText(value) ? value : "unknown");

/** The header line items, each either what the row said or the word unknown. */
export function incidentHeader(row = {}) {
  return {
    ref: String(row.ref || ""),
    title: orUnknown(row.title),
    severity: orUnknown(row.severity),
    state: orUnknown(row.state),
    environment: orUnknown(row.environment),
    owner: orUnknown(row.owner_actor),
    age: Number.isInteger(row.age_days) && row.age_days >= 0
      ? (row.age_days === 1 ? "1 day old" : `${row.age_days} days old`)
      : "unknown",
    occurrences: Number.isInteger(row.occurrences) ? `seen ${row.occurrences} times` : "seen unknown times",
  };
}

/* --------------------------------------------------------- facts and guesses */

/**
 * One row per fact, each carrying its source and its own clock. A fact with no
 * readable time says unknown rather than borrowing the incident's clock: the
 * borrowed one would be a time nobody recorded for this fact.
 */
export function factRows(facts) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact === "object" && isText(fact.statement))
    .map((fact) => ({
      statement: fact.statement,
      source: isText(fact.source) ? fact.source : "no source recorded",
      clock: formatClock(fact.observed_at) || "unknown",
    }));
}

/** The same rows for hypotheses, which the page draws in their own region. */
export function hypothesisRows(hypotheses) {
  return (Array.isArray(hypotheses) ? hypotheses : [])
    .filter((row) => row && typeof row === "object" && isText(row.statement))
    .map((row) => ({
      statement: row.statement,
      status: isText(row.status) ? row.status : "not assessed",
      clock: formatClock(row.recorded_at) || "unknown",
    }));
}

/** One row per recorded occurrence, in the order the ledger returned them. */
export function occurrenceRows(occurrences) {
  return (Array.isArray(occurrences) ? occurrences : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      clock: formatClock(row.observed_at) || "unknown",
      note: isText(row.note) ? row.note : "no note recorded",
    }));
}

/** Work requests and runs the ledger linked to this incident. */
export function linkRows(links) {
  return (Array.isArray(links) ? links : [])
    .filter((row) => row && typeof row === "object" && isText(row.ref))
    .map((row) => ({
      ref: row.ref,
      kind: isText(row.kind) ? row.kind : "link",
      label: isText(row.label) ? row.label : row.ref,
      href: WORK_REQUEST_REF.test(row.ref) ? "/system-work.html" : null,
    }));
}

/* ------------------------------------------------------- who can clear this */

/**
 * The one line that answers "can I finish this here?" — always no, and then
 * what the ledger says has to happen instead. Adjudication and closure are
 * partner-only acts in an interactive session, so this page never draws the
 * buttons and says who does.
 */
export function whoCanClearLine(row = {}) {
  if (row.ready_to_close === true) {
    return "Ready to close: a partner closes it in their own session with the root cause.";
  }
  if (isText(row.blocked_by)) return `Blocked by: ${row.blocked_by}`;
  if (isText(row.next_action)) return `Next: ${row.next_action}`;
  return "The ledger recorded no next step and no blocker for this incident.";
}

/* -------------------------------------------------------------- the one write */

/** One operation, named after the exact pair it links. */
export function linkOperationKey(ref, workRequest) {
  return `incident:${ref}:link:${workRequest}`;
}

/**
 * The arguments for `link-incident-work-request`, or the refusal. The verb
 * takes exactly two fields beside its key and refuses any other, so nothing
 * here defaults, trims into shape, or adds a base version the verb does not
 * have.
 */
export function linkArgs(ref, workRequest) {
  const target = String(workRequest || "").trim().toUpperCase();
  if (!INCIDENT_REF.test(String(ref))) return { ok: false, message: REF_REFUSAL };
  if (!WORK_REQUEST_REF.test(target)) return { ok: false, message: WORK_REQUEST_REFUSAL };
  return { ok: true, args: { incident_ref: String(ref), work_request: target }, workRequest: target };
}
