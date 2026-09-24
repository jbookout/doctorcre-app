// V5-UX-C09 — Atlas incidents, causal traces and Doc tours: the pure model.
//
// Each test names the acceptance text or checkable_done bullet it stands for,
// so a passing suite is legible as coverage of the delivery slice rather than
// as a pile of assertions.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CAUSAL_GRAPH_GAP_SENTENCE, DOC_TOUR_EMPTY, INCIDENT_JOIN_SENTENCE, INCIDENT_TRACE_HEADING,
  NO_ENFORCEMENT_SENTENCE, NO_INCIDENT_READ_SENTENCE, NO_INCIDENT_TRACE_SENTENCE, RUN_HEADING,
  UNLINKED_SENTENCE, VERB_RUN_GAP_SENTENCE,
  buildDocTour, groupHasOpenIncident, incidentServiceIndex, incidentTraceRows,
  serviceKeyFromIncidentFingerprint, serviceNodeOpenIncidents,
} from "../js/atlas-model.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { notInReleaseBlocks } from "../js/control-room-model.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const atlasJs = await read("js/atlas.js");
const controlRoomJs = await read("js/control-room.js");
const html = await read("control-room.html");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async (options = {}) => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options });
};

const node = (id, klass, key, extra = {}) => ({
  id, class: klass, key, title: `Demo ${key}`, layer: "declared", status: "registered",
  retired_at: null, source_ref: "demo", evidence: "declared", unlinked: false, ...extra,
});

/* ------------------------------------------------------- the fingerprint join */

test("serviceKeyFromIncidentFingerprint reads the documented service|environment|operation|failure_class shape", () => {
  assert.equal(serviceKeyFromIncidentFingerprint("demo-worker|production|nightly|timeout"), "demo-worker");
});

test("serviceKeyFromIncidentFingerprint refuses to guess at a malformed or legacy fingerprint", () => {
  assert.equal(serviceKeyFromIncidentFingerprint("demo-service|SEV-1|demo"), null, "three parts is not the four-part shape");
  assert.equal(serviceKeyFromIncidentFingerprint("a||c|d"), null, "an empty segment is not a real service key");
  assert.equal(serviceKeyFromIncidentFingerprint(""), null);
  assert.equal(serviceKeyFromIncidentFingerprint(null), null);
  assert.equal(serviceKeyFromIncidentFingerprint(undefined), null);
});

test("incidentServiceIndex groups open incidents by the service key their own fingerprint names", () => {
  const board = {
    incidents: [
      { ref: "INC-1", fingerprint: "demo-worker|production|nightly|timeout" },
      { ref: "INC-2", fingerprint: "demo-worker|staging|nightly|timeout" },
      { ref: "INC-3", fingerprint: "demo-exporter|production|write|error" },
      { ref: "INC-4", fingerprint: "not-a-real-fingerprint" },
    ],
  };
  const index = incidentServiceIndex(board);
  assert.equal(index.get("demo-worker").length, 2);
  assert.equal(index.get("demo-exporter").length, 1);
  assert.equal(index.get("not-a-real-fingerprint"), undefined);
});

test("incidentServiceIndex on a missing or malformed board reads as no incidents, not a crash", () => {
  assert.equal(incidentServiceIndex(null).size, 0);
  assert.equal(incidentServiceIndex({}).size, 0);
});

/* --------------------------------------------------------- CR-AC-03 / C14 markers */

test("serviceNodeOpenIncidents marks only service-class nodes, from the same board read", () => {
  const index = incidentServiceIndex({ incidents: [{ ref: "INC-1", fingerprint: "demo-worker|production|nightly|timeout" }] });
  const service = node("service:demo-worker", "service", "demo-worker");
  const verb = node("verb:demo-worker", "verb", "demo-worker");
  assert.equal(serviceNodeOpenIncidents(service, index).length, 1);
  assert.equal(serviceNodeOpenIncidents(service, index)[0].ref, "INC-1");
  assert.deepEqual(serviceNodeOpenIncidents(verb, index), [], "a verb never carries a service's incident, even with a matching key");
});

test("serviceNodeOpenIncidents with no incident read yet answers empty rather than throwing", () => {
  const service = node("service:demo-worker", "service", "demo-worker");
  assert.deepEqual(serviceNodeOpenIncidents(service, null), []);
});

test("groupHasOpenIncident keeps the alert visible for a collapsed ancestor (CR-AC-03)", () => {
  const index = incidentServiceIndex({ incidents: [{ ref: "INC-1", fingerprint: "demo-worker|production|nightly|timeout" }] });
  const groupWithAlert = [node("service:demo-worker", "service", "demo-worker"), node("service:demo-exporter", "service", "demo-exporter")];
  const groupWithout = [node("service:demo-exporter", "service", "demo-exporter")];
  assert.equal(groupHasOpenIncident(groupWithAlert, index), true);
  assert.equal(groupHasOpenIncident(groupWithout, index), false);
});

