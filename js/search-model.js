// V5-UX-B05 — Authorized global search, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock of its own. Every rule the
// Search tab obeys is decided here so it can be tested without a browser.
//
// Four producer facts shape everything below, and each one is a place a
// friendlier consumer would lie:
//
//  1. `find` takes ONE argument and `find-and-catch-up` takes TWO, both under
//     additionalProperties:false. There is no actor, kind, tenant or scope
//     argument, and a third key is refused `unregistered_operation_fields`.
//     So the record layer decides what is authorized; this page adds no filter
//     of its own and invents no field.
//  2. An array of refs is NOT an array of links. `organizations[].refs` and
//     `.role_refs` aggregate a nullable column, and a null ELEMENT was observed
//     in two real payloads. Every ref is filtered to a non-empty string before
//     it is rendered or linked.
//  3. The producer's order is the answer's order — parties by `merged` then
//     similarity, candidates by `localeCompare`. This model never sorts and
//     never reverses; a re-ranked list would be this page's opinion presented
//     as the record layer's.
//  4. A no-match is a 200 with six empty arrays. A missing source is a thrown
//     error carrying a status. They are two different facts, not two paints of
//     one, and they are never allowed to collapse into each other.
import { PREFERENCES_KEY } from "./shell.js";

/* -------------------------------------------------- the producer's own numbers */

/** `FIND_CATCH_UP_QUERY_MAX` (tools.js:2059) — the input's maxlength, too. */
export const FIND_QUERY_MAX = 200;
/** `FIND_CATCH_UP_LIMIT_MAX` (tools.js:2060). */
export const FIND_CATCH_UP_LIMIT_MAX = 50;
export const FIND_CATCH_UP_LIMIT_DEFAULT = 20;
/** `FIND_CATCH_UP_CANDIDATE_CAP` (tools.js:2061). */
export const FIND_CATCH_UP_CANDIDATE_CAP = 25;

/** The six caps `find` applies, copied as numbers from the producer. */
export const FIND_CAPS = Object.freeze({
  parties: 10, organizations: 5, deals: 5, connections: 12, retired_refs: 10, links: 20,
});

/* --------------------------------------------------------- the frozen sentences */

/** checkable_done 1 — what "authorized" can honestly mean on this page. */
export const AUTHORIZATION_SENTENCE =
  "This search shows what the record layer returns to you when you are signed in. " +
  "This page adds no filter of its own and asks for nobody else's records.";

/** checkable_done 3 — saved views are a device fact, because no verb stores one. */
export const SAVED_VIEW_SENTENCE =
  "Saved views live in this browser on this device. There is no verb that stores a partner " +
  "preference yet, so a view you save here does not follow you to another phone or computer, " +
  "and it changes none of your workspace preferences.";

/** §3 — three of the four named sources have no door at all. */
export const NOT_SEARCHED_SENTENCE =
  "This searches people, practices, buildings, deals, leads and vendors — the records the record " +
  "layer can search by name. Tasks, documents and your Doc conversation history are not searched " +
  "here, because no door exists that searches them yet. This page will not pretend an empty " +
  "result for those means there is nothing to find.";

/** UX01's out-of-scope half: a chip is a view, never a narrower question. */
export const SCOPE_CHIP_SENTENCE =
  "These chips hide rows from the answer you already received. They do not ask the record layer " +
  "for a narrower search — it has no such door.";

/** §4.4 — most result kinds have no address to open into, and this says so. */
export const NO_PAGE_SENTENCE = "This record has no page that opens by address yet.";

export const EXPOSURE_STATEMENT =
  "This search names real people, practices and deals, so on a shared or unlocked phone a " +
  "passer-by reads those names at a glance — and what you typed stays in the address bar until " +
  "you clear it. The words of a search are kept in this browser only when you save a view; " +
  "nothing here is cached offline, and closing the page leaves nothing behind but the views you " +
  "chose to save.";

/* ------------------------------------------------------------------ validation */

/** All seven keys, always, in every captured response. */
export const SEARCH_PAYLOAD_KEYS = Object.freeze([
  "parties", "deals", "connections", "organizations", "lead_client_links", "deals_via_link", "note",
]);

const PARTY_KEYS = ["name", "city", "specialty", "org_name", "ref", "kind", "merged"];
const ORGANIZATION_KEYS = ["name", "live_rows", "refs", "retired_aliases", "retired_refs", "retired_refs_truncated", "live_as_role", "role_refs", "all_retired"];
const DEAL_KEYS = ["name", "phase", "owner", "client_ref"];

