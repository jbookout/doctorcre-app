// V5-UX-C08 — the Anatomical Atlas, pure geometry and pure naming.
//
// No DOM, no fetch, no clock. Everything the scene decides is decided here so a
// test can assert it without a browser, exactly as js/atlas-model.js does for
// the index. This module NEVER re-orders or re-filters the producer's list: it
// assigns each node a SLOT, and a slot is derived from the order the producer
// delivered nodes in, never from a sort of its own.
//
// Three commitments this file exists to keep, each one a place a prettier
// renderer would lie:
//
//  1. A COMPONENT NEVER MOVES. A node's slot is computed from the WHOLE payload,
//     so switching a layer, exploding the body or rotating the camera changes
//     what you SEE and never where a thing IS. CR-AC-06 is a geometry promise,
//     not a CSS one.
//  2. COLOUR IS NEVER THE ONLY CHANNEL. Category carries a shape, evidence
//     carries an outline and a depth plane, retired carries a strike and a word,
//     and every one of them is repeated in the flat list as text.
//  3. DEPTH IS EVIDENCE, NOT IMPORTANCE. The back plane is what this system
//     DECLARES, the middle is what is INSTALLED, the front is what has been
//     OBSERVED running. Nothing is placed forward for being interesting.

import { ATLAS_LAYERS, NODE_CLASS_LABEL, NODE_CLASS_ORDER } from "./atlas-model.js";

/* ------------------------------------------------------------------ the organs */

/**
 * The twelve node classes onto Joe's four layers (decision C30), and the four
 * layers onto four organs of one body (decisions C13 and C29). Every class the
 * producer emits has exactly one organ; a class that is not listed here is
 * placed in `unplaced` rather than dropped, because a node the renderer cannot
 * site is a fact about this release, not a node that does not exist.
 */
export const ORGAN_OF_CLASS = Object.freeze({
  surface: "data", doctrine_section: "data",
  verb: "execution", mutation: "execution", module: "execution", workflow: "execution",
  rule: "rules", rule_pack: "rules", control: "rules",
  service: "infra", service_environment: "infra", job_definition: "infra",
});

/**
 * Organ order is top to bottom and is FIXED. It reads as a body: what the system
 * shows the world, the spine that carries a call, the nerves that decide whether
 * it may happen, and the muscle it runs on.
 */
export const ORGANS = Object.freeze([
  Object.freeze({ key: "data", label: "Data", organ: "Senses", blurb: "What this system exposes and what it holds written down.", shape: "circle" }),
  Object.freeze({ key: "execution", label: "Execution", organ: "Spine", blurb: "The path a command travels from the outside to the code that carries it out.", shape: "square" }),
  Object.freeze({ key: "rules", label: "Rules", organ: "Nervous system", blurb: "What is allowed, what enforces it, and the doctrine it is written from.", shape: "diamond" }),
  Object.freeze({ key: "infra", label: "Infrastructure", organ: "Muscle and bone", blurb: "The machines, environments and schedules the work actually runs on.", shape: "tab" }),
]);

export const ORGAN_KEYS = Object.freeze(ORGANS.map((organ) => organ.key));
export const UNPLACED = "unplaced";

export function organOf(node) {
  return ORGAN_OF_CLASS[node?.class] || UNPLACED;
}

/* ------------------------------------------------ evidence read without colour */

/**
 * The depth plane, and the two non-colour marks that repeat it. `declared` sits
 * at the back with a dashed outline, `installed` in the middle with a solid one,
 * `observed` at the front with a solid outline AND a filled core. The `word` is
 * printed in the flat list and spoken in every accessible name, so the whole
 * distinction survives with the scene switched off.
 */
export const EVIDENCE_DEPTH = Object.freeze({
  declared: Object.freeze({ z: -1, outline: "dashed", core: false, word: "declared", plane: "Back plane · declared" }),
  installed: Object.freeze({ z: 0, outline: "solid", core: false, word: "installed", plane: "Middle plane · installed" }),
  observed: Object.freeze({ z: 1, outline: "solid", core: true, word: "observed", plane: "Front plane · observed running" }),
});

export function evidenceDepth(evidence) {
  return EVIDENCE_DEPTH[evidence] || EVIDENCE_DEPTH.declared;
}

/** Retired and unlinked are MARKS, never a removal and never a pitying word. */
export function nodeMarks(node) {
  return Object.freeze({
    retired: typeof node?.retired_at === "string" && node.retired_at !== "",
    unlinked: node?.unlinked === true,
  });
}

/* -------------------------------------------------------------------- geometry */

/**
 * TWO PROFILES, and only two, because a six-column body at 360 px is a picture
 * of a body rather than a body you can read. The profile changes the COLUMN
 * COUNT and the frame; it does not change what an organ is, what a plane means
 * or which organ a component belongs to. Within a profile nothing ever moves,
 * which is the promise CR-AC-06 actually makes; crossing the breakpoint is the
 * one announced exception and it is stated on the page.
 */
