// V5-UX-C07 — Atlas inventory graph, consumer model.
//
// Pure functions only: no DOM, no fetch, no clock of its own. Every rule the
// Atlas tab obeys is decided here so it can be tested without a browser.
//
// Three facts from the producer shape everything below, and each one is a place
// a friendlier consumer would lie:
//
//  1. "inferred" is a COVERAGE class, never a layer and never a node's evidence.
//     A node may only ever read declared, installed or observed. The fourth
//     class is visible in the coverage block, where it belongs.
//  2. The four structural gaps are appended to EVERY response. The atlas is
//     therefore never complete, and this page never prints that it is.
//  3. `unlinked` and `edges` are recomputed PER PAGE. "Nothing points at this"
//     means "nothing on this page points at this", and the page says exactly
//     that in words rather than claiming the node stands alone anywhere.

export const ATLAS_ENDPOINT = "/api/v1/atlas-graph";

/** The three layers, in the producer's canonical order. `inferred` is not one. */
export const ATLAS_LAYERS = Object.freeze(["declared", "installed", "observed"]);

/** The four evidence classes, of which only the first three reach a node. */
export const EVIDENCE_CLASSES = Object.freeze(["declared", "installed", "observed", "inferred"]);

export const ATLAS_LIMIT_DEFAULT = 500;
export const ATLAS_LIMIT_MAX = 2000;
export const ATLAS_TENANT = "carr-internal";
export const ATLAS_VIEWERS = Object.freeze(["joe", "dell"]);

/** The twelve node classes the graph actually emits, in emission order. */
export const NODE_CLASS_ORDER = Object.freeze([
  "verb", "mutation", "module", "surface",
  "service", "service_environment", "job_definition", "rule", "rule_pack", "control", "doctrine_section",
  "workflow",
]);

export const LAYER_LABEL = Object.freeze({
  declared: "Declared", installed: "Installed", observed: "Observed",
});

export const NODE_CLASS_LABEL = Object.freeze({
  verb: "Verbs", mutation: "Mutations", module: "Modules", surface: "Surfaces",
  service: "Services", service_environment: "Service environments", job_definition: "Job definitions",
  rule: "Rules", rule_pack: "Rule packs", control: "Controls", doctrine_section: "Doctrine sections",
  workflow: "Workflows",
});

export const MISSING_REASONS = Object.freeze([
  "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR", "page_capped",
  "no_grant", "not_in_bundle", "column_not_granted", "no_relation",
]);

/**
 * The four gaps the producer appends to every response. They are named here so
 * the page can group them under their own heading — a permanent, known
 * shortfall is a different fact from a source that failed on this read.
 */
export const KNOWN_GAPS = Object.freeze([
  Object.freeze({ source_ref: "ops.scac_mutation_registry_entry", evidence_class: "installed", missing_reason: "no_grant" }),
  Object.freeze({ source_ref: "ops/config/hooks.json + control-plane-workflows.v1.json + services.json", evidence_class: "declared", missing_reason: "not_in_bundle" }),
  Object.freeze({ source_ref: "public.tool_call verb name", evidence_class: "observed", missing_reason: "column_not_granted" }),
  Object.freeze({ source_ref: "verb->service", evidence_class: "inferred", missing_reason: "no_relation" }),
]);

const GAP_REFS = new Set(KNOWN_GAPS.map((gap) => gap.source_ref));

/** Reasons that mean a source failed on THIS read, not a declared shortfall. */
const DEGRADED_REASONS = Object.freeze(["DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR", "page_capped"]);

/* ------------------------------------------------------- the frozen sentences */

/** Edges are page-scoped, so a missing relationship is not an absent one. */
export const PAGE_SCOPE_SENTENCE =
  "Relationships are shown for nodes on this page. A relationship to a node on another page is not drawn here.";

/** CR-AC-09 asks for a successor; the graph has no such field, so this is said. */
export const NO_SUCCESSOR_SENTENCE = "This release records no successor for a retired node.";

/** `unlinked` is per page, so a stronger word would overclaim what was read. */
export const UNLINKED_SENTENCE = "Nothing on this page points at this node.";

/** The heading whenever a source failed beyond the four declared gaps. */
export const INCOMPLETE_HEADING = "This atlas is incomplete, not empty";

