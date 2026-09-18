// V5-UX-B06 — Commercial charts and linked drilldown, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock of its own. Every rule the
// Charts tab obeys is decided here so it can be tested without a browser.
//
// Five producer facts shape everything below, and each one is a place a
// friendlier consumer would lie:
//
//  1. ONE read. Every chart, count and row on the tab is derived from a single
//     `deal-room-board` response, so "chart totals match the filtered canonical
//     records at the same as-of" is true BY CONSTRUCTION: there is no second
//     read to disagree with. The drilldown filters the rows already in hand.
//  2. A null dimension is a BUCKET, never a drop and never a zero. `segment` is
//     null on 49 of 74 rows, `market` on 34, `owner` on 32; a chart that
//     filtered them away would print a total that is not the board's.
//  3. `accounts[].open_deals` and its four siblings arrive as STRINGS, because
//     they are Postgres `count(*)` bigints and the driver does not narrow a
//     bigint. `"0"` is TRUTHY. Every one is narrowed with `Number()` here, and
//     a non-finite result renders "unknown" — never 0.
//  4. Every date field is a STRING OR NULL, never a Date: the handler renders
//     `next_date`, `last_touch`, `last_review_at` and `parked_at` through
//     `to_jsonb(x)#>>'{}'`. `last_review_at` is null on all 74 deals and all 3
//     accounts, so there is no review clock to draw — only the absence to name.
//  5. The app has NO read that returns a closed-out deal (`deal-board` filters
//     `outcome is null`) and NO read that carries a fee, a commission or a
//     close value. So this tab charts the open board only, says so, and draws
//     no forecast at all rather than a fabricated one.
import { COLUMNS, columnByValue } from "./pipeline-model.js";

/* --------------------------------------------------------- the frozen sentences */

/** UX10 "forecast assumptions explicit", satisfied by having no forecast. */
export const NO_FORECAST_SENTENCE =
  "There is no forecast here. No read this app can reach carries a fee, a commission, a rent or a " +
  "close value — the board has no money column, and the verb's own description calls its Salesforce " +
  "commission and close-date fields placeholders rather than data. A deal-economics read does not " +
  "exist yet, so nothing on this tab is projected, weighted or extrapolated.";

/** checkable_done 2 — the snapshot is not a history, and says which it is. */
export const SNAPSHOT_SENTENCE =
  "This is the open board as it answered a moment ago, not a history. No read this app can reach " +
  "returns a closed-out deal, so there is no won/lost series, no period selector and no trend line " +
  "on this tab. A deal that leaves the board leaves these charts with it.";

/** §3.2 — the verb returns no server timestamp, so the page never says "as of". */
export const ONE_READ_SENTENCE =
  "Every number on this tab comes from one read of the board. Choosing a slice filters the rows " +
  "already in hand; it asks the record layer for nothing further, so a filtered total cannot " +
  "disagree with the total it came out of.";

/** §3.6 — the owner split is a device fact, because no preference verb exists. */
export const OWNER_DISCLOSURE_SENTENCE =
  "The owner split is closed until you open it, it is listed by name rather than by count, and it " +
  "calls nobody behind. Whether you left it open is remembered in this browser on this device " +
  "only; there is no verb that stores a partner preference, so none is sent.";

/* ---------------------------------------------------------------- the validator */

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The shape `deal-room-board` always returns: four keys, `deals` and `accounts`
 * both arrays. Asserted in BOTH directions (defect 33e8409b): it must accept
 * the real captured payload and it must reject one with a key removed.
 */
export function validBoardPayload(payload) {
  if (!isObject(payload)) return false;
  if (!Array.isArray(payload.deals)) return false;
  if (!Array.isArray(payload.accounts)) return false;
  return payload.deals.every((deal) => isObject(deal) && nonEmptyString(deal.id));
}

/* ------------------------------------------------------------ bigint narrowing */

