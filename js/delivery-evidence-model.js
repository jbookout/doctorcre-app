// V5-UX-C11 — Delivery evidence and retrospective disposition, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock. Everything this slice decides
// about a passport, a portfolio read, a card or a disposition is decided here,
// so every rule below is testable without a browser.
//
// The one rule that governs the whole file: THE ONLY OPERATIONAL TOKEN IS
// `complete`, and a `complete` is only ever produced from a positive statement
// the record layer made, carrying the reference it came from. Absence of a
// field, a read that was never made, a refusal, a stale plan — all of those are
// the literal word `unknown`. Joe has mistaken prepared-to-ship for delivered;
// nothing in here is allowed to help him do it again.

/** The seven delivery dimensions, in the order a delivery actually travels. */
export const STAGES = Object.freeze([
  "planned", "approved", "source_verified", "merged", "released", "activated", "consumer_proven",
]);

export const STAGE_LABEL = Object.freeze({
  planned: "Planned",
  approved: "Approved",
  source_verified: "Source verified",
  merged: "Merged",
  released: "Released",
  activated: "Activated",
  consumer_proven: "Consumer proven",
});

/** The three tokens a cell may carry. `complete` is the only operational one. */
export const STAGE_TOKENS = Object.freeze(["complete", "not reached", "unknown"]);

export const STALE_REASON = "plan is stale against the accepted source";
export const NO_PASSPORT_REASON = "no passport has been read for this record";
export const NO_PORTFOLIO_REASON = "no portfolio named";

/** The work-request states the record layer admits on a card. */
export const CARD_STATES = Object.freeze(["captured", "triaged", "ready", "declined", "superseded"]);
/** Shape disposition is a pre-build decision and the record layer says which. */
export const PREBUILD_STATES = Object.freeze(["captured", "triaged", "ready"]);
/** Both withdrawals are captured-only at the record layer. */
export const WITHDRAWAL_STATES = Object.freeze(["captured"]);

export const WORK_REQUEST_REF = /^WR-[0-9]{1,12}$/;

const SLICE_STATES = ["eligible", "blocked", "claimed", "reopened", "verified_complete"];
const UNFINISHED_SLICE_STATES = ["eligible", "blocked", "claimed", "reopened"];

