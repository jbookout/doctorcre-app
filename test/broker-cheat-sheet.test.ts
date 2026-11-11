import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { appendSheetSections, generatedSheet, sheetHistory } from "../src/ui/broker-cheat-sheet.ts";

test("history rejects unavailable or malformed revisions before rendering", () => {
  for (const value of [
    null,
    {},
    { revisions: [{}] },
    { revisions: [{ revision_id: "-".repeat(36), revision_number: 1, content: {} }] },
  ]) {
    assert.throws(() => sheetHistory(value), /history_invalid/);
  }
  assert.deepEqual(sheetHistory({ revisions: [] }), []);
});

test("generated itinerary is independent of broker notes", () => {
  assert.equal(generatedSheet({ notes: "Broker notes", generated_itinerary: "Current facts" }), "Current facts");
  assert.equal(generatedSheet({ notes: "Legacy notes" }), "");
});

test("print sections retain property text without interpreting markup", () => {
  const dom = new JSDOM("<body></body>");
  try {
    appendSheetSections(
      dom.window.document.body,
      "Internal\n\nTour\n\nVersion\n\nA · <img src=x>\nAddress: Example\n\nNot on the active itinerary\n\nHeld property\nStatus: Held",
    );
    assert.equal(dom.window.document.querySelectorAll(".sheet-property").length, 2);
    assert.equal(dom.window.document.querySelector("h2")?.textContent, "A · <img src=x>");
    assert.equal(dom.window.document.querySelectorAll("img").length, 0);
  } finally {
    dom.window.close();
  }
});
