// QA batch 2 — on a phone, Quick add filled the first screen of Tasks. Open
// work now comes first at phone width and Quick add is a compact, collapsible
// panel that starts collapsed there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { quickAddStartsOpen } from "../js/task-records-model.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const html = await read("tasks.html");
const css = await read("css/tasks.css");
const js = await read("js/task-records.js");

test("Quick add is a collapsible panel with the form inside it", () => {
  const panel = html.match(/<details[^>]*id="quickAddPanel"[\s\S]*?<\/details>/)?.[0] || "";
  assert.ok(panel, "expected <details id=\"quickAddPanel\">");
  assert.match(panel, /<summary[^>]*>[\s\S]*Quick add[\s\S]*<\/summary>/);
  assert.match(panel, /id="quickAddForm"/);
});

test("the open-work and Quick add sections carry hooks for phone ordering", () => {
  assert.match(html, /<section class="card glass tasks-open"[^>]*aria-labelledby="listTitle"/);
  assert.match(html, /<section class="card glass tasks-quick-add"[^>]*aria-labelledby="quickTitle"/);
});

test("at phone width open work is placed before Quick add, and Quick add is compact", () => {
  const phone = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/g)?.join("\n") || "";
  assert.match(phone, /#main\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  // The page title keeps order 0, so it stays first; the list then Quick add.
  assert.match(phone, /\.tasks-open\s*\{[^}]*order:\s*1\b/);
  assert.match(phone, /\.tasks-quick-add\s*\{[^}]*order:\s*2\b[^}]*padding/);
});

test("Quick add starts collapsed on a phone and open on a wider screen", () => {
  assert.equal(quickAddStartsOpen({ phone: true }), false);
  assert.equal(quickAddStartsOpen({ phone: false }), true);
  assert.equal(quickAddStartsOpen({ phone: true, hasDraftText: true }), true);
});

test("the page applies the start state and opens the panel when a draft is restored", () => {
  assert.match(js, /quickAddStartsOpen\(/);
  assert.match(js, /matchMedia(\?\.)?\("\(max-width: 640px\)"\)/);
  assert.match(js, /\$\("quickAddPanel"\)\.open = true/);
});

test("the summary uses the dark register and meets the touch floor", () => {
  assert.match(css, /\.quick-add-summary\s*\{[^}]*min-height:\s*var\(--touch\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, "tasks.css adds no colours of its own");
});
