// QA batch 2 — a Legal-stage Kanban card printed a Python dict such as
// {'text': 'Send the redlines', 'at': '...'} as its next step. Note values are
// normalized to their sentence before any card or panel paints them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { noteText } from "../js/pipeline-model.js";

import { noteEntries } from '../js/local-deals-model.js';

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

test("editable deal detail preserves normalized note summaries and originals", () => {
  const entries = noteEntries({ thread: [{ id: 'demo-note', actor: 'dell', text: "{'text': 'Counsel replied'}" }] });
  assert.equal(entries[0].summary, 'Counsel replied');
  assert.equal(entries[0].original, 'Counsel replied');
  assert.deepEqual(noteEntries({ thread: [{ text: '{}' }] }), []);
});

test("the Kanban card paints the normalized sentence", () => {
  assert.match(pageJs, /esc\(concise\(deal\.next_step\) \|\| 'Next step pending'\)/);
});
