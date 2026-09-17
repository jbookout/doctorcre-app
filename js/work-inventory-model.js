// V5-UX-C10 — Complete Work Inventory, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock of its own. The page is the
// only place that touches the document, so every rule below is testable without
// a browser.
//
// The producer's whole point is that a CAPPED ACTIVE QUEUE hides queued,
// dormant, superseded, declined and unlinked work. This consumer inherits that
// obligation: every status the census returns is shown by DEFAULT, nothing here
// orders one item above another, and an incomplete census is never painted as
// an empty one.

/** The six canonical kinds, in the order the census documents them. */
export const WORK_INVENTORY_KINDS = Object.freeze([
  "work_request", "portfolio_node", "loop", "work_shape", "slice_plan", "governance_item",
]);

export const WORK_INVENTORY_ENDPOINT = "/api/v1/work-inventory";
export const WORK_INVENTORY_LIMIT_DEFAULT = 100;
export const WORK_INVENTORY_LIMIT_MAX = 500;

export const KIND_LABEL = Object.freeze({
  work_request: "Work requests",
  portfolio_node: "Portfolio nodes",
  loop: "Open loops",
  work_shape: "Work shapes",
  slice_plan: "Slice plans",
  governance_item: "Governance items",
});

/**
 * Coverage state to the shared .status/.orb vocabulary. This is the one mapping
 * that decides whether a reader believes a source answered, so it is exported
 * and pinned by its own test: a source that could not be read must never paint
 * as healthy.
 */
export const COVERAGE_ORB = Object.freeze({
  complete: "healthy",
  partial: "attention",
  unavailable: "urgent",
});

export function coverageOrbState(state) {
  return COVERAGE_ORB[state] || "unknown";
}

export const COVERAGE_COPY = Object.freeze({
  complete: "Every row this source holds was enumerated.",
  partial: "This source answered, but not completely — the reason is stated.",
  unavailable: "This source could not be read. Its work is missing from the list below.",
});

const SOURCE_KEYS = ["source", "source_ref", "observed_at", "valid_until", "freshness", "correlation_id", "safe_explanation"];
const ITEM_KEYS = ["kind", "id", "version", "title", "status", "source_ref", "updated_at", "related", "unlinked", "open"];
const PAYLOAD_KEYS = ["viewer", "tenant", "kinds", "statuses", "limit", "items", "coverage", "census_complete", "next_cursor", "source"];
// A leg that failed carries no per-row accounting, so the producer omits both
// counters. Those two shapes are the only coverage rows that exist.
const COVERAGE_KEYS_READ = ["kind", "source_ref", "state", "count_returned", "count_total", "reason", "excluded_other_tenant", "page_capped"];
const COVERAGE_KEYS_UNAVAILABLE = ["kind", "source_ref", "state", "count_returned", "count_total", "reason"];
const COVERAGE_STATES = ["complete", "partial", "unavailable"];
const FRESHNESS = ["fresh", "stale", "missing", "unknown"];
const VIEWERS = ["joe", "dell"];
const TENANT = "carr-internal";

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function iso(value) {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value) {
  return value === null || nonEmptyString(value);
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0;
}

function stringList(value, allowed = null) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => nonEmptyString(entry)) &&
    new Set(value).size === value.length && (!allowed || value.every((entry) => allowed.includes(entry)));
}

function validSource(source) {
  return exactKeys(source, SOURCE_KEYS) && source.source === "work_inventory_census" &&
    nonEmptyString(source.source_ref) && iso(source.observed_at) && iso(source.valid_until) &&
    Date.parse(source.valid_until) > Date.parse(source.observed_at) &&
    FRESHNESS.includes(source.freshness) && nonEmptyString(source.correlation_id) &&
    nonEmptyString(source.safe_explanation);
}

function validRelated(related) {
  return Array.isArray(related) && related.every((link) => exactKeys(link, ["kind", "id"]) &&
    nonEmptyString(link.kind) && nonEmptyString(link.id));
}