test("the join and no-read sentences are frozen prose, not invented per call", () => {
  assert.match(INCIDENT_JOIN_SENTENCE, /fingerprint/);
  assert.match(NO_INCIDENT_READ_SENTENCE, /not been read/);
});

/* ------------------------------------------------------- recorded trace (CR-AC-07) */

test("incidentTraceRows paints get-incident's real trace rows, unknown fields named unknown", () => {
  const rows = incidentTraceRows([
    { correlation_id: "c1", kind: "deployment", ref: "DEP-1", state: "succeeded", environment: "production", service_key: "demo-worker", occurred_at: "2026-09-16T00:00:00.000Z", freshness_state: "fresh" },
    { kind: "work_request" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ref, "DEP-1");
  assert.equal(rows[0].service_key, "demo-worker");
  assert.equal(rows[1].ref, "unknown");
  assert.equal(rows[1].state, "unknown");
  assert.equal(rows[1].service_key, null);
});

test("incidentTraceRows drops a row with no kind rather than painting a blank step", () => {
  assert.deepEqual(incidentTraceRows([{ ref: "x" }, null, "not an object"]), []);
});

test("incidentTraceRows on a missing trace is an empty list, and the no-trace sentence exists", () => {
  assert.deepEqual(incidentTraceRows(undefined), []);
  assert.match(NO_INCIDENT_TRACE_SENTENCE, /no correlated step/);
  assert.equal(INCIDENT_TRACE_HEADING, "Recorded steps for this incident");
});

/* -------------------------------------------------- CR-AC-05 / C31's honest gap */

test("the causal failure-propagation graph is named as a gap, not silently omitted or faked", () => {
  assert.match(CAUSAL_GRAPH_GAP_SENTENCE, /does not read a per-component failure map/);
  assert.match(CAUSAL_GRAPH_GAP_SENTENCE, /investigation-neighborhood/);
});

/* --------------------------------------------------------------------- Doc tour */

test("buildDocTour on an empty page returns no steps", () => {
  assert.deepEqual(buildDocTour({ nodes: [], edges: [] }), []);
  assert.deepEqual(buildDocTour(null), []);
});

test("buildDocTour only ever points at a node that is really on this page", () => {
  const payload = {
    nodes: [
      node("service:demo-worker", "service", "demo-worker"),
      node("rule:demo-rule", "rule", "demo-rule"),
      node("verb:demo-verb", "verb", "demo-verb"),
      node("surface:demo-surface", "surface", "demo-surface", { unlinked: true }),
    ],
    edges: [],
  };
  const index = incidentServiceIndex({ incidents: [{ ref: "INC-1", fingerprint: "demo-worker|production|nightly|timeout" }] });
  const steps = buildDocTour(payload, index);
  const ids = new Set(payload.nodes.map((n) => n.id));
  assert.ok(steps.length > 0);
  for (const step of steps) assert.ok(ids.has(step.id), `step ${step.id} must be a real node on this page`);
});

test("buildDocTour skips a category with no real example on this page, rather than inventing one", () => {
  const payload = { nodes: [node("verb:demo-verb", "verb", "demo-verb")], edges: [] };
  const steps = buildDocTour(payload, null);
  assert.ok(steps.every((step) => step.kind !== "incident"), "no incident example exists on this page");
  assert.ok(steps.some((step) => step.kind === "gap" && step.narration.includes(VERB_RUN_GAP_SENTENCE)));
});

test("buildDocTour cites the enforcement gap for a rule with no enforced_by edge", () => {
  const payload = { nodes: [node("rule:demo-rule", "rule", "demo-rule")], edges: [] };
  const steps = buildDocTour(payload, null);
  const step = steps.find((entry) => entry.id === "rule:demo-rule");
  assert.ok(step.narration.includes(NO_ENFORCEMENT_SENTENCE));
});

test("buildDocTour does not flag a rule that IS enforced on this page", () => {
  const payload = {
    nodes: [node("rule:demo-rule", "rule", "demo-rule"), node("control:demo-control", "control", "demo-control")],
    edges: [{ from: "rule:demo-rule", to: "control:demo-control", type: "enforced_by", evidence: "installed", source_ref: "demo", observed_at: null }],
  };
  const steps = buildDocTour(payload, null);
  assert.ok(!steps.some((entry) => entry.id === "rule:demo-rule"), "an enforced rule is not the gap example");
});

test("buildDocTour cites the unlinked sentence for an unlinked node on this page", () => {
  const payload = { nodes: [node("surface:demo-surface", "surface", "demo-surface", { unlinked: true })], edges: [] };
  const steps = buildDocTour(payload, null);
  const step = steps.find((entry) => entry.id === "surface:demo-surface");
  assert.ok(step.narration.includes(UNLINKED_SENTENCE));
});

test("buildDocTour cites RUN_HEADING for a node that really carries an observation", () => {
  const payload = {
    nodes: [node("service:demo-worker", "service", "demo-worker", { observed_at: "2026-09-16T00:00:00.000Z", observed_status: "succeeded", observed_source_ref: "ops.run" })],
    edges: [],
  };
  const steps = buildDocTour(payload, null);
  const step = steps.find((entry) => entry.id === "service:demo-worker");
  assert.ok(step.narration.toLowerCase().includes(RUN_HEADING.toLowerCase()));
});

test("buildDocTour is deterministic: the same payload always yields the same steps in the same order", () => {
  const payload = {
    nodes: [
      node("verb:demo-verb", "verb", "demo-verb"),
      node("rule:demo-rule", "rule", "demo-rule"),
      node("surface:demo-surface", "surface", "demo-surface", { unlinked: true }),
    ],
    edges: [],
  };
  assert.deepEqual(buildDocTour(payload, null), buildDocTour(payload, null));
});

test("DOC_TOUR_EMPTY exists for the page a tour truly has nothing to say about", () => {
  assert.equal(typeof DOC_TOUR_EMPTY, "string");
  assert.ok(DOC_TOUR_EMPTY.length > 0);
});

/* --------------------------------------------------- the fixture, end to end */

test("the fixture's incident-board fingerprints really resolve to atlas service keys used elsewhere in the fixtures", async () => {
  const client = await fixture();
  const board = await client.incidentBoard({ state: "open" });
  const keys = board.incidents.map((row) => serviceKeyFromIncidentFingerprint(row.fingerprint));
  assert.ok(keys.every((key) => key !== null), "every demo incident carries a real four-part fingerprint");
  assert.ok(keys.includes("demo-worker") && keys.includes("demo-exporter"), "both demo services are exercised");
});

test("get-incident's fixture now carries the real services and trace shapes (not fabricated by this file)", async () => {
  const client = await fixture();
  const detail = await client.getIncident({ ref: "INC-20260915-01" });
  assert.ok(Array.isArray(detail.services) && detail.services.length > 0);
  assert.equal(detail.services[0].key, "demo-exporter");
  const rows = incidentTraceRows(detail.trace);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => typeof row.kind === "string" && row.kind.length > 0));
});

