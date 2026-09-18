// V5-UX-C08 prototype — the atlas fixture graph, frozen into a module the browser
// can load. The prototype pages never reach the network, so the payload the
// renderer draws is embedded here rather than read from /api/v1/atlas-graph.
//
// This literal is NOT hand-written and must not be hand-edited. It is the exact
// body `scripts/atlas-fixture.mjs` answers `?include_retired=true` with, and
// `test/atlas-anatomy.test.mjs` re-derives it from that fixture on every run and
// refuses any drift. Only the two stamps a clock would move — `observed_at` and
// `correlation_id` — are pinned, so the fixture stays the single source.
export const ATLAS_DEMO_PAYLOAD = Object.freeze({
  "version": {
    "bundle_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "registry_version": "scac-mutation-registry.v32",
    "registry_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "declared_counts": {
      "verbs": 218,
      "mutations": 1,
      "surfaces": 1,
      "routes": 0
    }
  },
  "observed_at": "2026-09-18T14:02:00.000Z",
  "viewer": "joe",
  "tenant": "carr-internal",
  "layer": [
    "declared",
    "installed",
    "observed"
  ],
  "q": null,
  "include_retired": true,
  "limit": 500,
  "nodes": [
    {
      "id": "verb:demo-add-loop",
      "class": "verb",
      "key": "demo-add-loop",
      "title": "Demo verb: add a loop",
      "layer": "declared",
      "status": "registered",
      "retired_at": null,
      "source_ref": "mcp-server/src/tools.js",
      "evidence": "declared",
      "unlinked": false
    },
    {
      "id": "mutation:demo-add-loop",
      "class": "mutation",
      "key": "demo-add-loop",
      "title": "Demo mutation: add a loop",
      "layer": "declared",
      "status": "registered",
      "retired_at": null,
      "source_ref": "mcp-server/src/mutation-registry.js",
      "evidence": "declared",
      "unlinked": false
    },
    {
      "id": "module:demo/loops.js",
      "class": "module",
      "key": "demo/loops.js",
      "title": "Demo module: loops",
      "layer": "declared",
      "status": "registered",
      "retired_at": null,
      "source_ref": "mcp-server/src/mutation-registry.js",
      "evidence": "declared",
      "unlinked": false
    },
    {
      "id": "surface:demo-surface",
      "class": "surface",
      "key": "demo-surface",
      "title": "Demo surface nothing points at",
      "layer": "declared",
      "status": "registered",
      "retired_at": null,
      "source_ref": "mcp-server/src/surfaces.js",
      "evidence": "declared",
      "unlinked": true
    },
    {
      "id": "service:demo-worker",
      "class": "service",
      "key": "demo-worker",
      "title": "Demo worker",
      "layer": "installed",
      "status": "critical",
      "retired_at": null,
      "source_ref": "ops.service",
      "evidence": "observed",
      "unlinked": false,
      "observed_at": "2026-09-16T11:40:00.000Z",
      "observed_status": "succeeded",
      "observed_source_ref": "ops.run"
    },
    {
      "id": "service:demo-exporter",
      "class": "service",
      "key": "demo-exporter",
      "title": "Demo exporter",
      "layer": "installed",
      "status": "ordinary",
      "retired_at": null,
      "source_ref": "ops.service",
      "evidence": "installed",
      "unlinked": false
    },
    {
      "id": "service_environment:demo-worker/production",
      "class": "service_environment",
      "key": "demo-worker/production",
      "title": "Demo worker · production",
      "layer": "installed",
      "status": "active",
      "retired_at": null,
      "source_ref": "ops.service_environment",
      "evidence": "observed",
      "unlinked": false,
      "observed_at": "2026-09-16T11:41:00.000Z",
      "observed_status": "live:healthy",
      "observed_source_ref": "ops.run"
    },
    {
      "id": "job_definition:demo-prebrief",
      "class": "job_definition",
      "key": "demo-prebrief",
      "title": "Demo scheduled prebrief",
      "layer": "installed",
      "status": "enabled",
      "retired_at": null,
      "source_ref": "ops.job_definition",
      "evidence": "observed",
      "unlinked": false,
      "observed_at": "2026-09-16T06:02:00.000Z",
      "observed_status": "live:succeeded",
      "observed_source_ref": "ops.run"
    },
    {
      "id": "rule:11111111-1111-4111-8111-111111111111",
      "class": "rule",
      "key": "demo.rule.coverage",
      "title": "Demo rule: coverage travels with every count",
      "layer": "installed",
      "status": "active",
      "retired_at": null,
      "source_ref": "ops.rule_admission",
      "evidence": "observed",
      "unlinked": false,
      "observed_at": "2026-09-16T10:12:00.000Z",
      "observed_status": "enforced",
      "observed_source_ref": "ops.v_rule_enforcement_status"
    },
    {
      "id": "control:demo.gate",
      "class": "control",
      "key": "demo.gate",
      "title": "Demo control: the demo gate",
      "layer": "installed",
      "status": "installed",
      "retired_at": null,
      "source_ref": "ops.control",
      "evidence": "installed",
      "unlinked": false
    },
    {
      "id": "control:demo.uninstalled",
      "class": "control",
      "key": "demo.uninstalled",
      "title": "Demo control: declared but never installed",
      "layer": "installed",
      "status": "declared_only",
      "retired_at": null,
      "source_ref": "ops.control",
      "evidence": "installed",
      "unlinked": false
    },
    {
      "id": "rule_pack:demo-pack",
      "class": "rule_pack",
      "key": "demo-pack",
      "title": "Demo rule pack",
      "layer": "installed",
      "status": "active",
      "retired_at": null,
      "source_ref": "ops.rule_pack",
      "evidence": "installed",
      "unlinked": false
    },
    {
      "id": "doctrine_section:demo-section",
      "class": "doctrine_section",
      "key": "demo-section",
      "title": "Demo doctrine section",
      "layer": "installed",
      "status": "active",
      "retired_at": null,
      "source_ref": "public.doctrine_section",
      "evidence": "installed",
      "unlinked": false
    },
    {
      "id": "rule:22222222-2222-4222-8222-222222222222",
      "class": "rule",
      "key": "demo.rule.clockless",
      "title": "Demo rule: observed without a clock",
      "layer": "installed",
      "status": "blocked",
      "retired_at": null,
      "source_ref": "ops.rule_admission",
      "evidence": "observed",
      "unlinked": true,
      "observed_at": null,
      "observed_status": null,
      "observed_source_ref": "ops.v_rule_enforcement_status"
    },
    {
      "id": "workflow:demo-release",
      "class": "workflow",
      "key": "demo-release",
      "title": "Demo release workflow",
      "layer": "observed",
      "status": "succeeded",
      "retired_at": null,
      "source_ref": "ops.run",
      "evidence": "observed",
      "unlinked": false,
      "observed_at": "2026-09-16T09:30:00.000Z",
      "observed_status": "succeeded",
      "observed_source_ref": "ops.run"
    },
    {
      "id": "service:demo-md-renderer",
      "class": "service",
      "key": "demo-md-renderer",
      "title": "Demo markdown renderer",
      "layer": "installed",
      "status": "retired",
      "retired_at": "2026-08-19T00:00:00.000Z",
      "source_ref": "ops.service",
      "evidence": "installed",
      "unlinked": false
    }
  ],
  "edges": [
    {
      "from": "verb:demo-add-loop",
      "to": "mutation:demo-add-loop",
      "type": "mutates_through",
      "evidence": "declared",
      "source_ref": "mcp-server/src/mutation-registry.js",
      "observed_at": null
    },
    {
      "from": "mutation:demo-add-loop",
      "to": "module:demo/loops.js",
      "type": "implemented_in",
      "evidence": "declared",
      "source_ref": "mcp-server/src/mutation-registry.js",
      "observed_at": null
    },
    {
      "from": "service:demo-worker",
      "to": "service:demo-exporter",
      "type": "depends_on",
      "evidence": "installed",
      "source_ref": "ops.service_dependency",
      "observed_at": null
    },
    {
      "from": "service:demo-worker",
      "to": "service:demo-md-renderer",
      "type": "depends_on",
      "evidence": "installed",
      "source_ref": "ops.service_dependency",
      "observed_at": null
    },
    {
      "from": "service:demo-worker",
      "to": "service_environment:demo-worker/production",
      "type": "runs_in",
      "evidence": "installed",
      "source_ref": "ops.service_environment",
      "observed_at": null
    },
    {
      "from": "job_definition:demo-prebrief",
      "to": "service_environment:demo-worker/production",
      "type": "runs_in",
      "evidence": "installed",
      "source_ref": "ops.job_definition",
      "observed_at": "2026-09-16T06:02:00.000Z"
    },
    {
      "from": "rule:11111111-1111-4111-8111-111111111111",
      "to": "control:demo.gate",
      "type": "enforced_by",
      "evidence": "installed",
      "source_ref": "ops.rule_control",
      "observed_at": null
    },
    {
      "from": "rule:11111111-1111-4111-8111-111111111111",
      "to": "control:demo.uninstalled",
      "type": "enforced_by",
      "evidence": "installed",
      "source_ref": "ops.rule_control",
      "observed_at": null
    },
    {
      "from": "rule:11111111-1111-4111-8111-111111111111",
      "to": "rule_pack:demo-pack",
      "type": "loaded_in_pack",
      "evidence": "installed",
      "source_ref": "ops.rule_pack_member",
      "observed_at": null
    },
    {
      "from": "control:demo.gate",
      "to": "workflow:demo-release",
      "type": "bound_to",
      "evidence": "installed",
      "source_ref": "ops.control_binding",
      "observed_at": null
    },
    {
      "from": "doctrine_section:demo-section",
      "to": "rule:11111111-1111-4111-8111-111111111111",
      "type": "citation",
      "evidence": "installed",
      "source_ref": "public.doctrine_link",
      "observed_at": null
    }
  ],
  "index": {
    "declared": {
      "verb": [
        "verb:demo-add-loop"
      ],
      "mutation": [
        "mutation:demo-add-loop"
      ],
      "module": [
        "module:demo/loops.js"
      ],
      "surface": [
        "surface:demo-surface"
      ]
    },
    "installed": {
      "service": [
        "service:demo-worker",
        "service:demo-exporter",
        "service:demo-md-renderer"
      ],
      "service_environment": [
        "service_environment:demo-worker/production"
      ],
      "job_definition": [
        "job_definition:demo-prebrief"
      ],
      "rule": [
        "rule:11111111-1111-4111-8111-111111111111",
        "rule:22222222-2222-4222-8222-222222222222"
      ],
      "control": [
        "control:demo.gate",
        "control:demo.uninstalled"
      ],
      "rule_pack": [
        "rule_pack:demo-pack"
      ],
      "doctrine_section": [
        "doctrine_section:demo-section"
      ]
    },
    "observed": {
      "workflow": [
        "workflow:demo-release"
      ]
    }
  },
  "coverage": [
    {
      "source_ref": "mcp-server/src/tools.js",
      "evidence_class": "declared",
      "node_count": 4,
      "edge_count": 2,
      "complete": true,
      "missing_reason": null
    },
    {
      "source_ref": "ops.service",
      "evidence_class": "installed",
      "node_count": 3,
      "edge_count": 2,
      "complete": true,
      "missing_reason": null
    },
    {
      "source_ref": "ops.run",
      "evidence_class": "observed",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "DEPENDENCY_UNAVAILABLE"
    },
    {
      "source_ref": "public.doctrine_edge",
      "evidence_class": "installed",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "page_capped"
    },
    {
      "source_ref": "ops.scac_mutation_registry_entry",
      "evidence_class": "installed",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "no_grant"
    },
    {
      "source_ref": "ops/config/hooks.json + control-plane-workflows.v1.json + services.json",
      "evidence_class": "declared",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "not_in_bundle"
    },
    {
      "source_ref": "public.tool_call verb name",
      "evidence_class": "observed",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "column_not_granted"
    },
    {
      "source_ref": "verb->service",
      "evidence_class": "inferred",
      "node_count": 0,
      "edge_count": 0,
      "complete": false,
      "missing_reason": "no_relation"
    }
  ],
  "truncated": false,
  "next_cursor": null,
  "source": {
    "source": "atlas_inventory_graph",
    "source_ref": "mcp-server/src/tools.js+ops.service+ops.run+verb->service",
    "observed_at": "2026-09-18T14:02:00.000Z",
    "correlation_id": "demo-atlas-prototype",
    "freshness": "unknown",
    "safe_explanation": "This atlas is INCOMPLETE, not empty: ops.run could not be read and public.doctrine_edge was capped by the page limit. The four structural gaps below are named in coverage on every read."
  }
});

/** The two stamps the freeze replaces, named so the test can exclude exactly these. */
export const DEMO_STAMPS = Object.freeze({ observed_at: "2026-09-18T14:02:00.000Z", correlation_id: "demo-atlas-prototype" });