/** The bucket key a null dimension falls into. Not a value any producer sends. */
export const NO_VALUE_KEY = "__none__";

/**
 * A Postgres `count(*)` as it actually arrives — a string. `Number()` narrows
 * it; anything that is not finite is "unknown" and is NEVER shown as 0, and
 * `"0"` narrows to a real 0 rather than staying truthy.
 */
export function countValue(raw) {
  // A `count(*)` is a string of digits or it is not a count. `Number()` alone is
  // far more permissive than the producer: it turns `[]` into 0, `true` into 1
  // and "0x10" into 16, and it loses precision silently above 2^53. None of
  // those can come out of Postgres, so none of them is accepted as a count.
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return Object.freeze({ value: null, text: "unknown", known: false });
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return Object.freeze({ value: null, text: "unknown", known: false });
  return Object.freeze({ value, text: String(value), known: true });
}

/* ------------------------------------------------------------- the dimensions */

/**
 * The dimensions a row can be grouped and drilled by. `owner` is here because
 * the disclosure needs it; it is NOT one of the charts painted on load.
 */
export const DIMENSIONS = Object.freeze([
  Object.freeze({ id: "phase", label: "Phase", noValue: "Not placed on this board" }),
  Object.freeze({ id: "type", label: "Deal type", noValue: "No type on file" }),
  Object.freeze({ id: "segment", label: "Segment", noValue: "Not segmented" }),
  Object.freeze({ id: "market", label: "Market", noValue: "No market on file" }),
  Object.freeze({ id: "operating_state", label: "Waiting", noValue: "No operating state on file" }),
  Object.freeze({ id: "owner", label: "Owner", noValue: "unassigned" }),
]);

export const DIMENSION_IDS = Object.freeze(DIMENSIONS.map((dimension) => dimension.id));

export function dimensionById(id) {
  return DIMENSIONS.find((dimension) => dimension.id === id) || null;
}

/**
 * Bucket rows by one field, in the PRODUCER's order of first appearance, with
 * the null bucket appended at the end.
 *
 * A record whose value is null is counted under `NO_VALUE_KEY`. It is never
 * filtered out: the buckets of any dimension sum to `deals.length`, which is
 * the whole of "missing/stale not zero" for this surface.
 */
export function bucketRows(deals, field) {
  const dimension = dimensionById(field);
  const rows = Array.isArray(deals) ? deals : [];
  const order = [];
  const byKey = new Map();
  let missing = 0;
  for (const deal of rows) {
    if (!isObject(deal)) continue;
    const raw = deal[field];
    if (raw === null || raw === undefined || raw === "") { missing += 1; continue; }
    const key = String(raw);
    if (!byKey.has(key)) { byKey.set(key, { key, label: key, count: 0, missing: false }); order.push(key); }
    byKey.get(key).count += 1;
  }
  const out = order.map((key) => Object.freeze(byKey.get(key)));
  if (missing > 0) {
    out.push(Object.freeze({
      key: NO_VALUE_KEY, label: dimension ? dimension.noValue : "No value on file", count: missing, missing: true,
    }));
  }
  return Object.freeze(out);
}

/**
 * The eight phases in the board's own table order, plus whatever the board
 * holds that this surface cannot place. An unplaced row is PRINTED, never
 * dropped and never folded into a neighbouring column.
 */
export function phaseRows(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const byValue = new Map(COLUMNS.map((column) => [column.value, { key: column.slug, label: column.label, count: 0, missing: false }]));
  let unplaced = 0;
  for (const deal of rows) {
    if (!isObject(deal)) continue;
    const bucket = byValue.get(deal.phase);
    if (bucket) bucket.count += 1;
    else unplaced += 1;
  }
  const out = COLUMNS.map((column) => Object.freeze(byValue.get(column.value)));
  if (unplaced > 0) out.push(Object.freeze({ key: NO_VALUE_KEY, label: "Not placed on this board", count: unplaced, missing: true }));
  return Object.freeze(out);
}