/** `kindFromRef` (tools.js:2065-2071) — the six words a candidate kind can be. */
export const CANDIDATE_KINDS = Object.freeze(["deal", "lead", "client", "vendor", "party", "record"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** NULLABLE, by §2.2: the producer's column is nullable and a real payload had null. */
function nullableString(value) {
  return value === null || typeof value === "string";
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Exact keys, compared as SETS and never by sorting them. This module must
 * contain no sort of any kind — UX01's "no default workload ranking" is asserted
 * by a grep over this file, and a sort here, however innocent, would make that
 * assertion unreadable.
 */
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  if (present.length !== keys.length) return false;
  const wanted = new Set(keys);
  return present.every((key) => wanted.has(key));
}

/**
 * An array whose ELEMENTS may be null. This is not laxity: `array_agg(ref …)`
 * over a nullable column produced `refs: [null]` in two real payloads, and a
 * validator that refused it would refuse the production answer.
 */
function nullableStringArray(value) {
  return Array.isArray(value) && value.every((entry) => nullableString(entry));
}

export function validSearchParty(row) {
  if (!exactKeys(row, PARTY_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  // city, specialty, org_name and ref are each nullable in v_ref_index.
  if (!nullableString(row.city) || !nullableString(row.specialty)) return false;
  if (!nullableString(row.org_name) || !nullableString(row.ref)) return false;
  if (!nonEmptyString(row.kind)) return false;
  return typeof row.merged === "boolean";
}

export function validSearchOrganization(row) {
  if (!exactKeys(row, ORGANIZATION_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  if (!wholeNumber(row.live_rows) || !wholeNumber(row.retired_aliases) || !wholeNumber(row.live_as_role)) return false;
  if (!nullableStringArray(row.refs) || !nullableStringArray(row.role_refs) || !nullableStringArray(row.retired_refs)) return false;
  if (typeof row.retired_refs_truncated !== "boolean") return false;
  return typeof row.all_retired === "boolean";
}

export function validSearchDeal(row) {
  if (!exactKeys(row, DEAL_KEYS)) return false;
  if (!nonEmptyString(row.name)) return false;
  // owner is lead_owner and was observed null; client_ref is nullable too.
  return nullableString(row.phase) && nullableString(row.owner) && nullableString(row.client_ref);
}

/**
 * The exact-key contract for a `find` response. All seven keys are required —
 * the producer returns all seven on every call, including a no-match — and an
 * eighth is refused rather than ignored, so a producer that starts sending a
 * field this page does not render has to come back and declare it.
 *
 * Every row shape below is checked as a shape, not as content: `connections`,
 * `lead_client_links` and `deals_via_link` carry producer-chosen columns whose
 * set this page does not pin, so they are required to be objects with a name or
 * a ref the page can print and nothing more.
 */
export function validSearchPayload(payload) {
  if (!exactKeys(payload, SEARCH_PAYLOAD_KEYS)) return false;
  for (const key of ["parties", "deals", "connections", "organizations", "lead_client_links", "deals_via_link"]) {
    if (!Array.isArray(payload[key])) return false;
  }
  if (!payload.parties.every((row) => validSearchParty(row))) return false;
  if (!payload.organizations.every((row) => validSearchOrganization(row))) return false;
  if (!payload.deals.every((row) => validSearchDeal(row))) return false;
  for (const key of ["connections", "lead_client_links", "deals_via_link"]) {
    if (!payload[key].every((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))) return false;
  }
  // `note` is the producer's own sentence and this page prints it verbatim.
  return nonEmptyString(payload.note);
}

/** The three `find-and-catch-up` states, each checked for the keys it carries. */
export function validCatchUpPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.state === "completed") {
    return Boolean(payload.match) && typeof payload.match === "object" &&
      nonEmptyString(payload.match.kind) && nonEmptyString(payload.match.target) &&
      Boolean(payload.catch_up) && typeof payload.catch_up === "object";
  }
  if (payload.state === "needs_disambiguation") {
    if (!Array.isArray(payload.candidates) || !wholeNumber(payload.candidate_count)) return false;
    if (typeof payload.candidates_truncated !== "boolean") return false;
    if (!nonEmptyString(payload.hint)) return false;
    return payload.candidates.every((row) => Boolean(row) && CANDIDATE_KINDS.includes(row.kind) &&
      nonEmptyString(row.name) && nonEmptyString(row.target));
  }
  if (payload.state === "not_found") {
    return Array.isArray(payload.candidates) && wholeNumber(payload.retired_matches) && nonEmptyString(payload.hint);
  }
  return false;
}

/* -------------------------------------------------------------------- requests */

/**
 * `find` declares ONE property. The object below carries exactly one key, and a
 * test asserts that, because an actor or a kind added here would be refused by
 * the gateway with `unregistered_operation_fields` — and, worse, would mean the
 * app had started deciding what a partner may see.
 */
export function buildFindArguments(query) {
  return { query: String(query ?? "") };
}

/** `find-and-catch-up` declares exactly two: query and limit. */
export function buildFindAndCatchUpArguments(query, limit = FIND_CATCH_UP_LIMIT_DEFAULT) {
  const asked = Number.isInteger(limit) ? limit : FIND_CATCH_UP_LIMIT_DEFAULT;
  return { query: String(query ?? ""), limit: Math.min(Math.max(asked, 1), FIND_CATCH_UP_LIMIT_MAX) };
}

/** What the producer refuses, refused here first so no pointless read is sent. */
export function queryIsSendable(query) {
  const text = String(query ?? "").trim();
  return text.length > 0 && text.length <= FIND_QUERY_MAX;
}

/* ---------------------------------------------------------------- the grouping */

/**
 * The groups, in the order the page paints them. `parties` is split by the
 * producer's own `kind` word so a chip can name Leads rather than "records",
 * and the split preserves each row's position inside its group.
 */
export const SEARCH_GROUPS = Object.freeze([
  Object.freeze({ id: "people", label: "People and practices", source: "parties", kind: "party" }),
  Object.freeze({ id: "leads", label: "Leads", source: "parties", kind: "lead" }),
  Object.freeze({ id: "clients", label: "Clients", source: "parties", kind: "client" }),
  Object.freeze({ id: "vendors", label: "Vendors", source: "parties", kind: "vendor" }),
  Object.freeze({ id: "organizations", label: "Organizations", source: "organizations", kind: null }),
  Object.freeze({ id: "deals", label: "Deals", source: "deals", kind: null }),
  Object.freeze({ id: "connections", label: "Connections", source: "connections", kind: null }),
  Object.freeze({ id: "lead_client_links", label: "Lead and client links", source: "lead_client_links", kind: null }),
  Object.freeze({ id: "deals_via_link", label: "Linked deals", source: "deals_via_link", kind: null }),
]);

export const SEARCH_GROUP_IDS = Object.freeze(SEARCH_GROUPS.map((group) => group.id));

/** Non-null, non-empty strings only. An array of refs is not an array of links. */
export function refChips(list) {
  return (Array.isArray(list) ? list : []).filter((entry) => nonEmptyString(entry));
}

/** §4.4 — only two pages read a name, so only two kinds get an address. */
export function deepLinkFor(row) {
  if (!row || row.merged === true) return null;
  if (row.kind === "client") return `/clients?q=${encodeURIComponent(row.name)}`;
  if (row.kind === "vendor") return `/vendors?q=${encodeURIComponent(row.name)}`;
  return null;
}

function partyRow(row) {
  const link = deepLinkFor(row);
  return Object.freeze({
    kind: "party",
    name: row.name,
    // Each of these prints ONLY when the producer sent one. A null never
    // reaches a line of its own, and the word "null" is never rendered.
    facts: Object.freeze([
      row.city === null ? null : { label: "City", value: row.city },
      row.specialty === null ? null : { label: "Specialty", value: row.specialty },
      row.org_name === null ? null : { label: "Organization", value: row.org_name },
    ].filter(Boolean)),
    refs: refChips([row.ref]),
    retired: row.merged === true,
    link,
    note: link ? null : NO_PAGE_SENTENCE,
  });
}

function organizationRow(row) {
  return Object.freeze({
    kind: "organization",
    name: row.name,
    // Two numbers, two words. They are printed as returned and never summed:
    // the producer refuses to blend live rows with retired aliases, and so does
    // this page.
    counts: Object.freeze([
      { label: "live records", value: row.live_rows },
      { label: "retired aliases", value: row.retired_aliases },
      { label: "live as a role", value: row.live_as_role },
    ]),
    refs: refChips(row.refs),
    roleRefs: refChips(row.role_refs),
    retiredRefs: refChips(row.retired_refs),
    retiredRefsTruncated: row.retired_refs_truncated === true,
    allRetired: row.all_retired === true,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

function dealRow(row) {
  return Object.freeze({
    kind: "deal",
    name: row.name,
    facts: Object.freeze([
      row.phase === null ? null : { label: "Phase", value: row.phase },
      { label: "Owner", value: row.owner === null ? "no owner recorded" : row.owner },
      row.client_ref === null ? null : { label: "Client", value: row.client_ref },
    ].filter(Boolean)),
    refs: refChips([row.client_ref]),
    retired: false,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

/**
 * A row from a group whose columns this page does not pin. Every printable
 * field is taken from the object as it arrived: no key is invented, no value is
 * reworded, and a null is dropped rather than printed.
 */
function passthroughRow(row, kind) {
  return Object.freeze({
    kind,
    name: nonEmptyString(row?.name) ? row.name : null,
    facts: Object.freeze(Object.entries(row || {})
      .filter(([key, value]) => key !== "name" && value !== null && value !== undefined && typeof value !== "object")
      .map(([key, value]) => ({ label: key, value: String(value) }))),
    refs: Object.freeze([]),
    retired: false,
    link: null,
    note: NO_PAGE_SENTENCE,
  });
}

/**
 * Groups, in painting order, each carrying the producer's own order untouched.
 * A group with no rows is dropped: an empty group would draw a chip for a kind
 * the answer never mentioned.
 */
export function groupSearchResults(payload) {
  if (!validSearchPayload(payload)) return Object.freeze([]);
  return Object.freeze(SEARCH_GROUPS.map((group) => {
    let rows = [];
    if (group.source === "parties") {
      const matching = payload.parties.filter((row) => (group.kind === "party" ? !["lead", "client", "vendor"].includes(row.kind) : row.kind === group.kind));
      rows = matching.map((row) => partyRow(row));
    } else if (group.source === "organizations") {
      rows = payload.organizations.map((row) => organizationRow(row));
    } else if (group.source === "deals") {
      rows = payload.deals.map((row) => dealRow(row));
    } else {
      rows = payload[group.source].map((row) => passthroughRow(row, group.id));
    }
    return Object.freeze({ id: group.id, label: group.label, count: rows.length, rows: Object.freeze(rows) });
  }).filter((group) => group.count > 0));
}

/**
 * The chips. One per group actually present, carrying that group's own count —
 * a number read from the answer, never one this page computed over anything
 * else. A chip is SELECTED when the scope names it or the scope is empty.
 */
export function scopeChips(groups, kinds = []) {
  const chosen = new Set((Array.isArray(kinds) ? kinds : []).filter((id) => SEARCH_GROUP_IDS.includes(id)));
  return Object.freeze((Array.isArray(groups) ? groups : []).map((group) => Object.freeze({
    id: group.id, label: group.label, count: group.count,
    selected: chosen.size === 0 || chosen.has(group.id),
  })));
}

/** A chip hides rows from the answer already in hand. It asks nothing new. */
export function applyScope(groups, kinds = []) {
  const chosen = new Set((Array.isArray(kinds) ? kinds : []).filter((id) => SEARCH_GROUP_IDS.includes(id)));
  if (chosen.size === 0) return Object.freeze([...(Array.isArray(groups) ? groups : [])]);
  return Object.freeze((Array.isArray(groups) ? groups : []).filter((group) => chosen.has(group.id)));
}

/** The total the page may print, which is the sum of what it is showing. */
export function visibleCount(groups) {
  return (Array.isArray(groups) ? groups : []).reduce((total, group) => total + group.count, 0);
}

/* ------------------------------------------------------------ the retired block */

/**
 * The tombstone block, built from the producer's own fields and its own
 * sentence. Never blended into the live counts.
 */
export function retiredSummary(payload) {
  if (!validSearchPayload(payload)) return null;
  const organizations = payload.organizations.filter((row) => row.retired_aliases > 0 || row.all_retired === true || row.retired_refs_truncated === true);
  return Object.freeze({
    note: payload.note,
    retiredParties: payload.parties.filter((row) => row.merged === true).length,
    organizations: Object.freeze(organizations.map((row) => Object.freeze({
      name: row.name,
      retiredAliases: row.retired_aliases,
      retiredRefs: refChips(row.retired_refs),
      truncated: row.retired_refs_truncated === true,
      allRetired: row.all_retired === true,
    }))),
  });
}

/**
 * The partial state's own sentence and its exact count. A truncation is the
 * producer telling you what it left out; the page repeats the number rather
 * than rounding it into a word.
 */
export function truncationNotes(payload, catchUp = null) {
  const notes = [];
  if (validSearchPayload(payload)) {
    for (const row of payload.organizations) {
      if (row.retired_refs_truncated !== true) continue;
      notes.push(`${row.name}: ${refChips(row.retired_refs).length} retired references shown of ${row.retired_aliases} recorded.`);
    }
  }
  if (catchUp && catchUp.state === "needs_disambiguation" && catchUp.candidates_truncated === true) {
    notes.push(`${catchUp.candidates.length} candidates shown of ${catchUp.candidate_count} found.`);
  }
  return Object.freeze(notes);
}

/* ------------------------------------------------------------------- the states */

/** The nine states of §4.6. One state, one heading, one body. */
export const SEARCH_STATE_COPY = Object.freeze({
  loading: Object.freeze({ title: "Searching…", copy: "One read of the record layer. Nothing below is cached.", retry: false }),
  empty: Object.freeze({ title: "Type a name to search.", copy: "Nothing has been asked of the record layer yet.", retry: false }),
  no_match: Object.freeze({ title: "Nothing in the record layer matches that name.", copy: NOT_SEARCHED_SENTENCE, retry: false }),
  stale: Object.freeze({ title: "Searching…", copy: "An older answer arrived after a newer one and was dropped.", retry: false }),
  unavailable: Object.freeze({ title: "The record layer did not answer.", copy: "Nothing here has been inferred, and no earlier answer is being shown as current.", retry: true }),
  refused: Object.freeze({ title: "The record layer refused this search.", copy: "The refusal is named below. Nothing was read.", retry: false }),
  unknown: Object.freeze({ title: "This answer did not match the shape this page knows how to read.", copy: "Nothing is shown from it, because a shape this page cannot read is a shape it cannot report honestly.", retry: true }),
  partial: Object.freeze({ title: "Part of this answer was truncated by the record layer.", copy: "The exact counts the producer reported are shown beside each truncated group.", retry: false }),
  disambiguation: Object.freeze({ title: "More than one record matches that name.", copy: "Choose one exact target. This page opens none of them on your behalf.", retry: false }),
  ready: Object.freeze({ title: "Results", copy: "Shown in the order the record layer returned them.", retry: false }),
});

export const SEARCH_STATES = Object.freeze([
  "loading", "empty", "no_match", "stale", "unavailable", "refused", "unknown", "partial", "disambiguation",
]);

/**
 * A thrown error to its state. The status is what separates a DECIDED refusal
 * from an unanswered path: `live-client.js` attaches it precisely so these two
 * never collapse into one, and this page keeps them apart.
 */
export function classifySearchFailure(error) {
  if (error && error.payload && nonEmptyString(error.payload.error)) return "refused";
  return "unavailable";
}

/** The refusal code, named. The BODY is never read and never rendered. */
export function refusalDetail(error) {
  const payload = error?.payload;
  if (!payload || !nonEmptyString(payload.error)) return null;
  const fields = Array.isArray(payload.fields) ? payload.fields.filter((entry) => nonEmptyString(entry)) : [];
  const missing = Array.isArray(payload.missing) ? payload.missing.filter((entry) => nonEmptyString(entry)) : [];
  return Object.freeze({
    code: payload.error,
    operation: nonEmptyString(payload.operation) ? payload.operation : null,
    fields: Object.freeze(fields),
    missing: Object.freeze(missing),
    hint: nonEmptyString(payload.hint) ? payload.hint : null,
  });
}

/**
 * What the tab shows. A refused, failed or unreadable read has already dropped
 * the payload before this is asked, so no state can print a number the read did
 * not deliver. `no_match` and `unavailable` are mutually exclusive by
 * construction: the first needs a valid payload, the second needs none.
 */
export function searchPhase({ status, payload, catchUp = null, submitted = false }) {
  if (status === "loading") return "loading";
  if (status === "unavailable" || status === "refused" || status === "unknown") return status;
  if (!submitted) return "empty";
  if (catchUp && catchUp.state === "needs_disambiguation") return "disambiguation";
  if (!payload) return "empty";
  if (truncationNotes(payload, catchUp).length > 0) return "partial";
  if (visibleCount(groupSearchResults(payload)) === 0) return "no_match";
  return "ready";
}

/**
 * The sequence guard. A response is accepted only when no newer read has been
 * started since it left; an older answer that overtakes a newer one renders
 * NOTHING rather than replacing what is on screen.
 */
export function acceptsSearchResponse(current, token) {
  return Number(current) === Number(token);
}

/* ------------------------------------------------------------------ the address */

/** `?q=` and `?kinds=` on an already-admitted path. The gate reads neither. */
export function parseSearchAddress(search) {
  const parameters = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const query = parameters.get("q");
  const kinds = (parameters.get("kinds") || "").split(",").map((entry) => entry.trim()).filter((entry) => SEARCH_GROUP_IDS.includes(entry));
  return Object.freeze({
    query: typeof query === "string" ? query : "",
    kinds: Object.freeze([...new Set(kinds)]),
    present: parameters.has("q"),
  });
}

/** The address a view is restored from. Byte-stable for the same view. */
export function searchAddress({ query = "", kinds = [] } = {}) {
  const parameters = new URLSearchParams();
  parameters.set("q", String(query ?? ""));
  const scope = (Array.isArray(kinds) ? kinds : []).filter((entry) => SEARCH_GROUP_IDS.includes(entry));
  if (scope.length > 0) parameters.set("kinds", scope.join(","));
  return `/business?${parameters.toString()}`;
}

/* ---------------------------------------------------------------- saved views */

/**
 * A DIFFERENT key from the workspace preferences. That separation is the whole
 * of checkable_done 3: saving a view must not touch a partner preference, and
 * there is no verb that would store one anywhere else.
 */
export const SAVED_VIEWS_KEY = "doctorcre.saved-views.v1";
export const SAVED_VIEWS_MAX = 12;

/** Guard rather than comment: this module may not write the preferences key. */
function assertNotPreferences(key) {
  if (key === PREFERENCES_KEY) throw new Error("saved views never write the workspace preference key");
}

export function readSavedViews(storage) {
  if (!storage) return Object.freeze([]);
  let raw = null;
  try { raw = storage.getItem(SAVED_VIEWS_KEY); } catch { return Object.freeze([]); }
  let parsed = null;
  try { parsed = JSON.parse(raw || "[]"); } catch { return Object.freeze([]); }
  if (!Array.isArray(parsed)) return Object.freeze([]);
  return Object.freeze(parsed
    .filter((view) => view && typeof view === "object" && nonEmptyString(view.name) && typeof view.query === "string")
    .slice(0, SAVED_VIEWS_MAX)
    .map((view) => Object.freeze({
      name: view.name,
      query: view.query,
      kinds: Object.freeze((Array.isArray(view.kinds) ? view.kinds : []).filter((entry) => SEARCH_GROUP_IDS.includes(entry))),
    })));
}

export function writeSavedViews(storage, views) {
  if (!storage) return Object.freeze([]);
  const next = Object.freeze((Array.isArray(views) ? views : []).slice(0, SAVED_VIEWS_MAX).map((view) => Object.freeze({
    name: view.name, query: view.query, kinds: Object.freeze([...(view.kinds || [])]),
  })));
  assertNotPreferences(SAVED_VIEWS_KEY);
  // Storage is a convenience and never a requirement: a browser that refuses it
  // keeps the views for this page's lifetime and says nothing was stored.
  try { storage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next)); } catch { /* a convenience, never a requirement */ }
  return next;
}

/** Save under a name. A second save under the same name replaces that view. */
export function saveView(views, { name, query, kinds = [] }) {
  const label = String(name ?? "").trim();
  if (label === "") return Object.freeze([...(views || [])]);
  const entry = Object.freeze({ name: label, query: String(query ?? ""), kinds: Object.freeze((Array.isArray(kinds) ? kinds : []).filter((id) => SEARCH_GROUP_IDS.includes(id))) });
  const rest = (views || []).filter((view) => view.name !== label);
  return Object.freeze([...rest, entry].slice(0, SAVED_VIEWS_MAX));
}

export function renameView(views, from, to) {
  const label = String(to ?? "").trim();
  if (label === "") return Object.freeze([...(views || [])]);
  return Object.freeze((views || []).map((view) => (view.name === from ? Object.freeze({ ...view, name: label }) : view)));
}

/** Reset clears the saved views and NOTHING else. */
export function resetViews() {
  return Object.freeze([]);
}
