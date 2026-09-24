// V5-UX-C07 — the Atlas tab: DOM wiring only.
//
// Every decision about a payload lives in ./atlas-model.js. This file reads,
// paints, and does nothing else. It writes nothing: there is no write verb on
// this surface and none is added.
//
// Three standing rules this file obeys and a reviewer should check:
//
//  1. NOTHING IS RE-SORTED OR RE-FILTERED HERE. The graph arrives sorted by id;
//     `q`, `layer` and `include_retired` are SERVER filters and each costs a
//     fresh read. Neither a re-sort nor a re-filter of the producer's list
//     appears below, and the test greps for both.
//  2. `escapeHtml` is IMPORTED from ./control-room.js rather than copied. One
//     escaper per page, not an Nth copy that can drift from the others.
//  3. The cursor is opaque: it is handed back exactly as it arrived and is
//     never parsed, decoded or split.
//
// V5-UX-C08b adds a fourth rule: the anatomical renderer (js/atlas-scene.js)
// is an ADDED VIEW over the exact payload this file already reads through
// `validAtlasPayload`. It never reads, filters or requests anything of its
// own; it is mounted and updated from here, with its own element ids so it
// cannot collide with the index this file already owns.
import {
  ATLAS_LAYERS, ATLAS_LIMIT_DEFAULT, ATLAS_SCENE_EMPTY_SENTENCE, ATLAS_SCENE_TOO_LARGE_SENTENCE, ATLAS_STATE_COPY,
  EXPOSURE_STATEMENT, INCOMPLETE_HEADING, LAYER_LABEL, NO_ENFORCEMENT_SENTENCE, NO_RUN_HEADING, NO_SUCCESSOR_SENTENCE,
  NO_TEST_EVIDENCE_SENTENCE, PAGE_SCOPE_SENTENCE, RUN_HEADING, UNLINKED_SENTENCE, VERB_RUN_GAP_SENTENCE,
  atlasPhase, atlasRequestPath, atlasSceneAvailability, classifyAtlasFailure, coverageGroups, coverageOrbFor, groupIndex,
  mergeNodePages, pagingState, selectionFor, validAtlasPayload, NO_OBSERVED_CLOCK, NO_OBSERVED_STATUS,
  // V5-UX-C09 — incidents, recorded trace and the Doc tour.
  CAUSAL_GRAPH_GAP_SENTENCE, DOC_TOUR_EMPTY, DOC_TOUR_END, DOC_TOUR_INTRO, HOW_THIS_WORKS_VS_RUN_SENTENCE,
  INCIDENT_JOIN_SENTENCE, INCIDENT_TRACE_HEADING,
  NO_INCIDENT_READ_SENTENCE, NO_INCIDENT_TRACE_SENTENCE, TRACE_NOT_COMMAND_FLOW_SENTENCE,
  buildDocTour, groupHasOpenIncident, incidentServiceIndex, incidentTraceRows, serviceNodeOpenIncidents,
} from "./atlas-model.js";
import { canonicalHref, validIncidentBoardPayload } from "./control-room-model.js";
import { escapeHtml } from "./control-room.js";
import { formatClock } from "./visual-system.js";
import { mountAtlasScene } from "./atlas-scene.js";

const $ = (id) => document.getElementById(id);

/**
 * The renderer's element ids in the LIVE Control Room markup. The index above
 * already owns the bare ids (atlasIndex, atlasSafeExplanation, atlasRetired,
 * …), so every id the renderer needs here is its own, scoped under "Scene".
 */
const SCENE_IDS = Object.freeze({
  root: "atlasSceneAtlas", svg: "atlasSceneSvg", crumbs: "atlasSceneCrumbs", evidenceLegend: "atlasSceneEvidenceLegend",
  index: "atlasSceneIndex", componentDrawer: "atlasSceneComponentDrawer", componentTitle: "atlasSceneComponentTitle",
  componentBody: "atlasSceneComponentBody", coverageTitle: "atlasSceneCoverageTitle", safeExplanation: "atlasSceneSafeExplanation",
  coverageAnswered: "atlasSceneCoverageAnswered", coverageGaps: "atlasSceneCoverageGaps", limits: "atlasSceneLimits",
  stableNote: "atlasSceneStableNote", motionNote: "atlasSceneMotionNote", rotateValue: "atlasSceneRotateValue",
  rotate: "atlasSceneRotate", back: "atlasSceneBack", viewSwitch: "atlasSceneViewSwitch", layerSwitch: "atlasSceneLayerSwitch",
  retiredToggle: "atlasSceneRetired", layerLive: "atlasSceneLayerLive", rotateLeft: "atlasSceneRotateLeft", rotateRight: "atlasSceneRotateRight",
});

