// V5-UX-C07 — the atlas fixture, in its own module so the test suite can import
// the very code the fixture server answers with. A fixture described by a test
// rather than executed by it is how the previous slice certified a friendlier
// predicate than the producer.
/**
 * Synthetic V5-UX-C07 atlas graph. Every free-text title starts with "Demo " so
 * nothing here can be mistaken for a record.
 *
 * THE FIXTURE MUST NOT BE FRIENDLIER THAN THE PRODUCER. Three places where a
 * kinder fixture would certify the wrong predicate, and each is reproduced:
 *
 *  1. `limit` above the maximum is CLAMPED, but `limit=0` is REFUSED. Those are
 *     not the same rule and a fixture that refused both would hide it.
 *  2. A cursor the current filter no longer yields is a 403, never a silent
 *     restart at page one.
 *  3. `layer=inferred` is refused. `inferred` is a coverage class, never a
 *     layer, and no node ever carries it as evidence.
 *
 * Coverage is deliberately NOT clean: one leg is DEPENDENCY_UNAVAILABLE and one
 * is page_capped, so freshness is "unknown" and "incomplete, not empty" is the
 * default state of this fixture — the same choice the census fixture made.
 */
const ATLAS_LAYERS = ["declared", "installed", "observed"];
const ATLAS_LIMIT_DEFAULT = 500;
const ATLAS_LIMIT_MAX = 2000;

const node = (id, klass, key, title, layer, status, source_ref, evidence, extra = {}) => ({
  id, class: klass, key, title, layer, status, retired_at: null, source_ref, evidence, unlinked: false, ...extra,
});
const observed = (at, status, ref) => ({ observed_at: at, observed_status: status, observed_source_ref: ref });

const ATLAS_NODES = [
  node("verb:demo-add-loop", "verb", "demo-add-loop", "Demo verb: add a loop", "declared", "registered", "mcp-server/src/tools.js", "declared"),
  node("mutation:demo-add-loop", "mutation", "demo-add-loop", "Demo mutation: add a loop", "declared", "registered", "mcp-server/src/mutation-registry.js", "declared"),
  node("module:demo/loops.js", "module", "demo/loops.js", "Demo module: loops", "declared", "registered", "mcp-server/src/mutation-registry.js", "declared"),
  node("surface:demo-surface", "surface", "demo-surface", "Demo surface nothing points at", "declared", "registered", "mcp-server/src/surfaces.js", "declared"),
  node("service:demo-worker", "service", "demo-worker", "Demo worker", "installed", "critical", "ops.service", "observed", observed("2026-09-16T11:40:00.000Z", "succeeded", "ops.run")),
  node("service:demo-exporter", "service", "demo-exporter", "Demo exporter", "installed", "ordinary", "ops.service", "installed"),
  node("service_environment:demo-worker/production", "service_environment", "demo-worker/production", "Demo worker · production", "installed", "active", "ops.service_environment", "observed", observed("2026-09-16T11:41:00.000Z", "live:healthy", "ops.run")),
  node("job_definition:demo-prebrief", "job_definition", "demo-prebrief", "Demo scheduled prebrief", "installed", "enabled", "ops.job_definition", "observed", observed("2026-09-16T06:02:00.000Z", "live:succeeded", "ops.run")),
  node("rule:11111111-1111-4111-8111-111111111111", "rule", "demo.rule.coverage", "Demo rule: coverage travels with every count", "installed", "active", "ops.rule_admission", "observed", observed("2026-09-16T10:12:00.000Z", "enforced", "ops.v_rule_enforcement_status")),
  node("control:demo.gate", "control", "demo.gate", "Demo control: the demo gate", "installed", "installed", "ops.control", "installed"),
  node("control:demo.uninstalled", "control", "demo.uninstalled", "Demo control: declared but never installed", "installed", "declared_only", "ops.control", "installed"),
  node("rule_pack:demo-pack", "rule_pack", "demo-pack", "Demo rule pack", "installed", "active", "ops.rule_pack", "installed"),
  node("doctrine_section:demo-section", "doctrine_section", "demo-section", "Demo doctrine section", "installed", "active", "public.doctrine_section", "installed"),
  node("rule:22222222-2222-4222-8222-222222222222", "rule", "demo.rule.clockless", "Demo rule: observed without a clock", "installed", "blocked", "ops.rule_admission", "observed", observed(null, null, "ops.v_rule_enforcement_status")),
  node("workflow:demo-release", "workflow", "demo-release", "Demo release workflow", "observed", "succeeded", "ops.run", "observed", observed("2026-09-16T09:30:00.000Z", "succeeded", "ops.run")),
  { ...node("service:demo-md-renderer", "service", "demo-md-renderer", "Demo markdown renderer", "installed", "retired", "ops.service", "installed"), retired_at: "2026-08-19T00:00:00.000Z" },
];