/* ------------------------------------------------------------ atlas.js wiring */

test("atlas.js reuses the incident-board read handed in, and never re-fetches it itself", () => {
  assert.match(atlasJs, /getIncidentsRead/, "atlas.js reads the incidents board through the handed-in getter");
  assert.doesNotMatch(atlasJs, /\.incidentBoard\(/, "atlas.js must not call incidentBoard itself — control-room.js already does");
});

test("atlas.js's incident trace read is lazy, on a button click, never eager on selection", () => {
  assert.match(atlasJs, /data-atlas-trace/);
  assert.match(atlasJs, /async function readTrace/);
  assert.match(atlasJs, /recordClient\.getIncident/);
});

test("atlas.js writes nothing: the same guard the C07/C08 suite already checks, re-verified for the C09 additions", () => {
  for (const write of ["closeIncident", "adjudicateIncident", "openIncident", "linkIncidentWorkRequest"]) {
    assert.ok(!atlasJs.includes(write), `the Atlas tab must not ${write}`);
  }
  assert.doesNotMatch(atlasJs, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/, "the Atlas tab writes");
});

test("control-room.js hands atlas.js its OWN incident-board read and client, not a second construction", () => {
  assert.match(controlRoomJs, /getIncidentsRead:\s*\(\)\s*=>\s*view\.reads\.incidents/);
  assert.match(controlRoomJs, /mountAtlas\(\{[^}]*client[^}]*\}\)/s);
});

test("every element id atlas.js's C09 additions look up by getElementById exists in control-room.html", () => {
  const ids = [...atlasJs.matchAll(/\$\("([a-zA-Z0-9]+)"\)/g)].map((match) => match[1]);
  const c09Ids = ids.filter((id) => /^atlas(HowThisWorksNote|Tour)/.test(id));
  assert.ok(c09Ids.length > 0, "no C09 id was actually looked up");
  for (const id of new Set(c09Ids)) {
    assert.ok(html.includes(`id="${id}"`), `control-room.html is missing #${id}`);
  }
});