/** One place holds what this tab believes; nothing else keeps a copy. */
const view = {
  status: "idle",
  sequence: 0,
  layer: null,
  q: "",
  includeRetired: false,
  payload: null,
  selected: null,
  outage: null,
  // "index" is the accessible primary surface; "anatomical" is the added,
  // toggled view. Neither persists past this page's life.
  rendererView: "index",
  // The incident trace drawer for the currently selected service node: at
  // most one open incident's `get-incident` read, fetched lazily on request
  // and never on a plain node selection.
  trace: { ref: null, state: "idle", payload: null },
  // The Doc tour: a scripted sequence of the SAME selections a click would
  // make. `active` false means ordinary browsing; a selection made outside
  // `advance`/`retreat` while active marks the tour "diverged" so it stops
  // claiming to be at a scripted step without losing the user's own move.
  tour: { active: false, steps: [], index: -1, diverged: false, before: null },
};

let mounted = false;
let debounce = null;
let scene = null;
let scenePayload = null;
// V5-UX-C09: the same record-layer client control-room.js already built, used
// ONLY to lazily read one incident's trace on request. No second incidentBoard
// call is ever made from here — that read is handed in, not re-fetched.
let recordClient = null;
// A GETTER, not a snapshot: control-room.js's incidents read settles
// asynchronously after boot and REPLACES its own `view.reads.incidents`
// object rather than mutating it, so a value captured once at mount time
// could go stale. Reading it live, on every render, means the badge appears
// the moment the dashboard's own read lands — the exact "same dashboard
// records" this binds to (C14) — with no second incident-board request.
let getIncidentsRead = () => null;

const requestOptions = (cursor = null) => ({
  layer: view.layer, q: view.q, includeRetired: view.includeRetired, limit: ATLAS_LIMIT_DEFAULT, cursor,
});

/* -------------------------------------------------------------------- reading */

async function read(cursor = null) {
  view.sequence += 1;
  const sequence = view.sequence;
  view.status = "loading";
  // A read in flight leaves no stale list on screen: the previous page is not
  // "current" and must not be read as if it were.
  if (cursor === null) { view.payload = null; view.selected = null; }
  render();
  const path = atlasRequestPath(requestOptions(cursor));
  // The fixture's outage switch travels as a fixture-only key. The printed
  // request line above is the PRODUCTION request and never carries it.
  const url = view.outage ? `${path}${path.includes("?") ? "&" : "?"}outage=${encodeURIComponent(view.outage)}` : path;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (sequence !== view.sequence) return;
    if (!response.ok) {
      view.status = classifyAtlasFailure(response.status);
      view.payload = null;
      render();
      return;
    }
    const incoming = await response.json();
    if (sequence !== view.sequence) return;
    if (!validAtlasPayload(incoming)) {
      // A payload this page cannot render honestly is an outage, not a graph.
      view.status = "offline";
      view.payload = null;
      render();
      return;
    }
    view.status = "ready";
    view.payload = cursor === null ? incoming : appendPage(view.payload, incoming);
    render();
  } catch {
    if (sequence !== view.sequence) return;
    view.status = "offline";
    view.payload = null;
    render();
  }
}

/**
 * Page append. The newest page's version, coverage and paging are authoritative;
 * its nodes, edges and index are ADDED to what is already read, in the order the
 * producer delivered them. Nothing is reordered and nothing is dropped.
 */