export const SCENE_WIDE = Object.freeze({
  key: "wide",
  width: 1040, centreX: 520,
  height: 520, centreY: 255,
  heightExploded: 740, centreYExploded: 355,
  columns: 6, columnGap: 152, rowGap: 38,
  organGapAssembled: 104, organGapExploded: 168,
  depthAssembled: 46, depthExploded: 104,
  focal: 1400,
  nodeWidth: 134, nodeHeight: 42, titleChars: 14,
});

export const SCENE_NARROW = Object.freeze({
  key: "narrow",
  width: 540, centreX: 270,
  height: 1120, centreY: 500,
  heightExploded: 1420, centreYExploded: 690,
  columns: 2, columnGap: 240, rowGap: 62,
  organGapAssembled: 232, organGapExploded: 312,
  depthAssembled: 26, depthExploded: 64,
  focal: 1400,
  nodeWidth: 214, nodeHeight: 56, titleChars: 24,
});

/** The wide profile is the default and the one the tests pin. */
export const SCENE = SCENE_WIDE;

/** One breakpoint, the same 768 px the stylesheet uses. */
export const NARROW_BREAKPOINT = 768;

export function profileFor(viewportWidth) {
  return Number(viewportWidth) > 0 && Number(viewportWidth) < NARROW_BREAKPOINT ? SCENE_NARROW : SCENE_WIDE;
}

export const BREAKPOINT_SENTENCE =
  "On a phone the body stands in two columns instead of six so every label stays readable. That is the only thing that re-sites a component, it happens at one width, and nothing about an organ, a plane or a relationship changes with it.";

export const ROTATION_MIN = -60;
export const ROTATION_MAX = 60;
export const ROTATION_DEFAULT = -18;
export const ROTATION_STEP = 15;

export function clampRotation(value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) return ROTATION_DEFAULT;
  return Math.min(ROTATION_MAX, Math.max(ROTATION_MIN, Math.round(angle)));
}

/**
 * Slots. Nodes are walked in the producer's delivered order and handed the next
 * free slot in their organ; the walk covers the WHOLE payload, including nodes a
 * layer filter is about to dim, so a filter cannot shuffle the body.
 */
export function assignSlots(nodes) {
  const counters = new Map();
  const slots = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node.id !== "string") continue;
    const organ = organOf(node);
    const next = counters.get(organ) || 0;
    counters.set(organ, next + 1);
    slots.set(node.id, next);
  }
  return slots;
}

/** World coordinates: x across the organ, y the organ's own band, z the evidence plane. */
export function worldPositionFor(node, slot, exploded, profile = SCENE) {
  const organ = organOf(node);
  const row = ORGAN_KEYS.indexOf(organ);
  const bandIndex = row === -1 ? ORGAN_KEYS.length : row;
  const organGap = exploded ? profile.organGapExploded : profile.organGapAssembled;
  const column = slot % profile.columns;
  const stack = Math.floor(slot / profile.columns);
  const x = (column - (profile.columns - 1) / 2) * profile.columnGap;
  const y = (bandIndex - (ORGAN_KEYS.length - 1) / 2) * organGap + stack * profile.rowGap;
  const z = evidenceDepth(node?.evidence).z * (exploded ? profile.depthExploded : profile.depthAssembled);
  return { x, y, z, organ, column, stack };
}

/**
 * One rotation about the body's vertical axis, then one perspective divide. The
 * camera is the only thing that moves; every world position above is unchanged
 * by the angle, which is what makes "the components did not move" checkable
 * rather than a claim.
 */
