// QA batch 2 — a Legal-stage Kanban card printed a Python dict such as
// {'text': 'Send the redlines', 'at': '...'} as its next step. Note values are
// normalized to their sentence before any card or panel paints them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { noteText, recordPanelSections } from "../js/pipeline-model.js";

const pageJs = await readFile(new URL("../js/pipeline.js", import.meta.url), "utf8");

test("a plain sentence passes through unchanged", () => {
  assert.equal(noteText("Send the redlines to counsel"), "Send the redlines to counsel");
  assert.equal(noteText("  Call Dr. Patel  "), "Call Dr. Patel");
});

test("a Python dict repr yields its sentence", () => {
  assert.equal(noteText("{'text': 'Send the redlines to counsel', 'at': '2026-09-28T14:00:00Z'}"), "Send the redlines to counsel");
  assert.equal(noteText(`{'text': "Landlord's counsel has the lease", 'by': 'joe'}`), "Landlord's counsel has the lease");
  assert.equal(noteText("{'at': '2026-09-28', 'text': 'It\\'s with legal'}"), "It's with legal");
});

test("a JSON-shaped string yields its sentence", () => {
  assert.equal(noteText('{"text": "Review the estoppel", "at": "2026-09-28"}'), "Review the estoppel");
  assert.equal(noteText('{"note": "Waiting on the SNDA"}'), "Waiting on the SNDA");
});

test("an object yields its sentence", () => {
  assert.equal(noteText({ text: "Countersign the LOI", at: "2026-09-28" }), "Countersign the LOI");
  assert.equal(noteText({ body: "Title commitment received" }), "Title commitment received");
  assert.equal(noteText({ text: { text: "Nested sentence" } }), "Nested sentence");
});

test("a dict or object with no sentence renders as nothing, never as raw braces", () => {
  assert.equal(noteText("{}"), "");
  assert.equal(noteText({}), "");
  assert.equal(noteText("{'at': '2026-09-28'}"), "");
  assert.equal(noteText(null), "");
  assert.equal(noteText(undefined), "");
});

test("braces inside an ordinary sentence are left alone", () => {
  assert.equal(noteText("Use the {client} template"), "Use the {client} template");
});

test("the record panel shows the sentence for next step and latest communication", () => {
  const sections = recordPanelSections({
    deal: { name: "Demo Legal deal", phase: "Legal", owner: "joe", next_step: "{'text': 'Send the redlines', 'at': '2026-09-28'}" },
    thread: [{ actor: "dell", text: "{'text': 'Counsel replied'}" }],
  }, { actorLabel: (slug) => slug });
  const byTitle = Object.fromEntries(sections.map((section) => [section.title, section.lines.join(" ")]));
  assert.equal(byTitle["Next action"], "Send the redlines");
  assert.equal(byTitle["Latest communication"], "dell: Counsel replied");
  assert.doesNotMatch(JSON.stringify(sections), /'text'/);
});

test("the record panel falls back to plain words when the note carries no sentence", () => {
  const sections = recordPanelSections({ deal: { name: "Demo", next_step: "{}" }, thread: [] });
  assert.equal(sections.find((section) => section.title === "Next action").lines[0], "No next step recorded.");
});

test("the Kanban card paints the normalized sentence", () => {
  assert.match(pageJs, /esc\(noteText\(deal\.next_step\) \|\| 'No next step recorded'\)/);
});