/**
 * `open` is a destination the page turns into a link, so it is checked as one.
 * The census admits exactly one deep link today and null everywhere else; a
 * future absolute URL would have to be declared here beside the renderer.
 */
function validOpen(value) {
  return value === null || (typeof value === "string" && value.startsWith("/") && !value.startsWith("//"));
}

function validItem(item, kinds) {
  return exactKeys(item, ITEM_KEYS) && kinds.includes(item.kind) && nonEmptyString(item.id) &&
    nullableString(item.version) && nullableString(item.title) && nullableString(item.status) &&
    nonEmptyString(item.source_ref) && iso(item.updated_at) && validRelated(item.related) &&
    typeof item.unlinked === "boolean" && item.unlinked === (item.related.length === 0) &&
    validOpen(item.open);
}

function validCoverage(entry, kinds) {
  const shaped = entry?.state === "unavailable"
    ? exactKeys(entry, COVERAGE_KEYS_UNAVAILABLE) || exactKeys(entry, COVERAGE_KEYS_READ)
    : exactKeys(entry, COVERAGE_KEYS_READ);
  if (!shaped) return false;
  if (!kinds.includes(entry.kind) || !nonEmptyString(entry.source_ref)) return false;
  if (!COVERAGE_STATES.includes(entry.state)) return false;
  if (!wholeNumber(entry.count_returned)) return false;
  if (!(entry.count_total === null || wholeNumber(entry.count_total))) return false;
  if (!(entry.reason === null || nonEmptyString(entry.reason))) return false;
  // Neither degraded state is allowed to stay unexplained; "partial, no reason"
  // is indistinguishable from complete to a reader.
  if (entry.state !== "complete" && entry.reason === null) return false;
  if ("excluded_other_tenant" in entry && !wholeNumber(entry.excluded_other_tenant)) return false;
  if ("page_capped" in entry && typeof entry.page_capped !== "boolean") return false;
  return true;
}

/**
 * The exact-key contract. An unknown top-level key is REFUSED rather than
 * ignored: a producer that starts sending a field this page does not render has
 * to come back and declare it together with the renderer, which is the only way
 * a dead field cannot quietly become invisible work.
 */
export function validWorkInventoryPayload(payload) {
  if (!exactKeys(payload, PAYLOAD_KEYS)) return false;
  if (!VIEWERS.includes(payload.viewer) || payload.tenant !== TENANT) return false;
  if (!stringList(payload.kinds, WORK_INVENTORY_KINDS)) return false;
  // null statuses is the census default and means every status is in scope.
  if (!(payload.statuses === null || stringList(payload.statuses))) return false;
  if (!Number.isInteger(payload.limit) || payload.limit <= 0 || payload.limit > WORK_INVENTORY_LIMIT_MAX) return false;
  if (!Array.isArray(payload.items) || payload.items.length > payload.limit) return false;
  if (!payload.items.every((item) => validItem(item, payload.kinds))) return false;
  if (!Array.isArray(payload.coverage) || payload.coverage.length !== payload.kinds.length) return false;
  if (!payload.coverage.every((entry) => validCoverage(entry, payload.kinds))) return false;
  if (new Set(payload.coverage.map((entry) => entry.kind)).size !== payload.coverage.length) return false;
  if (typeof payload.census_complete !== "boolean") return false;
  // The flag is not independent evidence: it is a restatement of coverage, and a
  // disagreement is exactly how an incomplete census would be shown as whole.
  const whole = payload.coverage.every((entry) => entry.state === "complete");
  if (payload.census_complete !== whole) return false;
  if (!nullableString(payload.next_cursor)) return false;
  if (!validSource(payload.source)) return false;
  return true;
}

/** Stable identity of one census row across pages. */
export function itemKey(item) {
  return `${item?.kind}:${item?.id}`;
}

/**
 * Items grouped by kind in the census's declared order. Every requested kind
 * gets a group even when it returned nothing, because "this source returned no
 * rows" and "this source is not being asked" are different facts.
 */