const edge = (from, to, type, evidence, source_ref, observed_at = null) => ({ from, to, type, evidence, source_ref, observed_at });

const ATLAS_EDGES = [
  edge("verb:demo-add-loop", "mutation:demo-add-loop", "mutates_through", "declared", "mcp-server/src/mutation-registry.js"),
  edge("mutation:demo-add-loop", "module:demo/loops.js", "implemented_in", "declared", "mcp-server/src/mutation-registry.js"),
  edge("service:demo-worker", "service:demo-exporter", "depends_on", "installed", "ops.service_dependency"),
  edge("service:demo-worker", "service:demo-md-renderer", "depends_on", "installed", "ops.service_dependency"),
  edge("service:demo-worker", "service_environment:demo-worker/production", "runs_in", "installed", "ops.service_environment"),
  edge("job_definition:demo-prebrief", "service_environment:demo-worker/production", "runs_in", "installed", "ops.job_definition", "2026-09-16T06:02:00.000Z"),
  edge("rule:11111111-1111-4111-8111-111111111111", "control:demo.gate", "enforced_by", "installed", "ops.rule_control"),
  edge("rule:11111111-1111-4111-8111-111111111111", "control:demo.uninstalled", "enforced_by", "installed", "ops.rule_control"),
  edge("rule:11111111-1111-4111-8111-111111111111", "rule_pack:demo-pack", "loaded_in_pack", "installed", "ops.rule_pack_member"),
  edge("control:demo.gate", "workflow:demo-release", "bound_to", "installed", "ops.control_binding"),
  // An open-ended type straight from public.doctrine_link.role, so the page is
  // exercised against a relationship word it does not know in advance.
  edge("doctrine_section:demo-section", "rule:11111111-1111-4111-8111-111111111111", "citation", "installed", "public.doctrine_link"),
];

// The four structural gaps the producer appends to EVERY response, verbatim.
const ATLAS_KNOWN_GAPS = [
  { source_ref: "ops.scac_mutation_registry_entry", evidence_class: "installed", node_count: 0, edge_count: 0, complete: false, missing_reason: "no_grant" },
  { source_ref: "ops/config/hooks.json + control-plane-workflows.v1.json + services.json", evidence_class: "declared", node_count: 0, edge_count: 0, complete: false, missing_reason: "not_in_bundle" },
  { source_ref: "public.tool_call verb name", evidence_class: "observed", node_count: 0, edge_count: 0, complete: false, missing_reason: "column_not_granted" },
  { source_ref: "verb->service", evidence_class: "inferred", node_count: 0, edge_count: 0, complete: false, missing_reason: "no_relation" },
];

