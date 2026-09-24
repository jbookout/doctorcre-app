// V5-UX-C08 - the anatomical renderer's checkable behaviours.
//
// Each test names the acceptance text it holds up, because a renderer test that
// cannot say which promise it guards is decoration.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { atlasFixtureResponse } from "../scripts/atlas-fixture.mjs";
import { ATLAS_DEMO_PAYLOAD, DEMO_STAMPS } from "../js/atlas-demo-graph.js";
import { NODE_CLASS_ORDER, selectionFor, validAtlasPayload } from "../js/atlas-model.js";
import {
  EVIDENCE_DEPTH, NARROW_BREAKPOINT, ORGANS, ORGAN_KEYS, ORGAN_OF_CLASS, ROTATION_DEFAULT,
  ROTATION_MAX, ROTATION_MIN, SCENE_NARROW, SCENE_WIDE, anatomyScene, assignSlots, breadcrumbsFor,
  clampRotation, nodeSpeech, organOf, profileFor, project, worldPositionFor,
} from "../js/atlas-anatomy.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const sceneJs = await read("js/atlas-scene.js");
const anatomyJs = await read("js/atlas-anatomy.js");
const prototypeJs = await read("js/design-prototype.js");
const operationsHtml = await read("design-operations.html");
// V5-UX-C08b moved the anatomical renderer's styling from the prototype-only
// stylesheet into the shared one, so the live Control Room Atlas tab can mount
// the same scene: this reads the block where it now lives.
const systemCss = await read("css/system.css");

// The fixture reads query parameters and nothing else; it is handed the
// parameters directly, so no host is named and nothing is ever contacted.
const fixtureQuery = (query) => atlasFixtureResponse({ searchParams: new URLSearchParams(query) });

// ------------------------------------------------------------- C08-1 the payload

test("the embedded payload is the fixture's own body, not a hand-written copy of it", () => {
  const live = fixtureQuery("include_retired=true").body;
  const frozen = structuredClone(ATLAS_DEMO_PAYLOAD);
  // Only the two stamps a clock moves are pinned; everything else must match
  // exactly, so the prototype can never drift friendlier than the route.
  assert.equal(frozen.observed_at, DEMO_STAMPS.observed_at);
  assert.equal(frozen.source.correlation_id, DEMO_STAMPS.correlation_id);
  live.observed_at = DEMO_STAMPS.observed_at;
  live.source.observed_at = DEMO_STAMPS.observed_at;
  live.source.correlation_id = DEMO_STAMPS.correlation_id;
  assert.deepEqual(frozen, live);
  assert.equal(validAtlasPayload(ATLAS_DEMO_PAYLOAD), true, "the embedded payload must satisfy the shipped validator");
});