export const NO_OBSERVED_CLOCK = "no clock recorded for this observation";
export const NO_OBSERVED_STATUS = "no status recorded for this observation";
export const NO_RUN_HEADING = "No run has been observed for this node";
export const RUN_HEADING = "What happened on a run";

/** CR-AC-07's out-of-scope half, named rather than left blank. */
export const VERB_RUN_GAP_SENTENCE =
  "No run evidence exists for a verb: public.tool_call verb name is a published gap (column_not_granted), so this release draws no traffic for it at all.";

/** CR-AC-08's "missing enforcement coverage visibly remains missing". */
export const NO_ENFORCEMENT_SENTENCE = "No installed enforcement point is recorded for this rule.";

/** CR-AC-08's out-of-scope third leg. */
export const NO_TEST_EVIDENCE_SENTENCE =
  "No test relation is read by any leg of this graph, so test coverage for this rule is not shown here and is not claimed to be absent.";

export const EXPOSURE_STATEMENT =
  "This page lists what this system declares it has, what is installed and what has been " +
  "observed running. It is an inventory of machinery, not of deals, and it holds no client or " +
  "property information. The record layer's actor check is the only gate and this app adds none. " +
  "This device remembers the selected node id only, and nothing here is cached offline.";

/** One state, one sentence. Both 404 causes deliberately share one copy. */
export const ATLAS_STATE_COPY = Object.freeze({
  idle: Object.freeze({ title: "The atlas has not been read yet", copy: "It is read when this tab is first opened, so the dashboard's own reads are not delayed." }),
  loading: Object.freeze({ title: "Reading the atlas…", copy: "One request-time read. Nothing below is cached, and no earlier page is left on screen." }),
  empty: Object.freeze({ title: "No node matches this search.", copy: "The coverage below still names every source that answered and every known gap." }),
  no_access: Object.freeze({ title: "This session cannot read the atlas. Nothing here has been inferred.", copy: "Sign in again, or ask for the read to be granted. No partial graph is drawn from a refused read." }),
  not_here: Object.freeze({ title: "The atlas read is not available on this host.", copy: "The host answered 404. That is the same answer whether the surface is switched off or this tenant is out of scope, and this page does not guess which." }),
  freshness_unknown: Object.freeze({ title: "CARR could not establish the freshness of this atlas, so nothing is shown as current.", copy: "Nothing below is drawn from an earlier read." }),
  unavailable: Object.freeze({ title: "A source CARR depends on is unavailable right now, so no partial atlas is presented as whole.", copy: "Try again once the source answers." }),
  offline: Object.freeze({ title: "The atlas read failed. Nothing here has been inferred.", copy: "No earlier page is being shown as current." }),
});

/* ------------------------------------------------------------------ validation */

const PAYLOAD_KEYS = ["version", "observed_at", "viewer", "tenant", "layer", "q", "include_retired", "limit", "nodes", "edges", "index", "coverage", "truncated", "next_cursor", "source"];
const VERSION_KEYS = ["bundle_digest", "registry_version", "registry_digest", "declared_counts"];
const DECLARED_COUNT_KEYS = ["verbs", "mutations", "surfaces", "routes"];
// A node carries ten keys, or those ten plus the whole observed trio. Two of the
// three is refused: a half-attached observation is a shape this page cannot
// render honestly, and silently ignoring it is how a blank becomes a zero.
const NODE_KEYS = ["id", "class", "key", "title", "layer", "status", "retired_at", "source_ref", "evidence", "unlinked"];
const NODE_OBSERVED_KEYS = ["observed_at", "observed_status", "observed_source_ref"];
const EDGE_KEYS = ["from", "to", "type", "evidence", "source_ref", "observed_at"];
const COVERAGE_KEYS = ["source_ref", "evidence_class", "node_count", "edge_count", "complete", "missing_reason"];
// Six keys, and NO valid_until: the atlas source block is not the census's.
const SOURCE_KEYS = ["source", "source_ref", "observed_at", "correlation_id", "freshness", "safe_explanation"];
const FRESHNESS = ["fresh", "stale", "missing", "unknown"];

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

function nullableIso(value) {
  return value === null || iso(value);
}

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0;
}

function hexDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validVersion(version) {
  if (!exactKeys(version, VERSION_KEYS)) return false;
  if (!hexDigest(version.bundle_digest)) return false;
  if (!nonEmptyString(version.registry_version) || !nullableString(version.registry_digest)) return false;
  if (!exactKeys(version.declared_counts, DECLARED_COUNT_KEYS)) return false;
  return DECLARED_COUNT_KEYS.every((key) => wholeNumber(version.declared_counts[key]));
}

function validSource(source) {
  return exactKeys(source, SOURCE_KEYS) && source.source === "atlas_inventory_graph" &&
    nonEmptyString(source.source_ref) && iso(source.observed_at) &&
    nonEmptyString(source.correlation_id) && FRESHNESS.includes(source.freshness) &&
    nonEmptyString(source.safe_explanation);
}

/**
 * A node. `layer` and `evidence` are checked against the THREE layers, never the
 * four classes: a node that arrived carrying `inferred` would mean the producer
 * changed its mind about what a node is, and this page must stop rather than
 * paint a class it has no row for.
 */
export function validAtlasNode(node) {
  const observed = NODE_OBSERVED_KEYS.filter((key) => node && typeof node === "object" && key in node);
  if (observed.length !== 0 && observed.length !== NODE_OBSERVED_KEYS.length) return false;
  if (!exactKeys(node, observed.length === 0 ? NODE_KEYS : [...NODE_KEYS, ...NODE_OBSERVED_KEYS])) return false;
  if (!nonEmptyString(node.id) || !nonEmptyString(node.class) || !nonEmptyString(node.key)) return false;
  if (!nullableString(node.title) || !nullableString(node.status)) return false;
  if (!ATLAS_LAYERS.includes(node.layer) || !ATLAS_LAYERS.includes(node.evidence)) return false;
  if (!nullableIso(node.retired_at)) return false;
  if (!nonEmptyString(node.source_ref)) return false;
  if (typeof node.unlinked !== "boolean") return false;
  if (observed.length === 0) return true;
  // The producer attaches an observation with a null clock and a null status
  // when its source has neither (ops.v_rule_enforcement_status carries no run
  // clock: atlas-inventory-graph.v5.js emits isoOrNull and `?? null`). Refusing
  // those 128 rule nodes refused the whole production atlas on 2026-09-18.
  return nullableIso(node.observed_at) && nullableString(node.observed_status) && nonEmptyString(node.observed_source_ref);
}

export function validAtlasEdge(edge) {
  return exactKeys(edge, EDGE_KEYS) && nonEmptyString(edge.from) && nonEmptyString(edge.to) &&
    // `type` is data-driven for doctrine edges and links, so it is checked as a
    // string and rendered verbatim. A closed table here would silently drop a
    // relationship the record layer added.
    nonEmptyString(edge.type) && ATLAS_LAYERS.includes(edge.evidence) &&
    nonEmptyString(edge.source_ref) && nullableIso(edge.observed_at);
}

export function validAtlasCoverage(entry) {
  if (!exactKeys(entry, COVERAGE_KEYS)) return false;
  if (!nonEmptyString(entry.source_ref) || !EVIDENCE_CLASSES.includes(entry.evidence_class)) return false;
  if (!wholeNumber(entry.node_count) || !wholeNumber(entry.edge_count)) return false;
  if (typeof entry.complete !== "boolean") return false;
  if (!(entry.missing_reason === null || MISSING_REASONS.includes(entry.missing_reason))) return false;
  // "Incomplete, and no reason" reads exactly like complete. It is refused.
  if (entry.complete === false && entry.missing_reason === null) return false;
  return true;
}

function validAtlasIndex(index, layers) {
  if (!index || typeof index !== "object" || Array.isArray(index)) return false;
  for (const [layer, classes] of Object.entries(index)) {
    if (!layers.includes(layer)) return false;
    if (!classes || typeof classes !== "object" || Array.isArray(classes)) return false;
    for (const ids of Object.values(classes)) {
      if (!Array.isArray(ids) || !ids.every((id) => nonEmptyString(id))) return false;
    }
  }
  return true;
}

/**
 * The exact-key contract for the whole payload. An unknown top-level key is
 * REFUSED rather than ignored, so a producer that starts sending a field this
 * page does not render has to come back and declare it with the renderer.
 */