function atlasGraph(url) {
  const layerParameter = url.searchParams.get("layer");
  if (layerParameter !== null && !ATLAS_LAYERS.includes(layerParameter)) return { refused: 403 };
  const layers = layerParameter === null ? [...ATLAS_LAYERS] : [layerParameter];

  const retiredParameter = url.searchParams.get("include_retired");
  if (retiredParameter !== null && retiredParameter !== "true" && retiredParameter !== "false") return { refused: 403 };
  const includeRetired = retiredParameter === "true";

  const limitParameter = url.searchParams.get("limit");
  let limit = ATLAS_LIMIT_DEFAULT;
  if (limitParameter !== null) {
    // Refused when it is not a positive integer; CLAMPED when it is too large.
    if (!/^\d+$/.test(limitParameter) || Number.parseInt(limitParameter, 10) <= 0) return { refused: 403 };
    limit = Math.min(Number.parseInt(limitParameter, 10), ATLAS_LIMIT_MAX);
  }

  const query = url.searchParams.get("q");
  const trimmed = query === null ? "" : query.trim().toLowerCase();
  const q = trimmed === "" ? null : trimmed;

  const matching = ATLAS_NODES
    .filter((row) => layers.includes(row.layer))
    .filter((row) => includeRetired || row.retired_at === null)
    .filter((row) => q === null || `${row.id} ${row.key} ${row.title}`.toLowerCase().includes(q));

  // The cursor is opaque to the consumer; here it is `demo-atlas-page-<n>`.
  // A cursor this filter no longer yields is a REFUSAL, never a silent restart:
  // restarting would quietly re-deliver page one as page two.
  const cursor = url.searchParams.get("cursor");
  let offset = 0;
  if (cursor !== null) {
    const match = /^demo-atlas-page-(\d+)$/.exec(cursor);
    if (!match) return { refused: 403 };
    const pageNumber = Number.parseInt(match[1], 10);
    if (pageNumber < 2) return { refused: 403 };
    offset = (pageNumber - 1) * limit;
    if (offset >= matching.length) return { refused: 403 };
  }
  const page = matching.slice(offset, offset + limit);
  const truncated = matching.length > offset + page.length;
  const nextPage = `demo-atlas-page-${Math.floor(offset / limit) + 2}`;
  const onPage = new Set(page.map((row) => row.id));
  // Edges and `unlinked` are recomputed PER PAGE, exactly as the producer does.
  const edges = ATLAS_EDGES.filter((row) => onPage.has(row.from) && onPage.has(row.to));
  const touched = new Set(edges.flatMap((row) => [row.from, row.to]));
  const nodes = page.map((row) => ({ ...row, unlinked: !touched.has(row.id) }));

  const index = {};
  for (const row of nodes) {
    index[row.layer] = index[row.layer] || {};
    index[row.layer][row.class] = index[row.layer][row.class] || [];
    index[row.layer][row.class].push(row.id);
  }

  const coverage = [
    { source_ref: "mcp-server/src/tools.js", evidence_class: "declared", node_count: nodes.filter((row) => row.layer === "declared").length, edge_count: edges.filter((row) => row.evidence === "declared").length, complete: true, missing_reason: null },
    { source_ref: "ops.service", evidence_class: "installed", node_count: nodes.filter((row) => row.class === "service").length, edge_count: edges.filter((row) => row.type === "depends_on").length, complete: true, missing_reason: null },
    { source_ref: "ops.run", evidence_class: "observed", node_count: 0, edge_count: 0, complete: false, missing_reason: "DEPENDENCY_UNAVAILABLE" },
    { source_ref: "public.doctrine_edge", evidence_class: "installed", node_count: 0, edge_count: 0, complete: false, missing_reason: "page_capped" },
    ...ATLAS_KNOWN_GAPS,
  ];
  const stamp = new Date();
  return {
    payload: {
      version: {
        bundle_digest: "a".repeat(64),
        registry_version: "scac-mutation-registry.v32",
        registry_digest: "b".repeat(64),
        declared_counts: { verbs: 218, mutations: 1, surfaces: 1, routes: 0 },
      },
      observed_at: stamp.toISOString(),
      viewer: "joe",
      tenant: "carr-internal",
      layer: ATLAS_LAYERS.filter((entry) => layers.includes(entry)),
      q,
      include_retired: includeRetired,
      limit,
      nodes,
      edges,
      index,
      coverage,
      truncated,
      next_cursor: truncated ? nextPage : null,
      source: {
        source: "atlas_inventory_graph",
        source_ref: "mcp-server/src/tools.js+ops.service+ops.run+verb->service",
        observed_at: stamp.toISOString(),
        correlation_id: `demo-atlas-${stamp.valueOf()}`,
        freshness: "unknown",
        safe_explanation: "This atlas is INCOMPLETE, not empty: ops.run could not be read and public.doctrine_edge was capped by the page limit. The four structural gaps below are named in coverage on every read.",
      },
    },
  };
}


const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const refusal = (status, error, headers = {}) => ({ status, headers: { ...JSON_HEADERS, ...headers }, body: { error } });

/**
 * The whole route, exactly as the deployed one behaves. The fixture-only
 * `outage` switch is the ONE key outside the producer's five that is tolerated
 * here; every other stray key is a 403, which is what the deployed route does
 * with `viewer`.
 */
export function atlasFixtureResponse(url, method = "GET") {
  if (method === "OPTIONS") return { status: 204, headers: { allow: "GET, HEAD, OPTIONS" }, body: null };
  if (method !== "GET" && method !== "HEAD") return refusal(405, "METHOD_NOT_ALLOWED", { allow: "GET, HEAD, OPTIONS" });
  const outage = url.searchParams.get("outage");
  if (outage === "atlas-flag") return refusal(404, "not_found");
  if (outage === "atlas-tenant") return refusal(404, "TENANT_SCOPE_REFUSED");
  if (outage === "atlas-freshness") return refusal(409, "FRESHNESS_UNKNOWN");
  if (outage === "atlas-internal") return refusal(500, "INTERNAL_ERROR");
  if (outage === "atlas" || outage === "all") return refusal(503, "DEPENDENCY_UNAVAILABLE");
  const allowed = new Set(["layer", "q", "include_retired", "limit", "cursor", "outage"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return refusal(403, "AUTHORIZATION_REFUSED");
  }
  const result = atlasGraph(url);
  if (result.refused) return refusal(result.refused, "AUTHORIZATION_REFUSED");
  return { status: 200, headers: JSON_HEADERS, body: result.payload };
}
