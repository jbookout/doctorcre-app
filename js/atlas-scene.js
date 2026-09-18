// V5-UX-C08 — the Anatomical Atlas renderer, prototype seat.
//
// Mounted on the Control Room prototype page (/design/operations) over the
// EMBEDDED fixture graph in js/atlas-demo-graph.js. It performs no request of
// any kind: the live read belongs to the shipped index (V5-UX-C07), and a
// prototype that quietly called it would be certifying a route rather than a
// picture.
//
// It consumes the C07 contract rather than re-deriving it: `selectionFor` for
// every selection, `coverageGroups`/`atlasDegraded` for the coverage block, and
// the frozen sentences for every statement about what this page does not know.
// Geometry and naming come from js/atlas-anatomy.js, which is pure.

import {
  INCOMPLETE_HEADING, NO_OBSERVED_CLOCK, NO_OBSERVED_STATUS, NO_RUN_HEADING,
  NO_SUCCESSOR_SENTENCE, PAGE_SCOPE_SENTENCE, RUN_HEADING, UNLINKED_SENTENCE,
  VERB_RUN_GAP_SENTENCE, atlasDegraded, coverageGroups, coverageOrbFor, selectionFor,
} from "./atlas-model.js";
import {
  BREAKPOINT_SENTENCE, EVIDENCE_DEPTH, MOTION_LIVE_SENTENCE, MOTION_PAUSED_SENTENCE,
  NOT_WHOLE_SENTENCE, ROTATION_DEFAULT, ROTATION_HELP_SENTENCE, ROTATION_STEP,
  STABLE_LAYOUT_SENTENCE, anatomyScene, breadcrumbsFor, clampRotation, nodeSpeech, organFor,
  profileFor, singularLabel,
} from "./atlas-anatomy.js";
import { formatCalendarDate, formatClock } from "./visual-system.js";

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

const svgEl = (tag, attrs = {}, text = null) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== null) node.textContent = text;
  return node;
};

/** Titles are long and plates are small; the full text always survives in the
 *  accessible name, in the <title> and in the flat list, never only in the plate. */