/** The sum of a chart's rows. It equals the row count it was built from. */
export function rowTotal(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => total + (Number(row?.count) || 0), 0);
}

/** The widest count in a chart, so a bar can be drawn as a share of it. */
export function barShare(row, rows) {
  const counts = (Array.isArray(rows) ? rows : []).map((entry) => Number(entry?.count) || 0);
  const widest = counts.length === 0 ? 0 : Math.max(...counts);
  if (!(widest > 0)) return 0;
  return Math.round(((Number(row?.count) || 0) / widest) * 100);
}

/* --------------------------------------------------------------- the six cards */

/**
 * `operating_state` plus the attention flag. The attention count is printed as
 * "n of m", so a legitimate 0 is readable as a real zero out of a real total
 * rather than as an unexplained blank.
 */
export function waitingSummary(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const flagged = rows.filter((deal) => isObject(deal) && deal.attention === true).length;
  const parked = rows.filter((deal) => isObject(deal) && deal.operating_state === "parked");
  return Object.freeze({
    states: bucketRows(rows, "operating_state"),
    attention: flagged,
    total: rows.length,
    attentionLine: `${flagged} of ${rows.length} flagged for attention`,
    parked: Object.freeze(parked.map((deal) => Object.freeze({
      id: deal.id,
      name: nonEmptyString(deal.name) ? deal.name : "unnamed record",
      reason: nonEmptyString(deal.parking_reason) ? deal.parking_reason : "no reason on file",
    }))),
  });
}

/**
 * Next-date coverage. `next_date` is null on 73 of 74 rows, and this card is
 * where that is stated as its own evidence: a count of records with no date,
 * never a day count, never today, never a 1970 age from a zero fallback.
 */
export function nextDateCoverage(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const withDate = rows.filter((deal) => isObject(deal) && nonEmptyString(deal.next_date)).length;
  const without = rows.length - withDate;
  return Object.freeze({
    withDate,
    without,
    total: rows.length,
    sentence: `${without} of ${rows.length} have no next date on file`,
  });
}

/**
 * Recency by `last_touch`. A null is "unknown", NOT "stale": the board did not
 * say the record went quiet, it said it does not know when it was last touched.
 */
export function touchCoverage(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const known = rows.filter((deal) => isObject(deal) && nonEmptyString(deal.last_touch)).length;
  return Object.freeze({
    known,
    unknown: rows.length - known,
    total: rows.length,
    sentence: `${rows.length - known} of ${rows.length} have no last-touch time on file, which is unknown rather than stale`,
  });
}

/** The words a null `last_review_at` gets. It is never a zero-day clock. */
export const NEVER_REVIEWED = "never reviewed here";

/**
 * The `accounts[]` rollup, in the verb's own order, with every bigint string
 * narrowed once at this boundary.
 */
export function accountRows(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  return Object.freeze(rows.filter(isObject).map((account) => Object.freeze({
    id: nonEmptyString(account.account_client_id) ? account.account_client_id : null,
    ref: nonEmptyString(account.account_client_ref) ? account.account_client_ref : "",
    name: nonEmptyString(account.account_name) ? account.account_name : "unnamed account",
    owner: nonEmptyString(account.account_owner) ? account.account_owner : "unassigned",
    counts: Object.freeze([
      Object.freeze({ id: "open_deals", label: "open", ...countValue(account.open_deals) }),
      Object.freeze({ id: "attention_deals", label: "flagged", ...countValue(account.attention_deals) }),
      Object.freeze({ id: "overdue_deals", label: "overdue", ...countValue(account.overdue_deals) }),
      Object.freeze({ id: "stale_deals", label: "stale", ...countValue(account.stale_deals) }),
      Object.freeze({ id: "parked_deals", label: "parked", ...countValue(account.parked_deals) }),
    ]),
    review: nonEmptyString(account.last_review_at) ? account.last_review_at : NEVER_REVIEWED,
  })));
}

