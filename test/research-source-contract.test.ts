import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateLeadDetail, validateLeadWorkspace } from "../js/leads-client.js";
import recording from "./fixtures/research-source/recordings.json" with { type: "json" };

validateLeadWorkspace(recording);
validateLeadDetail(recording.detail, recording.detail.id);

test("synthetic source findings replay the pinned producer and consumer contract", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const producer = await readFile(new URL("./fixtures/research-kind-filter/producer.txt", import.meta.url), "utf8");
  const { researchSummary } = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(producer)).toString("base64")}`
  );
  const actual = researchSummary(recording.detail.research.evidence, Date.parse("2026-11-07T12:00:00Z"));
  assert.deepEqual(actual, recording.detail.research);
  validateLeadDetail({ ...recording.detail, research: actual }, recording.detail.id);
});