function clip(text, limit) {
  const value = String(text || "");
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** One clock formatter for the whole page: the shared system's, never a second one. */
function stampOrNull(value) {
  const date = formatCalendarDate(value);
  const clock = formatClock(value);
  return date && clock ? `${date} · ${clock}` : null;
}

/* ---------------------------------------------------------------- the glyphs */

/** The category glyph, drawn as geometry so the layer survives with no colour. */
function organGlyph(shape, x, y, size) {
  const half = size / 2;
  if (shape === "circle") return svgEl("circle", { class: "atlas-glyph", cx: x, cy: y, r: half });
  if (shape === "diamond") return svgEl("polygon", { class: "atlas-glyph", points: `${x},${y - half} ${x + half},${y} ${x},${y + half} ${x - half},${y}` });
  if (shape === "tab") return svgEl("path", { class: "atlas-glyph", d: `M${x - half} ${y - half} H${x + half} V${y + half * 0.2} Q${x + half} ${y + half} ${x} ${y + half} Q${x - half} ${y + half} ${x - half} ${y + half * 0.2} Z` });
  return svgEl("rect", { class: "atlas-glyph", x: x - half, y: y - half, width: size, height: size, rx: 2 });
}

/* ------------------------------------------------------------------ the scene */

export function mountAtlasScene(payload, { announce = () => {} } = {}) {
  const svg = $("atlasSvg");
  if (!svg || !payload) return null;

  const state = {
    rotation: ROTATION_DEFAULT,
    view: "assembled",
    layer: "all",
    includeRetired: false,
    selectedId: null,
    trail: [],
  };

  const hidden = (entry) => entry.marks.retired && !state.includeRetired;

  /* ------------------------------------------------------------ the drawing */

  function drawScene(scene) {
    const profile = scene.profile;
    svg.replaceChildren();
    svg.setAttribute("viewBox", scene.viewBox);
    const organLayer = svgEl("g", { class: "atlas-organs" });
    for (const organ of scene.organs) {
      const visible = organ.members.filter((entry) => !hidden(entry));
      if (visible.length === 0) continue;
      const top = Math.min(...visible.map((entry) => entry.screen.y));
      const bottom = Math.max(...visible.map((entry) => entry.screen.y));
      organLayer.append(svgEl("rect", {
        class: "atlas-organ", "data-cat": organ.key, "data-dimmed": state.layer !== "all" && state.layer !== organ.key,
        x: 14, y: top - profile.nodeHeight * 1.5, width: profile.width - 28, height: (bottom - top) + profile.nodeHeight * 2.4, rx: 22,
      }));
      organLayer.append(svgEl("text", {
        class: "atlas-organ-label", "data-cat": organ.key, x: 28, y: top - profile.nodeHeight * 1.5 + 17,
      }, `${organ.label.toUpperCase()} · ${organ.organ}`));
    }
    svg.append(organLayer);

    const edgeLayer = svgEl("g", { class: "atlas-edges" });
    for (const link of scene.edges) {
      if (hidden(link.from) || hidden(link.to)) continue;
      const a = link.from.screen;
      const b = link.to.screen;
      const related = state.selectedId === link.edge.from || state.selectedId === link.edge.to;
      const path = svgEl("path", {
        class: "atlas-edge",
        "data-evidence": link.edge.evidence,
        "data-dimmed": link.dimmed,
        "data-related": related,
        d: `M${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`,
      });
      path.append(svgEl("title", {}, `${link.from.node.title || link.from.node.key} ${link.edge.type.replace(/_/g, " ")} ${link.to.node.title || link.to.node.key} (${link.edge.evidence})`));
      edgeLayer.append(path);
    }
    svg.append(edgeLayer);

    // Painter's order: far planes first, so the front plane genuinely occludes.
    const nodeLayer = svgEl("g", { class: "atlas-nodes" });
    for (const entry of scene.painted) {
      if (hidden(entry)) continue;
      const { node, screen, evidence, marks } = entry;
      const width = profile.nodeWidth * screen.scale;
      const height = profile.nodeHeight * screen.scale;
      const group = svgEl("g", {
        class: "atlas-node",
        "data-cat": entry.organ,
        "data-evidence": node.evidence,
        "data-outline": evidence.outline,
        "data-retired": marks.retired,
        "data-unlinked": marks.unlinked,
        "data-dimmed": entry.dimmed,
        "data-id": node.id,
        tabindex: "0",
        role: "button",
        "aria-current": String(node.id === state.selectedId),
        "aria-label": nodeSpeech(entry),
        transform: `translate(${screen.x} ${screen.y})`,
      });
      group.append(svgEl("title", {}, nodeSpeech(entry)));
      group.append(svgEl("rect", { class: "atlas-plate", x: -width / 2, y: -height / 2, width, height, rx: 10 * screen.scale }));
      group.append(organGlyph(organFor(entry.organ)?.shape || "square", -width / 2 + 12 * screen.scale, 0, 11 * screen.scale));
      group.append(svgEl("text", { class: "atlas-plate-label", x: -width / 2 + 24 * screen.scale, y: 1 * screen.scale }, clip(node.title || node.key, profile.titleChars)));
      group.append(svgEl("text", { class: "atlas-plate-sub", x: -width / 2 + 24 * screen.scale, y: 13 * screen.scale }, `${singularLabel(node.class)} · ${evidence.word}`));
      // Observed is the only plane with a living core, and the core is a SHAPE
      // before it is a motion: with motion paused it stays a filled dot.
      if (evidence.core) group.append(svgEl("circle", { class: "atlas-core", cx: width / 2 - 10 * screen.scale, cy: 0, r: 4 * screen.scale }));
      if (marks.unlinked) group.append(svgEl("path", { class: "atlas-tether", d: `M${width / 2} ${0} h ${16 * screen.scale}` }));
      if (marks.retired) group.append(svgEl("path", { class: "atlas-strike", d: `M${-width / 2} ${height / 2} L ${width / 2} ${-height / 2}` }));
      nodeLayer.append(group);
    }
    svg.append(nodeLayer);
  }

  /* -------------------------------------------------------------- the panels */

  function renderCrumbs(scene) {
    const crumbs = $("atlasCrumbs");
    if (!crumbs) return;
    const trail = breadcrumbsFor(scene, state.selectedId);
    crumbs.replaceChildren(...trail.flatMap((crumb, index) => {
      const last = index === trail.length - 1;
      const item = last
        ? el("span", { class: "crumb", "aria-current": "page", text: crumb.label })
        : el("button", { class: "crumb", type: "button", "data-crumb": crumb.key, text: crumb.label });
      return index === 0 ? [item] : [el("span", { class: "crumb-sep", "aria-hidden": "true", text: "›" }), item];
    }));
  }

  function renderEvidenceLegend() {
    const list = $("atlasEvidenceLegend");
    if (!list) return;
    list.replaceChildren(...Object.entries(EVIDENCE_DEPTH).map(([key, depth]) => el("li", {}, [
      el("span", { class: "evidence-swatch", "data-evidence": key, "aria-hidden": "true" }),
      document.createTextNode(` ${depth.plane}${depth.core ? " · filled core" : ""} · ${depth.outline} outline`),
    ])));
  }

  function renderIndex(scene) {
    const list = $("atlasIndex");
    if (!list) return;
    // The producer's order, unsorted and unfiltered except for the retired
    // toggle the reader set themselves.
    list.replaceChildren(...scene.nodes.filter((entry) => !hidden(entry)).map((entry) => el("li", {}, [
      el("button", {
        class: "btn btn-quiet atlas-index-row", type: "button", "data-focus": entry.node.id,
        "aria-current": entry.node.id === state.selectedId ? "true" : null,
      }, [
        el("span", { class: "swatch", "data-cat": entry.organ, "aria-hidden": "true" }),
        el("span", { class: "atlas-index-name", text: entry.node.title || entry.node.key }),
        el("small", { text: `${singularLabel(entry.node.class)} · ${entry.evidence.word}${entry.marks.retired ? " · retired" : ""}${entry.marks.unlinked ? " · unlinked" : ""}` }),
      ]),
    ])));
  }

  function renderSelection() {
    const drawer = $("componentDrawer");
    if (!drawer) return;
    if (!state.selectedId) {
      drawer.hidden = true;
      return;
    }
    const selection = selectionFor(payload, state.selectedId);
    if (!selection) {
      drawer.hidden = true;
      return;
    }
    const { node, observed } = selection;
    drawer.hidden = false;
    $("componentTitle").textContent = node.title || node.key;
    const rows = [
      ["Identity", node.id],
      ["Kind", `${singularLabel(node.class)} · ${node.key}`],
      ["Evidence", `${EVIDENCE_DEPTH[node.evidence]?.plane || node.evidence}. Read from ${node.source_ref}.`],
      ["Status", node.status || "no status recorded"],
    ];
    if (node.retired_at) {
      rows.push(["Retired", stampOrNull(node.retired_at) || node.retired_at]);
      rows.push(["Successor", NO_SUCCESSOR_SENTENCE]);
    }
    if (node.unlinked) rows.push(["Relationships", UNLINKED_SENTENCE]);
    const body = [el("dl", { class: "detail-list" }, rows.flatMap(([term, detail]) => [el("dt", { text: term }), el("dd", { text: detail })]))];

    const relations = [
      ...selection.out.map((edge) => [edge, "out"]),
      ...selection.in.map((edge) => [edge, "in"]),
    ];
    body.push(el("h3", { class: "eyebrow", text: `Relationships on this page (${relations.length})` }));
    body.push(relations.length === 0
      ? el("p", { class: "small", text: UNLINKED_SENTENCE })
      : el("ul", { class: "rule-list" }, relations.map(([edge, direction]) => {
        const other = direction === "out" ? edge.to : edge.from;
        const otherNode = payload.nodes.find((candidate) => candidate.id === other);
        return el("li", { text: `${direction === "out" ? "→" : "←"} ${edge.type.replace(/_/g, " ")} · ${otherNode?.title || other} · ${edge.evidence}` });
      })));
    // Page scope is never left implied.
    body.push(el("p", { class: "small", text: PAGE_SCOPE_SENTENCE }));

    body.push(el("h3", { class: "eyebrow", text: observed ? RUN_HEADING : NO_RUN_HEADING }));
    if (observed) {
      body.push(el("dl", { class: "detail-list" }, [
        el("dt", { text: "Observed" }), el("dd", { text: stampOrNull(observed.observed_at) || NO_OBSERVED_CLOCK }),
        el("dt", { text: "Outcome" }), el("dd", { text: observed.observed_status || NO_OBSERVED_STATUS }),
        el("dt", { text: "From" }), el("dd", { text: observed.observed_source_ref }),
      ]));
    } else if (node.class === "verb") {
      body.push(el("p", { class: "small", text: VERB_RUN_GAP_SENTENCE }));
    } else {
      body.push(el("p", { class: "small", text: "This release reads no run for this component. That is a silence in the sources, not a report of nothing happening." }));
    }
    $("componentBody").replaceChildren(...body);
  }

  function renderCoverage() {
    const groups = coverageGroups(payload.coverage);
    const degraded = atlasDegraded(payload);
    const title = $("atlasCoverageTitle");
    if (title) title.textContent = degraded ? INCOMPLETE_HEADING : "Coverage";
    const explanation = $("atlasSafeExplanation");
    // Printed verbatim. The page never paraphrases the producer's own account of
    // what it could not read.
    if (explanation) explanation.textContent = payload.source.safe_explanation;
    const row = (entry) => el("li", { class: "coverage-row" }, [
      el("span", { class: "orb", "data-state": coverageOrbFor(entry) === "healthy" ? "healthy" : coverageOrbFor(entry) === "attention" ? "attention" : "urgent", "aria-hidden": "true" }),
      el("b", { text: entry.source_ref }),
      el("span", { text: `${entry.evidence_class} · ${entry.node_count} nodes · ${entry.edge_count} relationships` }),
      el("small", { text: entry.complete ? "complete" : `incomplete: ${entry.missing_reason}` }),
    ]);
    $("atlasCoverageAnswered")?.replaceChildren(...groups.answered.map(row));
    $("atlasCoverageGaps")?.replaceChildren(...groups.gaps.map(row));
    $("atlasLimits")?.replaceChildren(
      el("li", { text: NOT_WHOLE_SENTENCE }),
      el("li", { text: NO_SUCCESSOR_SENTENCE }),
      el("li", { text: VERB_RUN_GAP_SENTENCE }),
      el("li", { text: PAGE_SCOPE_SENTENCE }),
    );
  }

  function renderNotes() {
    const stable = $("atlasStableNote");
    if (stable) stable.textContent = `${STABLE_LAYOUT_SENTENCE} ${ROTATION_HELP_SENTENCE} ${BREAKPOINT_SENTENCE}`;
    const motion = $("atlasMotionNote");
    if (motion) {
      const paused = document.documentElement.dataset.motion === "reduced" ||
        (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      motion.textContent = paused ? MOTION_PAUSED_SENTENCE : MOTION_LIVE_SENTENCE;
    }
  }

  /* --------------------------------------------------------------- the render */

  function render() {
    const scene = anatomyScene(payload, {
      rotation: state.rotation, exploded: state.view === "exploded", layer: state.layer,
      profile: profileFor(window.innerWidth),
    });
    const atlas = $("atlas");
    if (atlas) {
      atlas.dataset.view = state.view;
      if (state.layer === "all") atlas.removeAttribute("data-layer"); else atlas.dataset.layer = state.layer;
    }
    if (state.view === "flat") svg.replaceChildren(); else drawScene(scene);
    svg.toggleAttribute("hidden", state.view === "flat");
    renderCrumbs(scene);
    renderEvidenceLegend();
    renderIndex(scene);
    renderSelection();
    renderCoverage();
    renderNotes();
    const rotate = $("atlasRotateValue");
    if (rotate) rotate.textContent = `${state.rotation}°`;
    const slider = $("atlasRotate");
    if (slider && Number(slider.value) !== state.rotation) slider.value = String(state.rotation);
    $("atlasBack")?.toggleAttribute("disabled", state.selectedId === null && state.trail.length === 0);
    return scene;
  }

  /* ---------------------------------------------------------------- the moves */

  function select(id, { push = true, speak = true } = {}) {
    if (push && state.selectedId && state.selectedId !== id) state.trail.push(state.selectedId);
    state.selectedId = id;
    const scene = render();
    if (!speak) return;
    const entry = scene.nodes.find((candidate) => candidate.node.id === id);
    if (entry) announce(`Selected ${nodeSpeech(entry)}.`);
  }

  function returnToWhole() {
    state.selectedId = null;
    state.trail = [];
    render();
    announce("Returned to the whole system. Nothing moved; the selection was cleared.");
  }

  function setRotation(value) {
    state.rotation = clampRotation(value);
    render();
    announce(`Camera at ${state.rotation} degrees. Components did not move.`);
  }

  function setView(view) {
    state.view = view;
    $("atlasViewSwitch")?.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    render();
    announce(view === "flat"
      ? "Flat list. The scene is switched off; every component is in the list."
      : `${view === "exploded" ? "Exploded" : "Assembled"} view. Each component kept its organ, its column and its plane.`);
  }

  function setLayer(layer) {
    state.layer = layer;
    $("layerSwitch")?.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layer === layer)));
    render();
    const live = $("layerLive");
    const label = layer === "all" ? "All layers" : organFor(layer)?.label || layer;
    if (live) live.textContent = `Layer: ${label}. Components keep their positions; the others are dimmed, not removed.`;
  }

  /* ----------------------------------------------------------------- wiring */

  svg.addEventListener("click", (event) => {
    const node = event.target.closest(".atlas-node");
    if (node) select(node.dataset.id);
  });
  svg.addEventListener("keydown", (event) => {
    const node = event.target.closest(".atlas-node");
    if (node && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      select(node.dataset.id);
      return;
    }
    // Rotation from the keyboard, on the scene itself: no drag anywhere is
    // required to reach any of it.
    if (event.key === "ArrowLeft") { event.preventDefault(); setRotation(state.rotation - ROTATION_STEP); }
    if (event.key === "ArrowRight") { event.preventDefault(); setRotation(state.rotation + ROTATION_STEP); }
    if (event.key === "Escape" && state.selectedId) { event.preventDefault(); returnToWhole(); }
  });

  // Dragging is an ADDITION. Every value it can reach is reachable from the
  // slider, the two buttons and the arrow keys (WCAG 2.2 dragging movements).
  let dragFrom = null;
  svg.addEventListener("pointerdown", (event) => { dragFrom = { x: event.clientX, rotation: state.rotation }; });
  svg.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    const delta = Math.round((event.clientX - dragFrom.x) / 6 / ROTATION_STEP) * ROTATION_STEP;
    if (delta !== 0) setRotation(dragFrom.rotation + delta);
  });
  const endDrag = () => { dragFrom = null; };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("pointerleave", endDrag);

  $("atlasIndex")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-focus]");
    if (!button) return;
    select(button.dataset.focus);
    document.querySelector(`.atlas-node[data-id="${CSS.escape(button.dataset.focus)}"]`)?.focus();
  });
  $("atlasCrumbs")?.addEventListener("click", (event) => {
    const crumb = event.target.closest("button[data-crumb]");
    if (!crumb) return;
    if (crumb.dataset.crumb === "whole") returnToWhole();
    else if (crumb.dataset.crumb.startsWith("organ:")) setLayer(crumb.dataset.crumb.slice("organ:".length));
  });
  $("atlasBack")?.addEventListener("click", () => {
    const previous = state.trail.pop();
    if (previous) select(previous, { push: false });
    else returnToWhole();
  });
  $("atlasViewSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (button) setView(button.dataset.view);
  });
  $("layerSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-layer]");
    if (button) setLayer(button.dataset.layer);
  });
  $("atlasRotate")?.addEventListener("input", (event) => setRotation(event.target.value));
  $("atlasRotateLeft")?.addEventListener("click", () => setRotation(state.rotation - ROTATION_STEP));
  $("atlasRotateRight")?.addEventListener("click", () => setRotation(state.rotation + ROTATION_STEP));
  $("atlasRetired")?.addEventListener("click", (event) => {
    state.includeRetired = !state.includeRetired;
    event.currentTarget.setAttribute("aria-pressed", String(state.includeRetired));
    if (!state.includeRetired && state.selectedId) {
      const entry = payload.nodes.find((node) => node.id === state.selectedId);
      if (entry?.retired_at) state.selectedId = null;
    }
    render();
    announce(state.includeRetired
      ? "Retired components are shown, struck through and dated. This release records no successor for a retired node."
      : "Retired components are hidden.");
  });

  new MutationObserver(renderNotes).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });

  // The profile follows the viewport, and only the profile: a resize re-renders
  // the same body at a different column count, never a different body.
  let profileKey = profileFor(window.innerWidth).key;
  window.addEventListener("resize", () => {
    const next = profileFor(window.innerWidth).key;
    if (next === profileKey) return;
    profileKey = next;
    render();
  });

  render();
  return { render, select, setView, setLayer, setRotation, state };
}