/**
 * The owner split, behind the collapsed disclosure.
 *
 * Ordered BY NAME and never by count — a list ordered by count is a ranking,
 * and this slice's record says workload comparison is absent by default. The
 * unassigned bucket is last because it is the null bucket, not because it is
 * smallest. This is the one ordering decision in this module, and it is made
 * on the name.
 */
export function ownerRows(deals) {
  const named = bucketRows(deals, "owner");
  const missing = named.filter((row) => row.missing);
  const byName = named.filter((row) => !row.missing).toSorted((a, b) => a.label.localeCompare(b.label));
  return Object.freeze([...byName, ...missing]);
}

/* ------------------------------------------------------------- the drilldown */

/**
 * The rows a selection keeps, taken from the payload already in hand. No read,
 * so the filtered totals are a subset of the unfiltered ones by construction.
 */
export function filterDeals(deals, group, pick) {
  const rows = Array.isArray(deals) ? deals : [];
  if (!dimensionById(group) || pick === null || pick === undefined || pick === "") return Object.freeze([...rows]);
  return Object.freeze(rows.filter((deal) => {
    if (!isObject(deal)) return false;
    const raw = group === "phase" ? (columnByValue(deal.phase)?.slug ?? null) : deal[group];
    if (pick === NO_VALUE_KEY) return raw === null || raw === undefined || raw === "";
    return raw !== null && raw !== undefined && String(raw) === String(pick);
  }));
}

/** What a chosen slice is called on the page. Never a guess at a missing name. */
export function selectionLabel(group, pick) {
  const dimension = dimensionById(group);
  if (!dimension || pick === null || pick === undefined || pick === "") return null;
  if (pick === NO_VALUE_KEY) return `${dimension.label}: ${dimension.noValue}`;
  if (group === "phase") {
    const column = COLUMNS.find((entry) => entry.slug === pick);
    return `${dimension.label}: ${column ? column.label : String(pick)}`;
  }
  return `${dimension.label}: ${String(pick)}`;
}

/* -------------------------------------------------------------- the address */

/**
 * `?charts=1&group=&pick=` on an already-admitted path. `/business` is in
 * APP_DOCUMENT_PATHS and the gate does not inspect a query string, so no route
 * moves and no gate entry is needed.
 */
export function parseChartsAddress(search) {
  const parameters = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const group = parameters.get("group");
  const pick = parameters.get("pick");
  const known = typeof group === "string" && DIMENSION_IDS.includes(group);
  return Object.freeze({
    present: parameters.get("charts") === "1",
    group: known ? group : null,
    pick: known && typeof pick === "string" && pick !== "" ? pick : null,
  });
}

/** The address a selection restores from. Byte-stable for the same selection. */
export function chartsAddress({ group = null, pick = null } = {}) {
  const parameters = new URLSearchParams();
  parameters.set("charts", "1");
  if (DIMENSION_IDS.includes(group) && typeof pick === "string" && pick !== "") {
    parameters.set("group", group);
    parameters.set("pick", pick);
  }
  return `/business?${parameters.toString()}`;
}

/* ------------------------------------------------------------------ the states */