test("the prototype draws the fixture and never reaches the live route", () => {
  assert.doesNotMatch(sceneJs, /fetch\(|XMLHttpRequest|WebSocket|\/mcp/, "the renderer performs no request");
  assert.doesNotMatch(anatomyJs, /fetch\(|XMLHttpRequest|WebSocket|\/mcp/);
  assert.match(prototypeJs, /ATLAS_DEMO_PAYLOAD/, "the prototype mounts the embedded payload");
});

// ----------------------------------------------- C08-2 CR-AC-04 / C13: no hairball

test("every node class the producer emits has exactly one organ, and no node lands unplaced", () => {
  for (const name of NODE_CLASS_ORDER) {
    assert.ok(ORGAN_OF_CLASS[name], `${name} has no organ`);
    assert.ok(ORGAN_KEYS.includes(ORGAN_OF_CLASS[name]), `${name} is filed under an organ that does not exist`);
  }
  const scene = anatomyScene(ATLAS_DEMO_PAYLOAD, {});
  assert.equal(scene.unplaced.length, 0);
  assert.equal(scene.nodes.length, ATLAS_DEMO_PAYLOAD.nodes.length, "every node is placed, none dropped");
  assert.equal(ORGANS.length, 4);
});

test("a slot follows the producer's delivery order and is never a sort of the renderer's own", () => {
  const slots = assignSlots(ATLAS_DEMO_PAYLOAD.nodes);
  const seen = new Map();
  for (const node of ATLAS_DEMO_PAYLOAD.nodes) {
    const organ = organOf(node);
    const expected = seen.get(organ) || 0;
    assert.equal(slots.get(node.id), expected, `${node.id} was re-ordered`);
    seen.set(organ, expected + 1);
  }
});

// ------------------------------- C08-3 CR-AC-06: switch layers without moving anything

test("rotating, exploding and switching a layer never move a component", () => {
  const base = anatomyScene(ATLAS_DEMO_PAYLOAD, { rotation: ROTATION_DEFAULT, exploded: false, layer: "all" });
  const rotated = anatomyScene(ATLAS_DEMO_PAYLOAD, { rotation: 45, exploded: false, layer: "all" });
  const filtered = anatomyScene(ATLAS_DEMO_PAYLOAD, { rotation: ROTATION_DEFAULT, exploded: false, layer: "rules" });
  const exploded = anatomyScene(ATLAS_DEMO_PAYLOAD, { rotation: ROTATION_DEFAULT, exploded: true, layer: "all" });
  for (const node of ATLAS_DEMO_PAYLOAD.nodes) {
    const find = (scene) => scene.nodes.find((entry) => entry.node.id === node.id);
    const a = find(base);
    for (const other of [rotated, filtered, exploded]) {
      const b = find(other);
      assert.equal(b.organ, a.organ, `${node.id} changed organ`);
      assert.equal(b.slot, a.slot, `${node.id} changed slot`);
      assert.equal(b.world.column, a.world.column, `${node.id} changed column`);
    }
    // A layer filter DIMS. It never removes and never re-sites.
    assert.equal(find(filtered).world.x, a.world.x, `${node.id} moved when a layer was chosen`);
    assert.equal(find(filtered).world.y, a.world.y, `${node.id} moved when a layer was chosen`);
  }
  assert.equal(filtered.nodes.length, base.nodes.length, "a layer filter removes nothing");
  assert.ok(filtered.nodes.some((entry) => entry.dimmed), "a chosen layer dims the others");
  assert.ok(filtered.nodes.every((entry) => entry.organ !== "rules" || !entry.dimmed));
});

test("evidence is readable with no colour at all: a plane, an outline, a core and a word", () => {
  assert.deepEqual(Object.keys(EVIDENCE_DEPTH), ["declared", "installed", "observed"]);
  assert.equal(EVIDENCE_DEPTH.declared.outline, "dashed");
  assert.equal(EVIDENCE_DEPTH.installed.outline, "solid");
  assert.equal(EVIDENCE_DEPTH.observed.core, true);
  const planes = new Set(Object.values(EVIDENCE_DEPTH).map((depth) => depth.z));
  assert.equal(planes.size, 3, "the three classes sit on three distinct planes");
  const scene = anatomyScene(ATLAS_DEMO_PAYLOAD, {});
  for (const entry of scene.nodes) {
    assert.match(nodeSpeech(entry), new RegExp(entry.evidence.word), `${entry.node.id} does not say its evidence`);
  }
  // Every category colour is joined by a shape, and every shape is distinct.
  assert.equal(new Set(ORGANS.map((organ) => organ.shape)).size, 4);
});

// ------------------------------------------ C08-4 CR-AC-09: retired keeps its identity

test("a retired node keeps its identity, is struck rather than dropped, and claims no successor", () => {
  const retired = ATLAS_DEMO_PAYLOAD.nodes.filter((node) => node.retired_at !== null);
  assert.equal(retired.length, 1, "the fixture carries a retired node");
  const scene = anatomyScene(ATLAS_DEMO_PAYLOAD, {});
  const entry = scene.nodes.find((candidate) => candidate.node.id === retired[0].id);
  assert.equal(entry.marks.retired, true);
  assert.match(nodeSpeech(entry), /retired/);
  assert.match(sceneJs, /atlas-strike/, "the retired mark is a strike, not a removal");
  assert.match(sceneJs, /NO_SUCCESSOR_SENTENCE/, "the successor sentence is printed for a retired node");
  // No successor is ever invented anywhere in the renderer.
  assert.doesNotMatch(sceneJs, /successor_id|successorOf|replaced_by/);
  assert.doesNotMatch(anatomyJs, /successor_id|successorOf|replaced_by/);
});

test("an unlinked node is a tether and a sentence, never the word orphan", () => {
  const unlinked = ATLAS_DEMO_PAYLOAD.nodes.filter((node) => node.unlinked === true);
  assert.ok(unlinked.length >= 1, "the fixture carries an unlinked node");
  const scene = anatomyScene(ATLAS_DEMO_PAYLOAD, {});
  assert.equal(scene.nodes.find((entry) => entry.node.id === unlinked[0].id).marks.unlinked, true);
  assert.match(sceneJs, /UNLINKED_SENTENCE/);
  for (const source of [sceneJs, anatomyJs, operationsHtml]) assert.doesNotMatch(source, /orphan/i);
});

// ---------------------------------- C08-5 CR-AC-24: keyboard, no-drag, reduced motion

test("nothing the scene can do requires a drag, a hover or a pointer", () => {
  assert.match(operationsHtml, /type="range" id="atlasRotate"/, "rotation has a slider");
  assert.match(operationsHtml, /id="atlasRotateLeft"/);
  assert.match(operationsHtml, /id="atlasRotateRight"/);
  assert.match(operationsHtml, /id="atlasViewSwitch"[\s\S]*data-view="flat"/, "the flat alternative is a control, not a link only");
  assert.match(sceneJs, /event\.key === "ArrowLeft"/);
  assert.match(sceneJs, /event\.key === "ArrowRight"/);
  assert.match(sceneJs, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(sceneJs, /event\.key === "Escape"/);
  assert.match(operationsHtml, /<svg id="atlasSvg"[^>]*tabindex="0"/, "the scene itself is focusable");
  // Dragging exists as an addition and is named as one.
  assert.match(sceneJs, /Dragging is an ADDITION/);
});

test("every new control clears the touch floor and the scene works at 360 px", () => {
  const block = systemCss.slice(systemCss.indexOf("V5-UX-C08"));
  for (const selector of ["\\.atlas-toolbar \\.btn, \\.atlas-rotate \\.btn", "button\\.crumb", "\\.atlas-index-row", '\\.atlas-rotate input\\[type="range"\\]']) {
    assert.match(block, new RegExp(`${selector}[^}]*min-height: var\\(--touch\\)`), `${selector} is below the touch floor`);
  }
  assert.match(block, /@media \(max-width: 767px\) \{[\s\S]*\.atlas-toolbar \{ display: grid;/, "the toolbar stacks on a phone");
  assert.match(block, /\.atlas-layout > \* \{ min-width: 0; \}/, "nothing in the layout may force a horizontal scroll");
  assert.doesNotMatch(block, /[^-]width:\s*\d{3,}px/, "no fixed wide box in the C08 block");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "the C08 block uses tokens, never a literal colour");
});

test("motion is ambient, redundant and fully stoppable, and the page says which state it is in", () => {
  assert.match(systemCss, /\.atlas-core \{[^}]*animation: breathe var\(--motion-calm\)/);
  assert.match(systemCss, /animation: atlas-drift var\(--motion-flow\)/);
  assert.match(sceneJs, /MOTION_PAUSED_SENTENCE/);
  assert.match(sceneJs, /prefers-reduced-motion: reduce/);
  assert.match(sceneJs, /attributeFilter: \["data-motion"\]/, "the note follows the preference live");
  assert.match(anatomyJs, /MOTION_PAUSED_SENTENCE =\s*\n?\s*"Motion is paused/);
});

// --------------------------------- C08-6 the selection contract and the live limits

test("selection goes through the shipped contract and recomputes nothing", () => {
  assert.match(sceneJs, /selectionFor\(payload, state\.selectedId\)/);
  assert.doesNotMatch(sceneJs, /\.reverse\(/, "the renderer never re-orders the producer's list");
  const selection = selectionFor(ATLAS_DEMO_PAYLOAD, "rule:11111111-1111-4111-8111-111111111111");
  assert.equal(selection.pageScoped, true);
  assert.ok(selection.out.length >= 3);
  assert.match(sceneJs, /PAGE_SCOPE_SENTENCE/, "page scope is printed on every selection");
});

test("the coverage block is drawn from the payload, and an incomplete atlas is never drawn as complete", () => {
  assert.match(sceneJs, /coverageGroups\(payload\.coverage\)/);
  assert.match(sceneJs, /atlasDegraded\(payload\)/);
  assert.match(sceneJs, /INCOMPLETE_HEADING/);
  assert.match(sceneJs, /payload\.source\.safe_explanation/, "the producer's own explanation is printed verbatim");
  for (const source of [sceneJs, anatomyJs, operationsHtml, systemCss]) {
    assert.doesNotMatch(source, /the atlas is complete/i);
  }
  assert.match(anatomyJs, /NOT_WHOLE_SENTENCE/);
});

test("the two live limits carried from C07 are printed, not quietly dropped", () => {
  assert.match(sceneJs, /NO_SUCCESSOR_SENTENCE/);
  assert.match(sceneJs, /VERB_RUN_GAP_SENTENCE/);
});

// --------------------------------------------------- C08-7 camera and breadcrumbs

test("the camera is clamped and the projection is a pure function of the world position", () => {
  assert.equal(clampRotation(999), ROTATION_MAX);
  assert.equal(clampRotation(-999), ROTATION_MIN);
  assert.equal(clampRotation("not a number"), ROTATION_DEFAULT);
  const world = worldPositionFor(ATLAS_DEMO_PAYLOAD.nodes[0], 0, false);
  assert.deepEqual(project(world, 30), project(world, 30));
  assert.notDeepEqual(project(world, 30), project(world, -30));
  // At zero degrees the front plane is nearer the camera than the back plane.
  const front = project({ x: 0, y: 0, z: 40 }, 0);
  const back = project({ x: 0, y: 0, z: -40 }, 0);
  assert.ok(front.scale > back.scale, "depth must be visible as scale");
});

test("breadcrumbs always start at the whole system and name the organ before the part", () => {
  const scene = anatomyScene(ATLAS_DEMO_PAYLOAD, {});
  assert.deepEqual(breadcrumbsFor(scene, null), [{ key: "whole", label: "Whole system" }]);
  const trail = breadcrumbsFor(scene, "service:demo-worker");
  assert.equal(trail.length, 3);
  assert.equal(trail[0].label, "Whole system");
  assert.match(trail[1].label, /Infrastructure/);
  assert.match(trail[2].label, /Demo worker/);
  assert.match(operationsHtml, /id="atlasBack"[^>]*>Return to whole system</);
});

test("the phone profile is two columns, is the only thing that re-sites a component, and says so", () => {
  assert.equal(profileFor(360).key, "narrow");
  assert.equal(profileFor(1280).key, "wide");
  assert.equal(profileFor(NARROW_BREAKPOINT).key, "wide", "the breakpoint itself is the wide side");
  assert.equal(SCENE_NARROW.columns, 2);
  assert.equal(SCENE_WIDE.columns, 6);
  const narrow = anatomyScene(ATLAS_DEMO_PAYLOAD, { profile: SCENE_NARROW });
  const wide = anatomyScene(ATLAS_DEMO_PAYLOAD, { profile: SCENE_WIDE });
  for (const node of ATLAS_DEMO_PAYLOAD.nodes) {
    const a = narrow.nodes.find((entry) => entry.node.id === node.id);
    const b = wide.nodes.find((entry) => entry.node.id === node.id);
    // The profile changes the column count and the frame. It never changes the
    // organ, the plane or the order.
    assert.equal(a.organ, b.organ, `${node.id} changed organ across the breakpoint`);
    assert.equal(a.slot, b.slot, `${node.id} changed slot across the breakpoint`);
    assert.equal(a.evidence.z, b.evidence.z, `${node.id} changed plane across the breakpoint`);
  }
  assert.match(sceneJs, /BREAKPOINT_SENTENCE/, "the one exception is stated on the page");
  assert.match(sceneJs, /profileFor\(window\.innerWidth\)/);
  assert.notEqual(narrow.viewBox, wide.viewBox, "the frame grows with the narrow body");
});

test("the exploded frame grows instead of cropping an organ", () => {
  for (const profile of [SCENE_WIDE, SCENE_NARROW]) {
    const assembled = anatomyScene(ATLAS_DEMO_PAYLOAD, { exploded: false, profile });
    const exploded = anatomyScene(ATLAS_DEMO_PAYLOAD, { exploded: true, profile });
    const span = (scene) => Math.max(...scene.nodes.map((entry) => entry.screen.y)) - Math.min(...scene.nodes.map((entry) => entry.screen.y));
    assert.ok(span(exploded) > span(assembled), `${profile.key}: exploding must spread the body`);
    // The organ band is drawn 1.5 plate-heights beyond the outermost plate, so
    // the frame has to clear that on both sides or a band is sliced off.
    const frame = (scene) => Number(scene.viewBox.split(" ")[3]);
    const margin = profile.nodeHeight * 1.6;
    for (const [name, scene] of [["assembled", assembled], ["exploded", exploded]]) {
      const lowest = Math.max(...scene.nodes.map((entry) => entry.screen.y));
      const highest = Math.min(...scene.nodes.map((entry) => entry.screen.y));
      assert.ok(highest > margin, `${profile.key} ${name}: the top organ is cropped`);
      assert.ok(frame(scene) - lowest > margin, `${profile.key} ${name}: the bottom organ is cropped`);
    }
  }
});