export function project({ x, y, z }, rotationDegrees, profile = SCENE, centreY = null) {
  const angle = (clampRotation(rotationDegrees) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx = x * cos - z * sin;
  const rz = x * sin + z * cos;
  const scale = profile.focal / (profile.focal - rz);
  return {
    x: profile.centreX + rx * scale,
    y: (centreY === null ? profile.centreY : centreY) + y * scale,
    scale: Math.round(scale * 1000) / 1000,
    depth: rz,
  };
}

/**
 * The whole scene, ready to paint. Painter's order: far first, so a node in
 * front genuinely occludes the one behind it and depth is a thing you can see
 * rather than a thing the legend asserts.
 */
export function anatomyScene(payload, { rotation = ROTATION_DEFAULT, exploded = false, layer = "all", profile = SCENE } = {}) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const slots = assignSlots(nodes);
  const centreY = exploded ? profile.centreYExploded : profile.centreY;
  const placed = nodes.map((node) => {
    const world = worldPositionFor(node, slots.get(node.id) ?? 0, exploded, profile);
    const screen = project(world, rotation, profile, centreY);
    const organ = world.organ;
    return Object.freeze({
      node, organ, world, screen,
      slot: slots.get(node.id) ?? 0,
      evidence: evidenceDepth(node.evidence),
      marks: nodeMarks(node),
      // Dimmed, never removed and never re-sited: a layer is a reading of the
      // same body, not a different body.
      dimmed: layer !== "all" && organ !== layer,
    });
  });
  const byId = new Map(placed.map((entry) => [entry.node.id, entry]));
  const edges = (Array.isArray(payload?.edges) ? payload.edges : [])
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return null;
      return Object.freeze({ edge, from, to, dimmed: from.dimmed && to.dimmed });
    })
    .filter(Boolean);
  const painted = [...placed].sort((left, right) => left.screen.depth - right.screen.depth);
  return Object.freeze({
    rotation: clampRotation(rotation), exploded, layer, profile,
    viewBox: `0 0 ${profile.width} ${exploded ? profile.heightExploded : profile.height}`,
    nodes: Object.freeze(placed), painted: Object.freeze(painted), edges: Object.freeze(edges),
    organs: Object.freeze(ORGANS.map((organ) => Object.freeze({
      ...organ,
      members: Object.freeze(placed.filter((entry) => entry.organ === organ.key)),
    }))),
    unplaced: Object.freeze(placed.filter((entry) => entry.organ === UNPLACED)),
  });
}

/* ---------------------------------------------------------------------- naming */

export function classLabel(name) {
  return NODE_CLASS_LABEL[name] || name;
}

/** The singular, because a node is one of them and "Verbs: add a loop" reads wrong. */
export const CLASS_SINGULAR = Object.freeze({
  verb: "Verb", mutation: "Mutation", module: "Module", surface: "Surface",
  service: "Service", service_environment: "Service environment", job_definition: "Job definition",
  rule: "Rule", rule_pack: "Rule pack", control: "Control", doctrine_section: "Doctrine section",
  workflow: "Workflow",
});

export function singularLabel(name) {
  return CLASS_SINGULAR[name] || classLabel(name);
}

export function organFor(key) {
  return ORGANS.find((organ) => organ.key === key) || null;
}

/**
 * The accessible name, and the one place the non-colour channels are guaranteed
 * to be spoken. Every fact the shape carries is repeated in these words.
 */
export function nodeSpeech(entry) {
  const { node, evidence, marks, organ } = entry;
  const parts = [
    node.title || node.key,
    singularLabel(node.class),
    organFor(organ) ? `${organFor(organ).label} layer` : "not placed in a layer",
    evidence.plane,
  ];
  if (node.status) parts.push(`status ${node.status}`);
  if (marks.retired) parts.push("retired");
  if (marks.unlinked) parts.push("nothing on this page points at it");
  return parts.join(", ");
}

/* ------------------------------------------------------------ views and motion */

export const VIEWS = Object.freeze([
  Object.freeze({ key: "assembled", label: "Assembled", hint: "The whole body, organs interlocked." }),
  Object.freeze({ key: "exploded", label: "Exploded", hint: "The same body pulled apart along its evidence planes. Nothing moves to a new organ." }),
  Object.freeze({ key: "flat", label: "Flat list", hint: "Every component as text, with no scene at all." }),
]);

export const MOTION_PAUSED_SENTENCE =
  "Motion is paused. Nothing on this page is moving, and every state above is readable from its shape, its outline and its words alone.";

export const MOTION_LIVE_SENTENCE =
  "Observed components breathe and observed relationships drift, slowly, to show the body is switched on. Pause it with the motion control in the header.";

export const STABLE_LAYOUT_SENTENCE =
  "Rotating, exploding and switching layers move the CAMERA and the emphasis. No component changes organ, column or plane.";

export const NOT_WHOLE_SENTENCE =
  "This body is drawn from one page of an incomplete atlas. What is not drawn is not thereby absent.";

export const ROTATION_HELP_SENTENCE =
  "Rotate with the slider, the two rotate buttons, or the left and right arrow keys while the scene has focus. Dragging is offered as well and is never required.";

/* ------------------------------------------------------------------ breadcrumbs */

/** Whole system → organ → component. "Return to whole system" is always the head. */
export function breadcrumbsFor(scene, selectedId) {
  const trail = [{ key: "whole", label: "Whole system" }];
  const entry = selectedId ? scene.nodes.find((candidate) => candidate.node.id === selectedId) : null;
  if (!entry) return trail;
  const organ = organFor(entry.organ);
  trail.push({ key: `organ:${entry.organ}`, label: organ ? `${organ.label} · ${organ.organ}` : "Not placed in a layer" });
  trail.push({ key: `node:${entry.node.id}`, label: entry.node.title || entry.node.key });
  return trail;
}
