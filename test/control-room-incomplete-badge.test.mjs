// QA batch 2 — the Control Room header said "Every read answered" while the
// Atlas tab reported ops.v_job_run could not be read in full. The header badge
// now reflects any read that answered incompletely.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";


import {KNOWN_GAPS, atlasIncompleteSources} from "../js/atlas-model.js";

const pageJs = await readFile(new URL("../js/control-room.js", import.meta.url), "utf8");
const atlasJs = await readFile(new URL("../js/atlas.js", import.meta.url), "utf8");

const gapRows = KNOWN_GAPS.map((gap) => ({ ...gap, node_count: 0, edge_count: 0, complete: false }));
const row = (source_ref, complete, missing_reason = null) => ({ source_ref, evidence_class: "observed", node_count: 0, edge_count: 0, complete, missing_reason });

test("the atlas names every source it could not read in full, not the four declared gaps", () => {
  const payload = { coverage: [row("ops.service", true), row("ops.v_job_run", false, "INTERNAL_ERROR"), row("public.doctrine_edge", false, "page_capped"), ...gapRows] };
  assert.deepEqual(atlasIncompleteSources({ status: "ready", payload }), ["ops.v_job_run", "public.doctrine_edge"]);
});

test("an atlas with only the declared gaps is complete", () => {
  assert.deepEqual(atlasIncompleteSources({ status: "ready", payload: { coverage: [row("ops.service", true), ...gapRows] } }), []);
});

test("an atlas that has not been read yet claims nothing either way", () => {
  assert.deepEqual(atlasIncompleteSources({ status: "idle", payload: null }), []);
  assert.deepEqual(atlasIncompleteSources({ status: "loading", payload: null }), []);
});

test("an atlas read that failed counts as incomplete", () => {
  assert.deepEqual(atlasIncompleteSources({ status: "offline", payload: null }), ["the atlas"]);
  assert.deepEqual(atlasIncompleteSources({ status: "unavailable", payload: null }), ["the atlas"]);
});