function appendPage(previous, incoming) {
  if (!previous) return incoming;
  const seen = new Set();
  const edges = [];
  for (const edge of [...previous.edges, ...incoming.edges]) {
    const key = `${edge.from}|${edge.to}|${edge.type}|${edge.source_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  const index = {};
  for (const source of [previous.index, incoming.index]) {
    for (const [layer, classes] of Object.entries(source)) {
      index[layer] = index[layer] || {};
      for (const [name, ids] of Object.entries(classes)) {
        const already = new Set(index[layer][name] || []);
        const merged = [...(index[layer][name] || [])];
        for (const id of ids) if (!already.has(id)) { already.add(id); merged.push(id); }
        index[layer][name] = merged;
      }
    }
  }
  return { ...incoming, nodes: mergeNodePages(previous.nodes, incoming.nodes), edges, index };
}

/* ------------------------------------------------------------------- painting */

const chip = (label, value) => `<span class="chip" data-atlas-chip="${escapeHtml(label)}"><span class="chip-label">${escapeHtml(label)}</span>${escapeHtml(value)}</span>`;

function renderVersion() {
  const line = $("atlasVersionLine");
  if (!line) return;
  const payload = view.payload;
  if (!payload) { line.innerHTML = `<span class="small">No version has been read.</span>`; return; }
  // The digest says what this system DECLARES it has; the clock says when that
  // was read. They are separate facts and the labels keep them separate.
  line.innerHTML = [
    `<span class="atlas-fact"><span class="chip-label">What this system declares</span><span class="mono">${escapeHtml(payload.version.registry_version)} · ${escapeHtml(payload.version.bundle_digest.slice(0, 12))}</span></span>`,
    `<span class="atlas-fact"><span class="chip-label">When this was read</span><span>${escapeHtml(formatClock(payload.observed_at) || payload.observed_at)}</span></span>`,
    `<span class="atlas-fact"><span class="chip-label">Freshness</span><span>${escapeHtml(payload.source.freshness)}</span></span>`,
  ].join("");
}

function coverageRow(entry) {
  const orb = coverageOrbFor(entry);
  const reason = entry.missing_reason === null ? "no shortfall is recorded" : entry.missing_reason;
  return `<li class="work-item" data-coverage="${escapeHtml(entry.evidence_class)}" data-complete="${entry.complete}">
    <div>
      <h3 class="mono">${escapeHtml(entry.source_ref)}</h3>
      <div class="work-meta">
        ${chip("evidence", entry.evidence_class)}
        <span><b>${escapeHtml(entry.node_count)}</b> nodes</span>
        <span><b>${escapeHtml(entry.edge_count)}</b> relationships</span>
        <span>${escapeHtml(reason)}</span>
      </div>
    </div>
    <span class="status" data-state="${escapeHtml(orb)}"><span class="orb" data-state="${escapeHtml(orb)}" aria-hidden="true"></span> ${escapeHtml(entry.complete ? "answered" : "incomplete")}</span>
  </li>`;
}

function renderCoverage() {
  const payload = view.payload;
  const explanation = $("atlasSafeExplanation");
  const answered = $("atlasCoverageAnswered");
  const gaps = $("atlasCoverageGaps");
  const heading = $("atlasCoverageHeading");
  if (!answered || !gaps) return;
  if (!payload) {
    if (explanation) explanation.textContent = "";
    answered.innerHTML = "";
    gaps.innerHTML = "";
    if (heading) heading.textContent = "Coverage";
    return;
  }
  const phase = atlasPhase({ status: view.status, payload });
  if (heading) heading.textContent = phase === "partial" ? INCOMPLETE_HEADING : "Coverage";
  // The producer's own sentence, verbatim, above the list on every render.
  if (explanation) explanation.textContent = payload.source.safe_explanation;
  const groups = coverageGroups(payload.coverage);
  answered.innerHTML = groups.answered.map(coverageRow).join("");
  gaps.innerHTML = groups.gaps.map(coverageRow).join("");
}

function renderControls() {
  const path = $("atlasRequestPath");
  if (path) path.textContent = `Request: ${atlasRequestPath(requestOptions())}`;
  for (const button of document.querySelectorAll("#atlasLayerFilters button[data-layer]")) {
    const value = button.dataset.layer === "all" ? null : button.dataset.layer;
    button.setAttribute("aria-pressed", String(value === view.layer));
  }
  const retired = $("atlasRetired");
  if (retired) retired.checked = view.includeRetired;
}

/** V5-UX-C09: the SAME incident-board read handed in by control-room.js, read
 * live and indexed once per render rather than scanned per node. `null` when
 * nothing has been read yet, or the read is still pending or failed — the
 * honest "not read" state, never an empty match. */
function incidentIndex() {
  const read = getIncidentsRead();
  const payload = read?.state === "read" && validIncidentBoardPayload(read.payload) ? read.payload : null;
  return payload ? incidentServiceIndex(payload) : null;
}

/** Whether the incident-board read handed in by control-room.js has settled,
 * regardless of whether it found anything. Distinguishes "not read yet" from
 * "read, and nothing on this page carries an open incident". */
function incidentsAvailable() {
  const read = getIncidentsRead();
  return read?.state === "read" && validIncidentBoardPayload(read.payload);
}

function incidentChip(node, index) {
  const incidents = serviceNodeOpenIncidents(node, index);
  if (incidents.length === 0) return "";
  const label = incidents.length === 1 ? incidents[0].ref : `${incidents.length} open incidents`;
  return `<span class="chip" data-atlas-chip="incident" data-state="urgent"><span class="chip-label">open incident</span>${escapeHtml(label)}</span>`;
}

function nodeRow(node, index) {
  const chips = [
    chip("layer", node.layer),
    chip("evidence", node.evidence),
    chip("status", node.status ?? "unstated"),
    node.unlinked ? chip("unlinked", "on this page") : "",
    node.retired_at ? chip("retired", formatClock(node.retired_at) || node.retired_at) : "",
    incidentChip(node, index),
  ].join("");
  return `<li class="work-item atlas-node" data-node="${escapeHtml(node.id)}" data-selected="${node.id === view.selected}">
    <div>
      <h3>${escapeHtml(node.key)}</h3>
      <div class="work-meta"><span>${escapeHtml(node.title ?? "untitled")}</span><span class="mono">${escapeHtml(node.source_ref)}</span></div>
      <div class="chip-bar">${chips}</div>
    </div>
    <div class="stack-end"><button class="btn" type="button" data-atlas-select="${escapeHtml(node.id)}">Select</button></div>
  </li>`;
}

function renderIndex() {
  const root = $("atlasIndex");
  if (!root) return;
  if (!view.payload) { root.innerHTML = ""; return; }
  const index = incidentIndex();
  // CR-AC-03: "collapsed ancestors retain alert visibility." A <details> the
  // reader has collapsed must still show that something inside it carries an
  // open incident, so the alert marker is printed on every <summary>, not
  // only on the leaf row.
  const alertMark = (nodes) => (groupHasOpenIncident(nodes, index) ? ` <span class="chip" data-atlas-chip="incident" data-state="urgent">open incident inside</span>` : "");
  root.innerHTML = groupIndex(view.payload).map((group) => {
    const groupNodes = group.classes.flatMap((entry) => entry.nodes);
    return `
    <details class="atlas-layer" open>
      <summary><span class="eyebrow">Layer</span> ${escapeHtml(group.label)}${alertMark(groupNodes)}</summary>
      ${group.classes.map((entry) => `
        <details class="atlas-class" open>
          <summary><span class="eyebrow">${escapeHtml(entry.class)}</span> ${escapeHtml(entry.label)} · ${entry.nodes.length} on this page${alertMark(entry.nodes)}</summary>
          ${entry.nodes.length === 0
            ? `<p class="small">This class returned no node on this page.</p>`
            : `<ul class="work-list">${entry.nodes.map((node) => nodeRow(node, index)).join("")}</ul>`}
        </details>`).join("")}
    </details>`;
  }).join("");
  for (const button of root.querySelectorAll("button[data-atlas-select]")) {
    button.addEventListener("click", () => selectNode(button.dataset.atlasSelect));
  }
}

function renderPaging() {
  const more = $("atlasMore");
  const line = $("atlasPagingLine");
  const paging = pagingState(view.payload);
  if (more) more.hidden = !paging.more;
  if (line) line.textContent = paging.line || "";
}

function edgeRow(edge, direction) {
  return `<li class="work-item" data-edge="${escapeHtml(edge.type)}">
    <div>
      <h3>${escapeHtml(edge.type)}</h3>
      <div class="work-meta">
        <span>${escapeHtml(direction)}</span>
        <span class="mono">${escapeHtml(direction === "points at" ? edge.to : edge.from)}</span>
        ${chip("evidence", edge.evidence)}
        <span class="mono">${escapeHtml(edge.source_ref)}</span>
        <span>${escapeHtml(edge.observed_at ? `observed ${formatClock(edge.observed_at) || edge.observed_at}` : "no observation recorded")}</span>
      </div>
    </div>
  </li>`;
}

/** V5-UX-C09: the incident section of the selection drawer. Only a `service`
 * node can carry one, per the real `ops.incident_service` join this app can
 * actually read — see INCIDENT_JOIN_SENTENCE. */
function incidentSection(node) {
  if (node.class !== "service") return "";
  if (!incidentsAvailable()) return `<p class="small">${escapeHtml(NO_INCIDENT_READ_SENTENCE)}</p>`;
  const incidents = serviceNodeOpenIncidents(node, incidentIndex());
  if (incidents.length === 0) return `<p class="small">No open incident names this service on the same incident-board read the dashboard holds.</p>`;
  const rows = incidents.map((row) => {
    const href = canonicalHref(row);
    return `<li class="work-item" data-incident="${escapeHtml(row.ref)}">
      <div><h3 class="mono">${escapeHtml(row.ref)}</h3><div class="work-meta"><span>${escapeHtml(row.severity || "unknown severity")}</span><span>${escapeHtml(row.state || "unknown state")}</span></div></div>
      <div class="stack-end">
        ${href ? `<a class="btn" href="${escapeHtml(href)}">Open ${escapeHtml(row.ref)}</a>` : ""}
        <button class="btn" type="button" data-atlas-trace="${escapeHtml(row.ref)}">${view.trace.ref === row.ref && view.trace.state !== "idle" ? "Hide trace" : "Trace this incident"}</button>
      </div>
    </li>`;
  }).join("");
  return `<h4>Open incidents</h4><p class="small">${escapeHtml(INCIDENT_JOIN_SENTENCE)}</p><ul class="work-list">${rows}</ul>${traceDrawer()}`;
}

/** The recorded, correlated trace for whichever incident the reader asked to
 * trace. Fetched lazily (see readTrace) and rendered from get-incident's REAL
 * `trace` rows — never a second incident-board read, never a fabricated step. */
function traceDrawer() {
  if (!view.trace.ref || view.trace.state === "idle") return "";
  if (view.trace.state === "loading") return `<div class="state-block" data-state="loading"><h4>${escapeHtml(INCIDENT_TRACE_HEADING)}</h4><p>Reading ${escapeHtml(view.trace.ref)}…</p></div>`;
  if (view.trace.state === "unknown") return `<div class="state-block" data-state="urgent"><h4>${escapeHtml(INCIDENT_TRACE_HEADING)}</h4><p>${escapeHtml(view.trace.ref)} could not be read. Nothing here has been inferred.</p></div>`;
  const rows = incidentTraceRows(view.trace.payload?.trace);
  return `
    <div class="atlas-trace">
      <h4>${escapeHtml(INCIDENT_TRACE_HEADING)}</h4>
      <p class="small">${escapeHtml(TRACE_NOT_COMMAND_FLOW_SENTENCE)}</p>
      ${rows.length === 0
        ? `<p class="small">${escapeHtml(NO_INCIDENT_TRACE_SENTENCE)}</p>`
        : `<ul class="work-list">${rows.map((row) => `<li class="work-item" data-trace-kind="${escapeHtml(row.kind)}">
            <div><h3>${escapeHtml(row.kind)} · ${escapeHtml(row.ref)}</h3>
            <div class="work-meta"><span>${escapeHtml(row.state)}</span><span>${escapeHtml(row.environment)}</span>${row.service_key ? `<span class="mono">${escapeHtml(row.service_key)}</span>` : ""}<span>${escapeHtml(row.occurred_at ? (formatClock(row.occurred_at) || row.occurred_at) : "no clock recorded")}</span></div></div>
          </li>`).join("")}</ul>`}
    </div>`;
}

/** Lazy, on-request only: no node selection eagerly reads get-incident. */
async function readTrace(ref) {
  if (view.trace.ref === ref && view.trace.state !== "idle") {
    // Toggling the same incident closed again is a local state change, not a
    // fresh read: the drawer hides without re-hitting the record layer.
    view.trace = { ref: null, state: "idle", payload: null };
    render();
    return;
  }
  view.trace = { ref, state: "loading", payload: null };
  render();
  if (!recordClient) { view.trace = { ref, state: "unknown", payload: null }; render(); return; }
  try {
    const payload = await recordClient.getIncident({ ref, fact_limit: 1 });
    if (view.trace.ref !== ref) return; // superseded by a newer request
    view.trace = { ref, state: "ready", payload };
  } catch {
    if (view.trace.ref !== ref) return;
    view.trace = { ref, state: "unknown", payload: null };
  }
  render();
}

function renderSelection() {
  const root = $("atlasSelection");
  if (!root) return;
  const selection = view.selected ? selectionFor(view.payload, view.selected) : null;
  if (!selection) {
    root.innerHTML = `<p class="small">Select a node to see its identity, what is known about it, and its relationships. ${escapeHtml(PAGE_SCOPE_SENTENCE)}</p>`;
    return;
  }
  const node = selection.node;
  const run = selection.observed
    ? `<h4>${escapeHtml(RUN_HEADING)}</h4>
       <div class="work-meta">
         <span>${escapeHtml(selection.observed.observed_status ?? NO_OBSERVED_STATUS)}</span>
         <span>${escapeHtml(selection.observed.observed_at ? (formatClock(selection.observed.observed_at) || selection.observed.observed_at) : NO_OBSERVED_CLOCK)}</span>
         <span class="mono">${escapeHtml(selection.observed.observed_source_ref)}</span>
       </div>`
    : `<h4>${escapeHtml(NO_RUN_HEADING)}</h4>`;
  const verbGap = node.class === "verb" ? `<p class="small">${escapeHtml(VERB_RUN_GAP_SENTENCE)}</p>` : "";
  let ruleNotes = "";
  if (node.class === "rule") {
    let enforced = 0;
    for (const edge of selection.out) if (edge.type === "enforced_by") enforced += 1;
    ruleNotes = `${enforced === 0 ? `<p class="small">${escapeHtml(NO_ENFORCEMENT_SENTENCE)}</p>` : ""}<p class="small">${escapeHtml(NO_TEST_EVIDENCE_SENTENCE)}</p>`;
  }
  root.innerHTML = `
    <div class="atlas-identity">
      <p class="eyebrow">Identity</p>
      <h3 class="mono">${escapeHtml(node.id)}</h3>
      <div class="work-meta"><span>${escapeHtml(node.class)}</span><span>${escapeHtml(node.key)}</span><span>${escapeHtml(node.title ?? "untitled")}</span></div>
    </div>
    <div class="atlas-evidence">
      <div><p class="eyebrow">What this is</p><p>${escapeHtml(node.layer)}</p></div>
      <div><p class="eyebrow">The strongest thing we know about it</p><p>${escapeHtml(node.evidence)}</p></div>
      <div><p class="eyebrow">Source</p><p class="mono">${escapeHtml(node.source_ref)}</p></div>
    </div>
    <div class="atlas-run">${run}${verbGap}</div>
    ${ruleNotes}
    ${node.unlinked ? `<p class="small">${escapeHtml(UNLINKED_SENTENCE)}</p>` : ""}
    ${node.retired_at ? `<p class="small">Retired ${escapeHtml(formatClock(node.retired_at) || node.retired_at)} · status ${escapeHtml(node.status ?? "unstated")}. ${escapeHtml(NO_SUCCESSOR_SENTENCE)}</p>` : ""}
    <div class="atlas-incidents">${incidentSection(node)}${node.class === "service" && serviceNodeOpenIncidents(node, incidentIndex()).length > 0 ? `<p class="small">${escapeHtml(CAUSAL_GRAPH_GAP_SENTENCE)}</p>` : ""}</div>
    <h4>Relationships</h4>
    <p class="small">${escapeHtml(PAGE_SCOPE_SENTENCE)}</p>
    ${selection.out.length + selection.in.length === 0
      ? `<p class="small">No relationship to a node on this page is recorded.</p>`
      : `<ul class="work-list">${selection.out.map((edge) => edgeRow(edge, "points at")).join("")}${selection.in.map((edge) => edgeRow(edge, "pointed at by")).join("")}</ul>`}`;
  for (const button of root.querySelectorAll("button[data-atlas-trace]")) {
    button.addEventListener("click", () => readTrace(button.dataset.atlasTrace));
  }
}

function renderState() {
  const block = $("atlasState");
  if (!block) return;
  const phase = atlasPhase({ status: view.status, payload: view.payload });
  const orb = $("atlasOrb");
  if (orb) orb.setAttribute("data-state", phase === "ready" ? "healthy" : phase === "loading" ? "refreshing" : phase === "partial" ? "attention" : phase === "idle" ? "still" : "urgent");
  const retry = $("atlasRetry");
  if (retry) retry.hidden = phase === "loading" || phase === "ready" || phase === "partial" || phase === "empty";
  if (phase === "ready") { block.hidden = true; block.innerHTML = ""; return; }
  block.hidden = false;
  block.setAttribute("data-state", phase);
  if (phase === "partial") {
    // The failure this slice exists to prevent: an incomplete atlas must never
    // read as an empty or a whole one, so the producer's own sentence is the
    // loudest thing here, above the list.
    block.innerHTML = `<h3>${escapeHtml(INCOMPLETE_HEADING)}</h3><p>${escapeHtml(view.payload?.source?.safe_explanation || "")}</p>`;
    return;
  }
  const copy = ATLAS_STATE_COPY[phase] || ATLAS_STATE_COPY.offline;
  block.innerHTML = `<h3>${escapeHtml(copy.title)}</h3><p>${escapeHtml(copy.copy)}</p>`;
}

/**
 * V5-UX-C08b — the anatomical renderer, an added view toggled over the same
 * `view.payload` the index above already reads. The index stays the
 * accessible primary surface: a view the current page cannot honestly draw
 * (empty, or too large — see ATLAS_SCENE_NODE_CAP in atlas-model.js) falls
 * back to it, with a printed reason, rather than ever drawing a fake or a
 * partial body.
 */
function renderRenderer() {
  const switchGroup = $("atlasRendererSwitch");
  const wrap = $("atlasSceneWrap");
  const note = $("atlasRendererNote");
  const indexBlock = $("atlasIndex");
  const pagingRow = $("atlasMore")?.closest(".row-wrap") || null;
  if (!switchGroup || !wrap) return;

  const phase = atlasPhase({ status: view.status, payload: view.payload });
  const dataReady = phase === "ready" || phase === "partial";
  const availability = atlasSceneAvailability(view.payload);
  const usable = dataReady && availability.available;

  // A view the current page can no longer support falls back to the index,
  // silently: no state here is allowed to show a scene it cannot honestly draw.
  if (view.rendererView === "anatomical" && !usable) view.rendererView = "index";

  for (const button of switchGroup.querySelectorAll("button[data-atlas-view]")) {
    const isAnatomical = button.dataset.atlasView === "anatomical";
    button.setAttribute("aria-pressed", String(button.dataset.atlasView === view.rendererView));
    if (isAnatomical) button.disabled = !usable;
  }
  if (note) {
    note.textContent = !dataReady ? ""
      : availability.reason === "too_large" ? ATLAS_SCENE_TOO_LARGE_SENTENCE
      : availability.reason === "empty" ? ATLAS_SCENE_EMPTY_SENTENCE
      : "";
  }

  const showScene = view.rendererView === "anatomical" && usable;
  if (indexBlock) indexBlock.hidden = showScene;
  if (pagingRow) pagingRow.hidden = showScene;
  wrap.hidden = !showScene;
  if (!showScene) return;

  if (!scene) {
    scene = mountAtlasScene(view.payload, {
      ids: SCENE_IDS,
      announce: (message) => { const live = $(SCENE_IDS.layerLive); if (live) live.textContent = message; },
      onSelect: (id) => selectNode(id),
    });
    if (!scene) return; // The svg this needs is not on the page; the index stays primary.
    scenePayload = view.payload;
  } else if (view.payload !== scenePayload) {
    scene.updatePayload(view.payload);
    scenePayload = view.payload;
  }
  // The two selections are the same fact, read from two surfaces: keep the
  // scene's in step with the index's without echoing a second selection back.
  if (scene.state.selectedId !== view.selected) {
    if (view.selected) scene.select(view.selected, { push: false, speak: false, notify: false });
    else scene.returnToWhole({ notify: false });
  }
}

/** V5-UX-C09 — Doc's tour: what to show above/beside the selection drawer. */
function renderTour() {
  const panel = $("atlasTourPanel");
  const start = $("atlasTourStart");
  if (start) start.disabled = !view.payload || (Array.isArray(view.payload.nodes) && view.payload.nodes.length === 0);
  if (!panel) return;
  const tour = view.tour;
  if (!tour.active) {
    panel.hidden = true;
    if (start) start.hidden = false;
    return;
  }
  if (start) start.hidden = true;
  panel.hidden = false;
  const intro = $("atlasTourIntro");
  if (intro) intro.textContent = DOC_TOUR_INTRO;
  const atEnd = tour.steps.length === 0 || tour.index >= tour.steps.length;
  const status = $("atlasTourStatus");
  if (status) status.textContent = tour.steps.length === 0
    ? DOC_TOUR_EMPTY
    : atEnd ? DOC_TOUR_END : `Step ${tour.index + 1} of ${tour.steps.length}`;
  const narration = $("atlasTourNarration");
  if (narration) {
    narration.textContent = atEnd || tour.steps.length === 0 ? "" : tour.diverged
      ? `You moved the selection yourself — this is still where the tour was pointing. ${tour.steps[tour.index].narration}`
      : tour.steps[tour.index].narration;
  }
  $("atlasTourPrev")?.toggleAttribute("disabled", tour.index <= 0);
  $("atlasTourNext")?.toggleAttribute("disabled", atEnd);
  const live = $("atlasTourLive");
  if (live && !atEnd && tour.steps.length > 0) live.textContent = `Doc: ${tour.steps[tour.index].narration}`;
}

function render() {
  renderState();
  renderVersion();
  renderCoverage();
  renderControls();
  renderIndex();
  renderPaging();
  renderSelection();
  renderRenderer();
  renderTour();
}

/* ------------------------------------------------------------------ selection */

function selectNode(id, { push = true } = {}) {
  view.selected = id || null;
  // A fresh selection retires whatever incident trace was open for the
  // PREVIOUS node: the drawer never shows one node's trace under another
  // node's heading.
  view.trace = { ref: null, state: "idle", payload: null };
  // The tour's own steps call this too (see advanceTour/retreatTour). A
  // selection that does not match where the tour currently points is a
  // reader's own move — "branch" — and is marked rather than silently
  // overwritten, so the narration stays honest about what is on screen.
  if (view.tour.active) {
    const current = view.tour.steps[view.tour.index];
    view.tour.diverged = !current || current.id !== id;
  }
  if (push && globalThis.history?.pushState) {
    const url = new URL(globalThis.location.href);
    url.searchParams.set("tab", "atlas");
    if (view.selected) url.searchParams.set("node", view.selected);
    else url.searchParams.delete("node");
    globalThis.history.pushState({ tab: "atlas", node: view.selected }, "", url);
  }
  // The selected id is the only thing this device remembers, and only for the
  // life of this page: nothing here is cached offline.
  render();
}

/* --------------------------------------------------------------- Doc tour (C09) */

/**
 * `before` remembers exactly the selection this tab held before the tour
 * started, so exiting RESTORES it rather than leaving the tour's last stop
 * selected — the "no camera hijack" half of checkable_done's tour bullet, and
 * consistent with C14's "Back restores camera/filter/context".
 */
function startTour() {
  if (view.tour.active) return;
  view.tour = {
    active: true,
    steps: buildDocTour(view.payload, incidentIndex()),
    index: -1,
    diverged: false,
    before: { selected: view.selected },
  };
  advanceTour();
}

function advanceTour() {
  if (!view.tour.active) return;
  if (view.tour.index + 1 >= view.tour.steps.length) {
    view.tour.index = view.tour.steps.length; // past the last step: DOC_TOUR_END
    render();
    return;
  }
  view.tour.index += 1;
  view.tour.diverged = false;
  selectNode(view.tour.steps[view.tour.index].id, { push: false });
}

function retreatTour() {
  if (!view.tour.active || view.tour.index <= 0) return;
  view.tour.index -= 1;
  view.tour.diverged = false;
  selectNode(view.tour.steps[view.tour.index].id, { push: false });
}

function exitTour() {
  if (!view.tour.active) return;
  const before = view.tour.before;
  view.tour = { active: false, steps: [], index: -1, diverged: false, before: null };
  selectNode(before ? before.selected : null, { push: false });
}

/* ---------------------------------------------------------------------- mount */

/**
 * Mounted on FIRST selection of the Atlas tab, never on page boot: the Control
 * Room's four existing reads must not wait behind this one.
 */
export function mountAtlas({ outage = null, node = null, getIncidentsRead: incidentsReader = null, client = null } = {}) {
  if (mounted) return;
  mounted = true;
  view.outage = outage;
  // V5-UX-C09: reuse control-room.js's OWN incident-board read (a getter, so
  // it is read live rather than snapshotted stale — see the module comment
  // above) and its already-built record-layer client, for the lazy per-
  // incident trace read only. Neither performs a request atlas.js did not
  // already have a reason to make.
  if (typeof incidentsReader === "function") getIncidentsRead = incidentsReader;
  recordClient = client;
  const exposure = $("atlasExposure");
  if (exposure) exposure.textContent = EXPOSURE_STATEMENT;
  const howNote = $("atlasHowThisWorksNote");
  if (howNote) howNote.textContent = HOW_THIS_WORKS_VS_RUN_SENTENCE;
  const filters = $("atlasLayerFilters");
  if (filters) {
    filters.innerHTML = [["all", "All"], ...ATLAS_LAYERS.map((layer) => [layer, LAYER_LABEL[layer]])]
      .map(([value, label]) => `<button class="btn" type="button" data-layer="${escapeHtml(value)}" aria-pressed="${value === "all"}">${escapeHtml(label)}</button>`)
      .join("");
    filters.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-layer]");
      if (!button) return;
      view.layer = button.dataset.layer === "all" ? null : button.dataset.layer;
      read();
    });
  }
  const search = $("atlasSearch");
  if (search) {
    search.addEventListener("input", () => {
      // `q` is a SERVER filter: the browser re-reads rather than narrowing what
      // it already holds, so what is on screen is always what CARR returned.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { view.q = search.value; read(); }, 250);
    });
  }
  $("atlasRetired")?.addEventListener("change", (event) => {
    view.includeRetired = event.target.checked === true;
    read();
  });
  $("atlasMore")?.addEventListener("click", () => {
    const paging = pagingState(view.payload);
    if (paging.more) read(paging.cursor);
  });
  $("atlasRetry")?.addEventListener("click", () => read());
  $("atlasRendererSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-atlas-view]");
    if (!button || button.disabled) return;
    view.rendererView = button.dataset.atlasView === "anatomical" ? "anatomical" : "index";
    render();
  });
  $("atlasTourStart")?.addEventListener("click", () => startTour());
  $("atlasTourNext")?.addEventListener("click", () => advanceTour());
  $("atlasTourPrev")?.addEventListener("click", () => retreatTour());
  $("atlasTourExit")?.addEventListener("click", () => exitTour());
  if (node) view.selected = node;
  read().then(() => { if (node) selectNode(node, { push: false }); });
}

export { view };