test("the Doc tour panel is reachable by keyboard-ordinary buttons, not a bespoke control", () => {
  assert.match(html, /id="atlasTourStart"[^>]*>Start Doc's tour/);
  assert.match(html, /id="atlasTourNext"/);
  assert.match(html, /id="atlasTourPrev"/);
  assert.match(html, /id="atlasTourExit"/);
});

/* ------------------------------------------------------------- the scope block */

test("no verb this slice would need for a real causal failure graph is pinned as if it answered that question", () => {
  assert.ok(!contract.mcp_operations.includes("investigation-neighborhood"), "investigation-neighborhood answers a different subsystem's question");
  assert.ok(!contract.mcp_operations.includes("get-investigation"));
  assert.ok(!contract.mcp_operations.includes("next-signals"));
  assert.ok(contract.mcp_operations.includes("incident-board"));
  assert.ok(contract.mcp_operations.includes("get-incident"));
});

test("notInReleaseBlocks narrows the C09 statement to exactly what is still missing, not the whole slice", () => {
  const block = notInReleaseBlocks().find((entry) => entry.id === "atlas_causal_failure_graph_and_planned_layer");
  assert.ok(block, "the narrowed C09 scope statement is missing");
  assert.match(block.reason, /incident markers, a recorded incident trace and an optional Doc tour are live/);
  assert.match(block.reason, /per-component failure\/health map/);
  assert.match(block.reason, /planned-vs-operating overlay/);
});

/* ---------------------------------------------------------------- motion pass */
// Joe's standing surface rule (9293d609): every CARR surface ships with real
// motion, honours prefers-reduced-motion with a static fallback that keeps
// everything visible and legible, and never lets motion delay reading or
// clicking. These tests follow the repo's existing reduced-motion pattern
// (see test/queue-panel-model.test.mjs, test/visual-system.test.mjs): grep
// the shipped CSS rather than execute it, because the floor these animations
// rely on is a real, already-tested global rule.

const css = await read("css/control-room.css");
const systemCss = await read("css/system.css");

test("the open-incident badge pulses for real, and the collapsed-ancestor alert pops on arrival", () => {
  assert.match(atlasJs, /data-atlas-alert="group"/, "the collapsed-group marker is distinguishable from the per-node chip");
  assert.match(css, /\.chip\[data-atlas-chip="incident"\] \{ animation: breathe var\(--motion-urgent\)/);
  assert.match(css, /\.chip\[data-atlas-chip="incident"\]\[data-atlas-alert="group"\] \{[\s\S]{0,120}animation: receipt-in var\(--motion-enter\)/);
});

test("the recorded-steps trace drawer enters in sequence and its connector draws", () => {
  assert.match(css, /@keyframes atlas-connector-draw/);
  assert.match(css, /\.atlas-trace \.work-list::before \{[\s\S]{0,200}animation: atlas-connector-draw var\(--motion-move\)/);
  assert.match(css, /\.atlas-trace \.work-list li \{ animation: receipt-in var\(--motion-enter\)/);
  // A real stagger, not every row arriving at once.
  assert.match(css, /\.atlas-trace \.work-list li:nth-child\(2\) \{ animation-delay: 70ms; \}/);
  assert.match(css, /\.atlas-trace \.work-list li:nth-child\(3\) \{ animation-delay: 140ms; \}/);
});

test("the Doc tour's step change animates the focus move, and nothing here touches the camera", () => {
  assert.match(css, /\.atlas-identity \{ animation: receipt-in var\(--motion-enter\)/);
  // "No camera hijack": neither the tour's advance/retreat nor selectNode
  // ever calls scrollIntoView or sets scrollTop/scrollLeft.
  assert.doesNotMatch(atlasJs, /scrollIntoView|scrollTop\s*=|scrollLeft\s*=/);
});

test("prefers-reduced-motion leaves every C09 motion addition fully visible with a static fallback", () => {
  // system.css's universal floor (already covered by test/visual-system.test.mjs)
  // is what actually disables these — this test just proves the new rules live
  // inside its reach, and that none of them makes a state depend on `display`.
  assert.match(systemCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  for (const selector of [
    '.chip[data-atlas-chip="incident"]',
    '.chip[data-atlas-chip="incident"][data-atlas-alert="group"]',
    '.atlas-trace .work-list::before',
    '.atlas-trace .work-list li',
    '.atlas-identity',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`${escaped} \\{([^}]*)\\}`);
    const match = css.match(rule);
    assert.ok(match, `${selector} rule not found`);
    assert.doesNotMatch(match[1], /display:\s*none|visibility:\s*hidden/, `${selector} must not hide content as part of its animated state`);
  }
});