export function validAtlasPayload(payload) {
  if (!exactKeys(payload, PAYLOAD_KEYS)) return false;
  if (!validVersion(payload.version)) return false;
  if (!iso(payload.observed_at)) return false;
  if (!ATLAS_VIEWERS.includes(payload.viewer) || payload.tenant !== ATLAS_TENANT) return false;
  if (!Array.isArray(payload.layer) || payload.layer.length === 0) return false;
  if (!payload.layer.every((entry) => ATLAS_LAYERS.includes(entry))) return false;
  if (new Set(payload.layer).size !== payload.layer.length) return false;
  // The producer returns the layers in its own canonical order; a reordered
  // list would mean the page is reading something else.
  if (payload.layer.join(",") !== ATLAS_LAYERS.filter((entry) => payload.layer.includes(entry)).join(",")) return false;
  if (!nullableString(payload.q)) return false;
  if (typeof payload.include_retired !== "boolean") return false;
  if (!Number.isInteger(payload.limit) || payload.limit <= 0 || payload.limit > ATLAS_LIMIT_MAX) return false;
  if (!Array.isArray(payload.nodes) || payload.nodes.length > payload.limit) return false;
  if (!payload.nodes.every((node) => validAtlasNode(node))) return false;
  if (new Set(payload.nodes.map((node) => node.id)).size !== payload.nodes.length) return false;
  if (!Array.isArray(payload.edges) || !payload.edges.every((edge) => validAtlasEdge(edge))) return false;
  if (!Array.isArray(payload.coverage) || payload.coverage.length === 0) return false;
  if (!payload.coverage.every((entry) => validAtlasCoverage(entry))) return false;
  // The four structural gaps are appended to every response. Their absence means
  // this is not the atlas read, or it is one that has stopped declaring them.
  for (const gap of KNOWN_GAPS) {
    if (!payload.coverage.some((entry) => entry.source_ref === gap.source_ref &&
      entry.evidence_class === gap.evidence_class && entry.missing_reason === gap.missing_reason)) return false;
  }
  if (!validAtlasIndex(payload.index, payload.layer)) return false;
  if (typeof payload.truncated !== "boolean") return false;
  if (!nullableString(payload.next_cursor)) return false;
  if (!validSource(payload.source)) return false;
  return true;
}

/* -------------------------------------------------------------------- requests */

/**
 * The request the controls describe. "All" sends no `layer` at all, so the page
 * never narrows the graph by accident, and `inferred` is not offerable: it is a
 * coverage class, and sending it would be refused with a 403.
 */
