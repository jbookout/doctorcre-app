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
import {
  ATLAS_LAYERS, ATLAS_LIMIT_DEFAULT, ATLAS_STATE_COPY, EXPOSURE_STATEMENT, INCOMPLETE_HEADING,
  LAYER_LABEL, NO_ENFORCEMENT_SENTENCE, NO_RUN_HEADING, NO_SUCCESSOR_SENTENCE, NO_TEST_EVIDENCE_SENTENCE,
  PAGE_SCOPE_SENTENCE, RUN_HEADING, UNLINKED_SENTENCE, VERB_RUN_GAP_SENTENCE,
  atlasPhase, atlasRequestPath, classifyAtlasFailure, coverageGroups, coverageOrbFor, groupIndex,
  mergeNodePages, pagingState, selectionFor, validAtlasPayload, NO_OBSERVED_CLOCK, NO_OBSERVED_STATUS } from "./atlas-model.js";
import { escapeHtml } from "./control-room.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);

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
};

let mounted = false;
let debounce = null;

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

function nodeRow(node) {
  const chips = [
    chip("layer", node.layer),
    chip("evidence", node.evidence),
    chip("status", node.status ?? "unstated"),
    node.unlinked ? chip("unlinked", "on this page") : "",
    node.retired_at ? chip("retired", formatClock(node.retired_at) || node.retired_at) : "",
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
  root.innerHTML = groupIndex(view.payload).map((group) => `
    <details class="atlas-layer" open>
      <summary><span class="eyebrow">Layer</span> ${escapeHtml(group.label)}</summary>
      ${group.classes.map((entry) => `
        <details class="atlas-class" open>
          <summary><span class="eyebrow">${escapeHtml(entry.class)}</span> ${escapeHtml(entry.label)} · ${entry.nodes.length} on this page</summary>
          ${entry.nodes.length === 0
            ? `<p class="small">This class returned no node on this page.</p>`
            : `<ul class="work-list">${entry.nodes.map(nodeRow).join("")}</ul>`}
        </details>`).join("")}
    </details>`).join("");
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
    <h4>Relationships</h4>
    <p class="small">${escapeHtml(PAGE_SCOPE_SENTENCE)}</p>
    ${selection.out.length + selection.in.length === 0
      ? `<p class="small">No relationship to a node on this page is recorded.</p>`
      : `<ul class="work-list">${selection.out.map((edge) => edgeRow(edge, "points at")).join("")}${selection.in.map((edge) => edgeRow(edge, "pointed at by")).join("")}</ul>`}`;
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

function render() {
  renderState();
  renderVersion();
  renderCoverage();
  renderControls();
  renderIndex();
  renderPaging();
  renderSelection();
}

/* ------------------------------------------------------------------ selection */

function selectNode(id, { push = true } = {}) {
  view.selected = id || null;
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

/* ---------------------------------------------------------------------- mount */

/**
 * Mounted on FIRST selection of the Atlas tab, never on page boot: the Control
 * Room's four existing reads must not wait behind this one.
 */
export function mountAtlas({ outage = null, node = null } = {}) {
  if (mounted) return;
  mounted = true;
  view.outage = outage;
  const exposure = $("atlasExposure");
  if (exposure) exposure.textContent = EXPOSURE_STATEMENT;
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
  if (node) view.selected = node;
  read().then(() => { if (node) selectNode(node, { push: false }); });
}

export { view };
