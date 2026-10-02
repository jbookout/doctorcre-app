import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createDraft, PLAN_FIELDS, SEARCH_FIELDS, clientSuggestions, addPrivateFiles, tourGroups, validateCriteria } from "../tours/planner-model.js";
import { createPlannerClient } from "../tours/planner-client.js";
import { mountPlanner } from "../tours/planner.js";

const html = await readFile(new URL("../tours/index.html", import.meta.url), "utf8");
const clientA = "11111111-1111-4111-8111-111111111111", clientB = "22222222-2222-4222-8222-222222222222";
const record = id => ({ id, name: id === clientA ? "Demo Practice A" : "Demo Practice B", city: "Demo City", state: "FL", vertical: "Demo specialty", notes: "Synthetic original entry" });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(api = {}) {
  const dom = new JSDOM(html, { url: "https://example.test/tours", pretendToBeVisual: true });
  const doc = dom.window.document;
  doc.querySelector("dialog").showModal = function() { this.open = true; };
  doc.querySelector("dialog").close = function() { this.open = false; };
  const service = { scope: "synthetic-scope", library: async () => [{ id: clientA, name: "Demo upcoming", status: "draft" }, { id: clientB, name: "Demo past", status: "completed" }], clients: async () => [record(clientA), record(clientB)], client: async id => record(id), tour: async id => ({ id, name: "Demo tour", stops: [], cheat_sheet: { content: { notes: "Synthetic original entry" } } }), ...api };
  const view = mountPlanner({ document: doc, window: dom.window, api: service });
  return { dom, doc, view, service, change(selector, value) { const node = doc.querySelector(selector); node.value = value; node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" && selector.endsWith("client") ? "change" : "input", { bubbles: true })); }, close() { view.dispose(); dom.window.close(); } };
}

test("each suggested field and typed override undo independently", () => {
  const draft = createDraft(PLAN_FIELDS); draft.suggest(clientSuggestions(record(clientA)));
  draft.set("area", "Typed area"); assert.equal(draft.undo(), "area"); assert.equal(draft.values.area, "Demo City, FL");
  assert.equal(draft.undo(), "notes"); assert.equal(draft.values.notes, "");
  assert.equal(draft.undo(), "use"); assert.equal(draft.values.use, "");
  assert.equal(draft.undo(), "area"); assert.equal(draft.values.area, "");
  assert.equal(draft.undo(), "name"); assert.equal(draft.canUndo, false);
});
test("prefill leaves unknown tour details blank and never replaces an edit", () => {
  const draft = createDraft(PLAN_FIELDS); draft.set("area", "Typed before read"); draft.suggest(clientSuggestions(record(clientA)));
  assert.equal(draft.values.area, "Typed before read"); assert.equal(draft.values.date, ""); assert.equal(draft.values.start, "");
});
test("fresh suggestions update unedited fields; overrides and undone suggestions remain untouched", () => {
  const draft = createDraft(PLAN_FIELDS); draft.suggest(clientSuggestions(record(clientA)));
  draft.set("area", "Typed area"); draft.undo();
  draft.refreshSuggestions({ name: "Demo new name", area: "New area", use: "New specialty", notes: "New notes" });
  assert.equal(draft.values.name, "Demo new name"); assert.equal(draft.values.area, "Demo City, FL");
  draft.set("use", "Typed specialty"); draft.refreshSuggestions({ name: "Demo newest name", use: "Other specialty" });
  assert.equal(draft.values.use, "Typed specialty");
});
test("file staging deduplicates, bounds size/count and rejects atomically", () => {
  const file = { name: "synthetic.txt", size: 20, lastModified: 1 };
  assert.equal(addPrivateFiles([file], [file]).length, 1);
  assert.throws(() => addPrivateFiles([], [{ ...file, size: 26 * 1024 * 1024 }]), /25 MB/);
  assert.throws(() => addPrivateFiles(Array.from({ length: 12 }, (_, i) => ({ ...file, name: `${i}.txt` })), [{ ...file, name: "more.txt" }]), /12 files/);
});
test("criteria support research-only searches and reject inverted SF", () => {
  const draft = createDraft(SEARCH_FIELDS); draft.set("area", "Demo region"); draft.set("minSize", "2000"); draft.set("maxSize", "1000");
  assert.match(validateCriteria(draft.values), /Maximum/); draft.set("maxSize", "3000"); assert.equal(validateCriteria(draft.values), "");
});
test("tour history filtering recognizes completion and searches both groups", () => {
  const tours = [{ name: "Demo A", status: "draft" }, { name: "Demo B", status: "completed" }];
  assert.equal(tourGroups(tours).upcoming.length, 1); assert.equal(tourGroups(tours, "DEMO B").history.length, 1); assert.equal(tourGroups(tours, "missing").upcoming.length, 0);
});
test("client read uses the producer's exact pagination and verifies identity", async () => {
  const calls = []; const api = createPlannerClient({ fetchImpl: async path => {
    calls.push(path); return { ok: true, json: async () => path.includes(clientA) ? { record: record(clientB) } : { page: Number(new URL(path, "https://example.test").searchParams.get("page")), page_count: 2, rows: [record(clientA)] } };
  } });
  assert.equal((await api.clients()).length, 2); assert.match(calls[0], /scope=team&sort=name&page=1/); assert.match(calls[1], /page=2/);
  await assert.rejects(api.client(clientA), /mismatch/);
  await assert.rejects(api.client("-".repeat(36)), /Invalid/);
  assert.deepEqual(api.capabilities, { compile: false, mls: false });
});
test("late client A prefill cannot contaminate client B; typing during read survives", async () => {
  let resolveA; const app = harness({ client: id => id === clientA ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve(record(id)) });
  try {
    await app.view.ready; app.change("#plan-client", clientA); app.change("#plan-client", clientB); app.change("#plan-area", "Typed B"); await settle();
    resolveA(record(clientA)); await settle();
    assert.match(app.doc.querySelector("#plan-name").value, /Demo Practice B/); assert.equal(app.doc.querySelector("#plan-area").value, "Typed B");
    app.doc.querySelector("#plan-undo").click(); assert.equal(app.doc.querySelector("#plan-notes").value, "");
  } finally { app.close(); }
});
test("background updates preserve draft, file bytes stay only in memory, scope changes clear both", async () => {
  const app = harness();
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle(); app.change("#plan-name", "Typed name");
    const file = new app.dom.window.File(["synthetic private bytes"], "synthetic-private.txt", { type: "text/plain" });
    Object.defineProperty(app.doc.querySelector("#packet-upload"), "files", { value: [file], configurable: true });
    app.doc.querySelector("#packet-upload").dispatchEvent(new app.dom.window.Event("change"));
    await app.view.refresh(); assert.equal(app.doc.querySelector("#plan-name").value, "Typed name"); assert.equal(app.view.files.length, 1);
    const stored = app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1"); assert.doesNotMatch(stored, /synthetic-private|private bytes/);
    app.change("#plan-client", clientB); await settle(); assert.equal(app.view.files.length, 0);
    app.service.scope = "other-scope"; await app.view.refresh(); assert.equal(app.view.files.length, 0); assert.equal(app.doc.querySelector("#plan-name").value, "");
  } finally { app.close(); }
});
test("tour row opens a popup, notes summarize, Details retains original entry, refresh updates open detail", async () => {
  let name = "Demo initial"; const app = harness({ tour: async id => ({ id, name, stops: [], cheat_sheet: { content: { notes: "Synthetic original entry ".repeat(20) } } }) });
  try {
    await app.view.ready; const button = app.doc.querySelector(".tour-button"); button.focus(); button.click(); await settle();
    assert.equal(app.doc.querySelector("dialog").open, true); assert.match(app.doc.querySelector("#detail-content details").textContent, /Synthetic original/);
    app.doc.querySelector("#detail-content details").open = true;
    app.doc.querySelector("#detail-content summary").focus();
    name = "Demo refreshed"; await app.view.refresh(); assert.equal(app.doc.querySelector("#detail-title").textContent, name);
    assert.equal(app.doc.querySelector("#detail-content details").open, true);
    assert.equal(app.doc.activeElement, app.doc.querySelector("#detail-content summary"));
    assert.equal(app.doc.querySelector("#detail-content a").target, "_blank");
    app.doc.querySelector("#detail-close").click(); assert.equal(app.doc.querySelector("dialog").open, false);
  } finally { app.close(); }
});
test("research criteria persist per session, tour search filters, territory button feeds editable area", async () => {
  const app = harness();
  try {
    await app.view.ready; app.doc.querySelector('[data-market="Pensacola, FL"]').click(); assert.equal(app.doc.querySelector("#space-area").value, "Pensacola, FL");
    app.doc.querySelector("#space-undo").click(); assert.equal(app.doc.querySelector('[data-market="Pensacola, FL"]').getAttribute("aria-pressed"), "false");
    app.change("#space-area", "Demo research area");
    app.change("#tour-filter", "past"); assert.equal(app.doc.querySelectorAll("#upcoming-tours button").length, 0); assert.equal(app.doc.querySelectorAll("#history-tours button").length, 1);
    app.doc.querySelector("#space-form").dispatchEvent(new app.dom.window.Event("submit", { cancelable: true }));
    assert.match(app.doc.querySelector("#space-message").textContent, /saved/);
    assert.equal(app.doc.querySelector("#space-client").value, "");
  } finally { app.close(); }
});
test("client outage clears on automatic recovery and form caret survives background refresh", async () => {
  let unavailable = false;
  const app = harness({ clients: async () => { if (unavailable) throw new Error("Synthetic outage"); return [record(clientA)]; } });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.change("#plan-name", "Typed tour name");
    const input = app.doc.querySelector("#plan-name"); input.focus(); input.setSelectionRange(4, 4);
    unavailable = true; await app.view.refresh();
    assert.match(app.doc.querySelector("#plan-message").textContent, /unavailable/);
    assert.equal(app.doc.querySelector(".freshness").classList.contains("current"), false);
    unavailable = false; await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-message").textContent, "");
    assert.equal(app.doc.querySelector(".freshness").classList.contains("current"), true);
    assert.equal(input.selectionStart, 4); assert.equal(app.doc.activeElement, input);
  } finally { app.close(); }
});
test("unsupported search UI is absent from the landing page and backend actions are withheld", () => {
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector("#property-search-form"), null);
  assert.equal(doc.querySelectorAll(".widget-actions button[disabled]").length, 2);
  assert.equal(doc.querySelectorAll(".hint, .selection-footnote").length, 0);
});
