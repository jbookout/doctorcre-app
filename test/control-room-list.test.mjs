import test from "node:test";
import assert from "node:assert/strict";
import { createQueue, addPage } from "../js/control-room-queue-model.js";
import { ageLabel, listHtml, emptyHtml, isTypingTarget, ignoreKey, listKey, paneShortcut } from "../js/control-room-list.js";

const row = (kind, id, state, extra = {}) => ({ id, kind, state, title: `Demo ${kind} ${id}`, owner: "joe", age: 3, version: "1",
  identity: {}, available_triage_actions: [], opened_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-15T00:00:00Z", ...extra });
const census = (items, extra = {}) => ({ schema: "unfinished-work.v1", items, census_complete: true, next_cursor: null,
  coverage: [{ kind: "work_request", state: "complete", count_total: items.length, reason: null }], ...extra });

test("rows carry kind glyph and word, muted ref, state, title, owner and a tabular age", () => {
  const queue = addPage(createQueue(), census([
    row("incident", "INC-1", "investigating", { identity: { ref: "INC-1" } }),
    row("loop", "l-1", "open", { owner: null, age: 40 }),
  ]));
  const html = listHtml(queue.items, { highlightId: "incident:INC-1" });
  assert.match(html, /role="option"[^>]*aria-selected="true"/);
  assert.match(html, /<span class="cr-kind-glyph" aria-hidden="true">△<\/span>Incident/);
  assert.match(html, /class="cr-row-ref">INC-1</);
  assert.match(html, /<\/span>Investigating</);
  assert.match(html, /cr-cell-owner is-empty">Unassigned/);
  assert.match(html, /title="Open 40 days · opened Oct 1, 2026 · last activity Oct 15, 2026"/);
  assert.match(html, /cr-group-head[^>]*><span>In progress<\/span><span class="cr-group-count">1</);
  assert.doesNotMatch(html, /Blocked/, "empty groups are hidden");
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, "one roving highlight, no multi-select");
});

test("ages read as days, then weeks, then months", () => {
  assert.deepEqual([0, 1, 13, 14, 89, 120, null, -1].map(ageLabel), ["today", "1d", "13d", "2w", "12w", "4mo", "—", "—"]);
});

test("the empty list points at Triage when work is waiting there", () => {
  assert.match(emptyHtml({ triage: 2 }), /2 items wait in Triage/);
  assert.match(emptyHtml(), /New work arrives through Triage/);
});

test("keys typed into fields or mid IME composition are never shortcuts", () => {
  const key = (key, extra = {}) => ({ key, target: { tagName: "DIV" }, ...extra });
  assert.equal(isTypingTarget({ tagName: "input" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(ignoreKey(key("j", { isComposing: true })), true);
  assert.equal(ignoreKey(key("j", { keyCode: 229 })), true);
  assert.equal(listKey(key("j", { target: { tagName: "TEXTAREA" } })), null);
  assert.equal(listKey(key("j")), "next");
  assert.equal(listKey(key("ArrowUp")), "previous");
  assert.equal(listKey(key(" ")), "toggle");
  assert.equal(listKey(key("Enter")), "open");
  assert.equal(listKey(key("j", { metaKey: true })), null);
  assert.equal(paneShortcut(key("i", { metaKey: true, code: "KeyI" })), true);
  assert.equal(paneShortcut(key("i", { ctrlKey: true, code: "KeyI" })), true);
  assert.equal(paneShortcut(key("i", { metaKey: true, code: "KeyI", target: { tagName: "INPUT" } })), false, "Cmd+I stays italic inside editors");
  assert.equal(paneShortcut(key("i", { code: "KeyI" })), false);
});