const PASSPORT_KEYS = [
  "schema_version", "work_request", "accepted_plan_revision", "plan_digest", "slice_plan",
  "execution_envelopes", "slices", "current_receipts", "current_reviewer_facts", "receipts",
  "reviewer_facts", "qa_facts", "operator_receipt", "closure", "closure_state", "stale_conflict",
  "projection_digest",
];
const CLOSURE_FACETS = ["work", "proof", "explanation", "release", "learning"];
const CARD_REQUIRED_KEYS = ["ok", "human_ref", "state", "version"];
const PORTFOLIO_REQUIRED_KEYS = ["ok", "portfolio_ref", "exists", "accepted"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function hasKeys(value, keys) {
  return isObject(value) && keys.every((key) => key in value);
}

/**
 * One closure facet, as the passport builds it: a state, the typed evidence it
 * was derived from, and a note. `learning` carries a route as well, so the shape
 * is checked by what every facet must have rather than by an exact key list.
 */
function validClosureFacet(facet) {
  return isObject(facet) && nonEmptyString(facet.state) && Array.isArray(facet.evidence_refs);
}

/**
 * The exact-key contract for the passport, in the spirit of
 * work-inventory-model.js: an undeclared top-level key is REFUSED rather than
 * ignored, so a producer that starts sending a new dimension has to come back
 * and declare it beside the cell that would render it.
 */
export function validPassportPayload(payload) {
  if (!exactKeys(payload, PASSPORT_KEYS)) return false;
  if (payload.schema_version !== "engineering-passport.v1") return false;
  if (!nonEmptyString(payload.work_request)) return false;
  if (!(payload.accepted_plan_revision === null || isObject(payload.accepted_plan_revision))) return false;
  if (!Array.isArray(payload.slices)) return false;
  if (!payload.slices.every((slice) => isObject(slice) && nonEmptyString(slice.slice_ref) && SLICE_STATES.includes(slice.state))) return false;
  for (const list of ["execution_envelopes", "current_receipts", "current_reviewer_facts", "receipts", "reviewer_facts", "qa_facts"]) {
    if (!Array.isArray(payload[list])) return false;
  }
  if (!isObject(payload.closure)) return false;
  if (!CLOSURE_FACETS.every((facet) => validClosureFacet(payload.closure[facet]))) return false;
  if (!["complete", "blocked"].includes(payload.closure_state)) return false;
  if (!isObject(payload.stale_conflict) || !["none", "stale"].includes(payload.stale_conflict.state)) return false;
  return true;
}

/**
 * The portfolio read is NOT exact-key checked, and that is deliberate: the verb
 * spreads a database readback whose full key set belongs to the producer, so an
 * exact list here would refuse every real answer the first time a column was
 * added. What is checked is what this page reads, and `accepted` is only ever
 * believed as the literal boolean true.
 */
export function validPortfolioPayload(payload) {
  if (!hasKeys(payload, PORTFOLIO_REQUIRED_KEYS)) return false;
  if (payload.ok !== true || !nonEmptyString(payload.portfolio_ref)) return false;
  if (typeof payload.exists !== "boolean" || typeof payload.accepted !== "boolean") return false;
  if ("reviews" in payload && !Array.isArray(payload.reviews)) return false;
  return true;
}

/** The fresh read every write is built from. `version` is the base_version. */
export function validWorkRequestCard(payload) {
  if (!hasKeys(payload, CARD_REQUIRED_KEYS)) return false;
  if (payload.ok !== true || !WORK_REQUEST_REF.test(String(payload.human_ref))) return false;
  if (!CARD_STATES.includes(payload.state)) return false;
  if (!Number.isInteger(payload.version) || payload.version < 1) return false;
  return true;
}

/** A typed evidence ref renders as its `ref`; nothing else is invented. */
function evidenceRefOf(facet, fallback) {
  const first = (facet?.evidence_refs || []).find((entry) => isObject(entry) && nonEmptyString(entry.ref));
  return first ? first.ref : fallback;
}

const cell = (stage, state, evidence_ref, reason) => ({ stage, state, evidence_ref, reason });
const unknownRow = (reason) => STAGES.map((stage) => cell(stage, "unknown", null, reason));

/**
 * The seven cells for one record.
 *
 * `passport` is the engineering-passport answer or null; `portfolio` is the
 * read-portfolio answer or null. A stale plan collapses every cell to unknown,
 * because a passport derived from a plan that no longer matches the accepted
 * source is not evidence about today's record.
 */
export function deliveryStages(passport, portfolio = null) {
  if (!validPassportPayload(passport)) return unknownRow(NO_PASSPORT_REASON);
  if (passport.stale_conflict.state === "stale") return unknownRow(STALE_REASON);

  const closure = passport.closure;
  const facetComplete = (name) => closure[name].state === "complete";

  const revision = passport.accepted_plan_revision;
  const planned = isObject(revision) && nonEmptyString(revision.id)
    ? cell("planned", "complete", revision.id, null)
    : cell("planned", "unknown", null, "the passport names no accepted plan revision");

  const approved = portfolio === null
    ? cell("approved", "unknown", null, NO_PORTFOLIO_REASON)
    : !validPortfolioPayload(portfolio)
      ? cell("approved", "unknown", null, "the portfolio read did not answer in a shape this page reads")
      : portfolio.exists === false
        ? cell("approved", "unknown", null, "the portfolio read answered that it holds no such record, which is unknown rather than refused")
        : portfolio.accepted === true
          ? cell("approved", "complete", portfolio.accepted_revision_id || portfolio.portfolio_ref, null)
          : cell("approved", "not reached", null, "the portfolio read answered that no partner has accepted it");

  const slices = passport.slices;
  const unfinished = slices.find((slice) => UNFINISHED_SLICE_STATES.includes(slice.state));
  const sourceVerified = slices.length > 0 && slices.every((slice) => slice.state === "verified_complete")
    ? cell("source_verified", "complete", passport.plan_digest || passport.projection_digest || null, null)
    : unfinished
      ? cell("source_verified", "not reached", null, `slice ${unfinished.slice_ref} is ${unfinished.state}`)
      : cell("source_verified", "unknown", null, "the passport carries no slice this page can read");

  // Merged, Released, Activated and Consumer proven read one closure facet each.
  // A facet that is not `complete` is left UNKNOWN rather than called not
  // reached: the facets are derived together from one `complete` flag, so an
  // unresolved facet says "closure is not finished", not "this dimension in
  // particular was not reached".
  const facetCell = (stage, name, evidenceFallback) => (facetComplete(name)
    ? cell(stage, "complete", evidenceRefOf(closure[name], evidenceFallback), null)
    : cell(stage, "unknown", null, closure[name].note || `closure.${name} is ${closure[name].state}`));

  const merged = facetCell("merged", "work", "closure.work");
  const released = facetCell("released", "release", "closure.release");
  const activated = passport.closure_state === "complete" && facetComplete("release")
    ? cell("activated", "complete", evidenceRefOf(closure.release, "closure_state"), null)
    : cell("activated", "unknown", null, passport.closure_state === "complete"
      ? "closure is complete but no release facet is complete"
      : "the passport reports closure blocked");
  const consumerProven = facetCell("consumer_proven", "proof", "closure.proof");

  return [planned, approved, sourceVerified, merged, released, activated, consumerProven];
}

/**
 * THE DENOMINATOR, and nothing else may act as one. It is the work-request
 * coverage row's `count_total`, and it is only known when that source enumerated
 * completely, was not page-capped, and returned a total.
 */
export function stageDenominator(coverage) {
  const rows = Array.isArray(coverage) ? coverage : [];
  const row = rows.find((entry) => entry?.kind === "work_request");
  if (!row) return { known: false, total: null, reason: "the census returned no coverage for work requests" };
  if (row.state !== "complete") return { known: false, total: null, reason: row.reason || `this source answered ${row.state}` };
  if (row.page_capped === true) return { known: false, total: null, reason: "more rows remain behind the page limit" };
  if (!Number.isInteger(row.count_total)) return { known: false, total: null, reason: row.reason || "this source claimed no total" };
  return { known: true, total: row.count_total, reason: null };
}

/**
 * A count with a known denominator, or the word `unknown`. There is no third
 * behaviour: no 0, no "n of the rows on this page", and no percentage of a
 * number nobody counted.
 */
export function renderCount(numerator, denominator) {
  if (!denominator || denominator.known !== true || !Number.isInteger(denominator.total)) return "unknown";
  if (!Number.isInteger(numerator) || numerator < 0) return "unknown";
  if (denominator.total === 0) return "0 of 0";
  const percent = Math.round((numerator / denominator.total) * 100);
  return `${numerator} of ${denominator.total} (${percent}%)`;
}

/**
 * C27's six dispositions, every time, with whether this surface can actually
 * record each one. Four of them have NO supported command anywhere, and this
 * page says so rather than growing a button that would have to invent a store.
 */
export function dispositionOptions(card) {
  const state = validWorkRequestCard(card) ? card.state : null;
  const captured = state === "captured";
  const none = (reason) => ({ available: false, verb: null, reason });
  const missing = "no supported disposition command exists for this; Joe decides it in the record layer";
  return [
    { choice: "continue", label: "Continue", available: true, verb: null, reason: "continuing needs no command: the record stays exactly as it is" },
    { choice: "finish_shipping", label: "Finish shipping", ...none(missing) },
    { choice: "combine", label: "Combine", ...none(missing) },
    {
      choice: "supersede",
      label: "Supersede",
      available: captured,
      verb: captured ? "supersede-work-request" : null,
      reason: captured ? null : `this record is ${state || "unknown"}; superseding is admitted from captured only`,
    },
    { choice: "shelve", label: "Shelve", ...none(`${missing}. Shelving is not declining, so this page will not record one as the other`) },
    { choice: "investigate", label: "Investigate", ...none(missing) },
  ];
}

/**
 * The actions this surface can really send, read off the card's own state. They
 * are separate from the C27 list above because `decline` and the shape
 * disposition are commands the record layer supports and C27 does not name.
 */
export function availableActions(card) {
  const state = validWorkRequestCard(card) ? card.state : null;
  return [
    { choice: "decline", label: "Decline", verb: "decline-work-request", available: state === "captured", reason: state === "captured" ? null : `this record is ${state || "unknown"}; declining is admitted from captured only` },
    { choice: "supersede", label: "Supersede", verb: "supersede-work-request", available: state === "captured", reason: state === "captured" ? null : `this record is ${state || "unknown"}; superseding is admitted from captured only` },
    { choice: "shape", label: "Shape disposition", verb: "set-work-shape-disposition", available: PREBUILD_STATES.includes(state), reason: PREBUILD_STATES.includes(state) ? null : `this record is ${state || "unknown"}; the shape disposition is frozen after the pre-build states` },
  ];
}

/** The exact canonical state each action yields, in a sentence a person reads. */
export function dispositionEffect(choice, ref, { successor = "", disposition = "" } = {}) {
  const name = WORK_REQUEST_REF.test(String(ref)) ? ref : "this record";
  if (choice === "decline") return `This records ${name} as declined; nothing is deleted and its history stays.`;
  if (choice === "supersede") return `This records ${name} as superseded by ${WORK_REQUEST_REF.test(String(successor)) ? successor : "the successor you name"}; nothing is deleted, nothing merges, and its history stays.`;
  if (choice === "shape") return `This records the shape disposition on ${name} as ${disposition || "required or not required"}; the record's state does not move and nothing is deleted.`;
  return `Nothing is recorded for ${name}.`;
}

/**
 * The exact verb arguments, built from the FRESH card and nothing else. Every
 * refusal the record layer would raise for a malformed argument is raised here
 * first, in words, so a person is told before a key is ever spent.
 */
export function dispositionArgs({ card, choice, reason = "", successor = "", fixedSurfaceRef = "", disposition = "", humanQuote = "" } = {}) {
  if (!validWorkRequestCard(card)) throw new TypeError("This record has not been read fresh, so no command can be built from it.");
  const text = String(reason).trim();
  const base_version = card.version;
  if (choice === "decline" || choice === "supersede") {
    if (!WITHDRAWAL_STATES.includes(card.state)) throw new TypeError(`${card.human_ref} is ${card.state}; this withdrawal is admitted from captured only.`);
    if (text.length < 1 || text.length > 500) throw new TypeError("Say why, in 1 to 500 characters. The record layer refuses a withdrawal without a reason.");
    if (choice === "decline") return { human_ref: card.human_ref, base_version, exit_reason: text };
    const target = String(successor).trim();
    if (!WORK_REQUEST_REF.test(target)) throw new TypeError("Name the successor as a work request reference, for example WR-000123.");
    if (target === card.human_ref) throw new TypeError("A record cannot supersede itself.");
    return { human_ref: card.human_ref, base_version, exit_reason: text, superseded_by: target };
  }
  if (choice === "shape") {
    if (!PREBUILD_STATES.includes(card.state)) throw new TypeError(`${card.human_ref} is ${card.state}; the shape disposition is frozen after the pre-build states.`);
    if (!["required", "not_required"].includes(disposition)) throw new TypeError("Choose required or not required.");
    if (text.length < 1) throw new TypeError("Say why. The record layer refuses a shape disposition without a rationale.");
    const args = { work_request: card.human_ref, base_version, disposition, rationale: text };
    if (disposition === "not_required") {
      const surface = String(fixedSurfaceRef).trim();
      if (surface.length < 1) throw new TypeError("Not required is admitted only when the implementation surface is already fixed; name that surface.");
      args.fixed_surface_ref = surface;
    }
    const quote = String(humanQuote).trim();
    if (quote.length > 0) args.human_quote = quote;
    return args;
  }
  throw new TypeError("No supported disposition command exists for this choice.");
}

/** Plain English for a refusal code. Nothing here retries anything. */
export function refusalMessage(code, { ref = "" } = {}) {
  const name = WORK_REQUEST_REF.test(String(ref)) ? ref : "this record";
  switch (code) {
    case "version_conflict":
      return `someone else changed this record; read again. ${name} moved since it was read, so nothing was saved and nothing was retried.`;
    case "key_reuse":
      return "the same safety key was already spent on different arguments, so the record layer refused it. Read the record again before deciding.";
    case "work_request_not_found":
      return `${name} is not a record this session can read.`;
    case "engineering_work_request_not_found":
      return `no delivery passport exists for ${name}, so every stage stays unknown.`;
    case "work_shape_disposition_frozen":
      return `the shape disposition on ${name} is frozen: it is past the pre-build states.`;
    case "heavy_build_shape_required":
      return `${name} classifies as heavy build, so not required was refused; it needs a work shape.`;
    case "portfolio_readback_unavailable":
      return "the portfolio could not be read, so approval stays unknown.";
    case "unreadable":
      return "the record layer could not be reached, so nothing here has been inferred.";
    default:
      return code ? `the record layer refused this: ${String(code).replace(/_/g, " ")}.` : "the record layer refused this without naming a reason.";
  }
}

/** One logical operation, one key. The record's ref is the operation's identity. */
export const operationKeys = Object.freeze({
  decline: (ref) => `decline:${ref}`,
  supersede: (ref) => `supersede:${ref}`,
  shape: (ref) => `shape:${ref}`,
});