export function buildAtlasQuery({ layer = null, q = "", includeRetired = false, limit = null, cursor = null } = {}) {
  const parameters = new URLSearchParams();
  if (typeof layer === "string" && ATLAS_LAYERS.includes(layer)) parameters.set("layer", layer);
  const needle = String(q ?? "").trim();
  if (needle !== "") parameters.set("q", needle);
  if (includeRetired === true) parameters.set("include_retired", "true");
  if (Number.isInteger(limit) && limit > 0) parameters.set("limit", String(Math.min(limit, ATLAS_LIMIT_MAX)));
  // The cursor is opaque. It is passed back exactly as it was handed over and is
  // never parsed, decoded or split.
  if (typeof cursor === "string" && cursor !== "") parameters.set("cursor", cursor);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

export function atlasRequestPath(options) {
  return `${ATLAS_ENDPOINT}${buildAtlasQuery(options)}`;
}

/* --------------------------------------------------------------- the hierarchy */

/**
 * `payload.index` is already layer → class → ids; this turns it into rows the
 * page can paint, in the producer's canonical order. A class that is present
 * but empty still gets its group, because "this class returned nothing" and
 * "this class was not asked for" are different facts.
 */
export function groupIndex(payload) {
  const index = payload?.index && typeof payload.index === "object" ? payload.index : {};
  const byId = new Map((Array.isArray(payload?.nodes) ? payload.nodes : []).map((node) => [node.id, node]));
  const layers = Array.isArray(payload?.layer) ? payload.layer : ATLAS_LAYERS;
  return ATLAS_LAYERS.filter((layer) => layers.includes(layer)).map((layer) => {
    const classes = index[layer] && typeof index[layer] === "object" ? index[layer] : {};
    const names = [
      ...NODE_CLASS_ORDER.filter((name) => name in classes),
      ...Object.keys(classes).filter((name) => !NODE_CLASS_ORDER.includes(name)),
    ];
    return {
      layer,
      label: LAYER_LABEL[layer] || layer,
      classes: names.map((name) => ({
        class: name,
        label: NODE_CLASS_LABEL[name] || name,
        // An id in the index with no node on this page is dropped rather than
        // rendered as a stub: a row with no evidence and no source_ref would be
        // exactly the unsourced claim this slice exists to prevent.
        nodes: (Array.isArray(classes[name]) ? classes[name] : []).map((id) => byId.get(id)).filter(Boolean),
      })),
    };
  });
}

/* ----------------------------------------------------------------- the coverage */

/** A source that could not be read must never paint as healthy. */
export function coverageOrbFor(entry) {
  if (entry?.complete === true) return "healthy";
  if (entry?.missing_reason === "page_capped") return "attention";
  return "urgent";
}

export function isKnownGap(entry) {
  return GAP_REFS.has(entry?.source_ref);
}

/**
 * Two headings, because two different facts. A leg that failed on this read is
 * an outage; the four structural rows are a shortfall this release declares up
 * front and never stops declaring.
 */
export function coverageGroups(coverage) {
  const rows = Array.isArray(coverage) ? coverage : [];
  return Object.freeze({
    answered: rows.filter((entry) => !isKnownGap(entry)),
    gaps: rows.filter((entry) => isKnownGap(entry)),
  });
}

/**
 * True when a source failed on THIS read — not merely because the four declared
 * gaps are present, which they always are. This is what turns the heading into
 * "incomplete, not empty".
 */
export function atlasDegraded(payload) {
  const rows = Array.isArray(payload?.coverage) ? payload.coverage : [];
  return rows.some((entry) => entry.complete === false && DEGRADED_REASONS.includes(entry.missing_reason));
}

/* -------------------------------------------------------- the selection contract */

/**
 * V5-UX-C08 consumes THIS, not the DOM. A pure function of the payload already
 * in hand: selecting a node takes no second request, and `pageScoped` is carried
 * on the result so no consumer can forget that these edges are a page's worth.
 */
export function selectionFor(payload, id) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const node = nodes.find((candidate) => candidate.id === id) || null;
  if (!node) return null;
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];
  const observed = "observed_at" in node
    ? Object.freeze({ observed_at: node.observed_at, observed_status: node.observed_status, observed_source_ref: node.observed_source_ref })
    : null;
  return Object.freeze({
    node,
    out: edges.filter((edge) => edge.from === id),
    in: edges.filter((edge) => edge.to === id),
    observed,
    pageScoped: true,
  });
}

/* ------------------------------------------------------------------ the paging */

/**
 * "Show more" exists only when the producer says there is more AND hands over a
 * cursor to ask with. `truncated` alone is not enough: a button that sends no
 * cursor would re-read page one for ever.
 */
export function pagingState(payload) {
  const cursor = typeof payload?.next_cursor === "string" && payload.next_cursor !== "" ? payload.next_cursor : null;
  const truncated = payload?.truncated === true;
  return Object.freeze({
    more: truncated && cursor !== null,
    cursor,
    truncated,
    // Never "N of M": the graph publishes no total, so none is printed.
    line: truncated ? `${Array.isArray(payload?.nodes) ? payload.nodes.length : 0} shown · more remain` : null,
  });
}

/** Page append. A re-delivered node keeps its FIRST copy and its position. */
export function mergeNodePages(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const node of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    merged.push(node);
  }
  return merged;
}

/* ------------------------------------------------------------------- the states */

/** An HTTP status to the one state that describes it. 401 and 403 share one. */
export function classifyAtlasFailure(status) {
  const code = Number(status || 0);
  if (code === 401 || code === 403) return "no_access";
  if (code === 404) return "not_here";
  if (code === 409) return "freshness_unknown";
  if (code === 503) return "unavailable";
  return "offline";
}

/**
 * What the tab shows. A refused or failed read clears the payload before this is
 * asked, so no state can ever show a number the read did not deliver.
 */
export function atlasPhase({ status, payload }) {
  if (status === "idle") return "idle";
  if (status === "loading") return "loading";
  if (typeof status === "string" && status in ATLAS_STATE_COPY && status !== "ready") return status;
  if (!payload) return "loading";
  if (payload.nodes.length === 0) return "empty";
  return atlasDegraded(payload) ? "partial" : "ready";
}
