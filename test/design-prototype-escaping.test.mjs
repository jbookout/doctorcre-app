import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Quick Add preview re-renders on every keystroke from typed text, through
// the el() helper's html: key (innerHTML). Every typed or record-derived value
// it interpolates must pass through escapeText.
test("the Quick Add preview escapes every value it writes as HTML", async () => {
  const source = await readFile(new URL("../js/design-prototype.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function renderQuickAdd()"), source.indexOf("$(\"quickAddQuestion\")"));
  assert.ok(body.includes("quickAddParsed"), "renderQuickAdd preview block not found");
  for (const value of ["parsed.action", "formatDueStamp(due, parsed.dueTime)", "parsed.related"]) {
    const html = body.split("\n").filter((line) => line.includes("html:") && line.includes(value));
    assert.ok(html.length, `${value} is no longer in the preview; update this test`);
    for (const line of html) assert.match(line, new RegExp(`escapeText\\(${value.replace(/[().]/g, "\\$&")}\\)`), line.trim());
  }
});