export function groupItemsByKind(items, kinds = WORK_INVENTORY_KINDS) {
  const rows = Array.isArray(items) ? items : [];
  return kinds
    .filter((kind) => WORK_INVENTORY_KINDS.includes(kind))
    .map((kind) => ({ kind, label: KIND_LABEL[kind] || kind, items: rows.filter((item) => item.kind === kind) }));
}

/**
 * One reader-facing summary of the coverage strip. `counted` is deliberately
 * separate from `returned`: a source with no total has not been counted, and a
 * total is never inferred from the page in hand.
 */
export function coverageSummary(coverage) {
  const rows = Array.isArray(coverage) ? coverage : [];
  const byState = (state) => rows.filter((entry) => entry.state === state).map((entry) => entry.kind);
  const complete = byState("complete");
  const partial = byState("partial");
  const unavailable = byState("unavailable");
  const counted = rows.filter((entry) => Number.isInteger(entry.count_total));
  return {
    sources: rows.length,
    complete, partial, unavailable,
    returned: rows.reduce((sum, entry) => sum + (Number.isInteger(entry.count_returned) ? entry.count_returned : 0), 0),
    counted: counted.length,
    total: rows.length > 0 && counted.length === rows.length
      ? counted.reduce((sum, entry) => sum + entry.count_total, 0) : null,
    capped: rows.some((entry) => entry.page_capped === true),
    excluded: rows.reduce((sum, entry) => sum + (Number.isInteger(entry.excluded_other_tenant) ? entry.excluded_other_tenant : 0), 0),
    worst: unavailable.length > 0 ? "unavailable" : partial.length > 0 ? "partial" : rows.length > 0 ? "complete" : "unavailable",
  };
}

/**
 * The request the filter bar and the cursor describe. All six kinds selected is
 * the default and sends no `kinds` at all, so the page never narrows the census
 * by accident; an empty selection is the same request, because a surface that
 * shows nothing is not a filter this page offers.
 */
export function buildInventoryQuery({ kinds = [], statuses = [], limit = null, cursor = null } = {}) {
  const parameters = new URLSearchParams();
  const selected = WORK_INVENTORY_KINDS.filter((kind) => kinds.includes(kind));
  if (selected.length > 0 && selected.length < WORK_INVENTORY_KINDS.length) parameters.set("kinds", selected.join(","));
  const wanted = (Array.isArray(statuses) ? statuses : []).map((status) => String(status).trim()).filter(Boolean);
  if (wanted.length > 0) parameters.set("statuses", [...new Set(wanted)].join(","));
  if (Number.isInteger(limit) && limit > 0) parameters.set("limit", String(Math.min(limit, WORK_INVENTORY_LIMIT_MAX)));
  if (typeof cursor === "string" && cursor !== "") parameters.set("cursor", cursor);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

export function inventoryRequestPath(options) {
  return `${WORK_INVENTORY_ENDPOINT}${buildInventoryQuery(options)}`;
}

/**
 * Page append. Cursor paging can legitimately re-deliver a row whose updated_at
 * moved between reads; the merged list keeps the FIRST copy of each kind:id and
 * its position, so Load more never doubles an item or reshuffles what is read.
 */
export function mergeInventoryPages(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/** Free-text status narrowing, applied in the browser to what is already read. */
export function filterItemsByStatusText(items, text) {
  const needle = String(text ?? "").trim().toLowerCase();
  const rows = Array.isArray(items) ? items : [];
  if (needle === "") return rows;
  return rows.filter((item) => String(item.status ?? "").toLowerCase().includes(needle));
}

/**
 * What the list area must say. An empty page with census_complete false is the
 * failure this slice exists to prevent, so it is its own state and it carries
 * the census's own explanation.
 */
export function listPhase({ status, payload, visible = 0 }) {
  if (status === "loading") return "loading";
  if (status === "unauthorized") return "no_access";
  if (status === "error") return "offline";
  if (!payload) return "loading";
  if (payload.items.length === 0) return payload.census_complete ? "empty" : "partial";
  if (visible === 0) return "no_match";
  return payload.census_complete ? "ready" : "partial";
}