export const CHARTS_STATE_COPY = Object.freeze({
  loading: Object.freeze({ title: "Reading the board…", copy: "One read. Nothing below is cached and no count is shown until it arrives.", retry: false }),
  ready: Object.freeze({ title: "The open board", copy: "Every chart below is one read of the board, filtered in this browser.", retry: false }),
  empty: Object.freeze({ title: "The board answered and holds no open deals", copy: "There is nothing to chart. This is an answer, not an outage, and no chart is drawn as a row of zeros.", retry: false }),
  partial: Object.freeze({ title: "The board answered without any national accounts", copy: "The deal charts below are complete. The accounts card has nothing to roll up, and says so rather than showing zeros.", retry: false }),
  no_match: Object.freeze({ title: "Nothing on this board matches that slice", copy: "The board answered and holds records, but none carries the value this address names. No chart is drawn from an empty slice, because a grid of zeros would read as a finding.", retry: false }),
  unreadable: Object.freeze({ title: "This answer did not match the shape this page knows how to read", copy: "Nothing is shown from it, because a shape this page cannot read is a shape it cannot report honestly.", retry: true }),
  refused: Object.freeze({ title: "The record layer refused this read for your session.", copy: "A decision was taken before the read ran. Nothing was read, and there is nothing here to retry.", retry: false }),
  unavailable: Object.freeze({ title: "The board could not be reached. Nothing here has been inferred.", copy: "No earlier answer is being shown as current, and no chart has been drawn from a guess.", retry: true }),
  stale: Object.freeze({ title: "Reading the board…", copy: "An older answer arrived after a newer one and was dropped.", retry: false }),
});

// `unknown` is NOT in this list, and deliberately: the spec gives that word to a
// CELL whose count is not finite after narrowing (`countValue`), and the chart
// around it still paints. A page-level answer this surface cannot read is
// `unreadable`, so one word does not name two different things.
export const CHARTS_STATES = Object.freeze(["loading", "ready", "no_match", "empty", "partial", "unreadable", "refused", "unavailable", "stale"]);

/**
 * A thrown error to its state. 401 and 403 are DECIDED refusals and offer no
 * Retry; everything else is a path that did not answer and does.
 */
export function classifyBoardFailure(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return "refused";
  return "unavailable";
}

/**
 * What the tab shows. A failed read has already dropped the payload.
 *
 * The SELECTION is part of this answer, because an address is editable and
 * copyable: `?group=segment&pick=NoSuchSegment` is a legal address that matches
 * nothing, and painting it as eight charts of zeros would dress an empty set as
 * a finding. It gets its own heading and no chart at all, exactly as `empty`
 * does — the two differ in what is absent, so they differ in what they say.
 */
export function chartsPhase({ status, payload, group = null, pick = null }) {
  if (status === "loading") return "loading";
  if (status === "refused" || status === "unavailable" || status === "unreadable") return status;
  // Never `loading`: a shape this page will never accept cannot be waited out.
  if (!validBoardPayload(payload)) return status === "ready" ? "unreadable" : "loading";
  if (payload.deals.length === 0) return "empty";
  if (selectionLabel(group, pick) && filterDeals(payload.deals, group, pick).length === 0) return "no_match";
  if (payload.accounts.length === 0) return "partial";
  return "ready";
}

/**
 * The sequence guard. A response paints only when no newer read has been
 * started since it left; an older answer that overtakes a newer one renders
 * NOTHING rather than replacing what is on screen.
 */
export function acceptsBoardResponse(current, token) {
  return Number(current) === Number(token);
}

/* ------------------------------------------------------------ the device fact */

/**
 * A DIFFERENT key from the workspace preferences and from the saved views: the
 * only thing stored is whether the owner disclosure was left open, and no verb
 * is sent because none exists that would store a partner preference.
 */
export const CHARTS_VIEW_KEY = "doctorcre.charts-view.v1";

export function readChartsView(storage) {
  if (!storage) return Object.freeze({ ownerOpen: false });
  let raw = null;
  try { raw = storage.getItem(CHARTS_VIEW_KEY); } catch { return Object.freeze({ ownerOpen: false }); }
  let parsed = null;
  try { parsed = JSON.parse(raw || "{}"); } catch { return Object.freeze({ ownerOpen: false }); }
  return Object.freeze({ ownerOpen: isObject(parsed) && parsed.ownerOpen === true });
}

export function writeChartsView(storage, view) {
  const next = Object.freeze({ ownerOpen: view?.ownerOpen === true });
  if (!storage) return next;
  try { storage.setItem(CHARTS_VIEW_KEY, JSON.stringify(next)); } catch { /* a convenience, never a requirement */ }
  return next;
}
