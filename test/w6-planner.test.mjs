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
test("R13: Tour day opens its whole surface in a separate tab", async () => {
  const { detail } = await import("./fixtures/tour-day.synthetic.mjs");
  const app = harness({ tour: async () => detail });
  try {
    await app.view.ready; app.doc.querySelector("[data-tour-id]").click(); await settle();
    const link = app.doc.querySelector('a[href^="/tours/day.html"]');
    assert.ok(link); assert.equal(link.target, "_blank"); assert.match(link.rel, /noopener/);
  } finally { app.close(); }
});
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'planner transition did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function harness(api = {}, beforeMount = () => {}) {
  const dom = new JSDOM(html, { url: "https://example.test/tours", pretendToBeVisual: true });
  const doc = dom.window.document;
  doc.querySelector("dialog").showModal = function() { this.open = true; };
  doc.querySelector("dialog").close = function() { this.open = false; };
  const service = { scope: "synthetic-scope", library: async () => [{ id: clientA, name: "Demo upcoming", status: "draft" }, { id: clientB, name: "Demo past", status: "completed" }], clients: async () => [record(clientA), record(clientB)], client: async id => record(id), tour: async id => ({ id, name: "Demo tour", stops: [], cheat_sheet: { content: { notes: "Synthetic original entry" } } }), ...api };
  if (Object.getOwnPropertyDescriptor(api, "scope")?.get) Object.defineProperty(service, "scope", { get: () => api.scope });
  beforeMount(dom.window);
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

function sessionHarness() {
  let token = "synthetic-A", refused = false;
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: !refused, status: refused ? 401 : 200,
    json: async () => ({ csrf_token: token, data: path.includes("library") ? { tours: [{ id: clientA, name: "Private A", status: "draft" }] } : path.includes("detail") ? { id: clientA, name: "Private detail", stops: [] } : path.includes(clientA) ? { record: record(clientA) } : { page: 1, page_count: 1, rows: [record(clientA)] } }),
  }) });
  return { ...harness(api), session(value) { token = value; }, refuse() { refused = true; } };
}
function stageFile(app) {
  Object.defineProperty(app.doc.querySelector("#packet-upload"), "files", { value: [new app.dom.window.File(["synthetic"], "private.txt")], configurable: true });
  app.doc.querySelector("#packet-upload").dispatchEvent(new app.dom.window.Event("change"));
}
test("detail session transition clears private drafts, files and cached records before another edit", async () => {
  const app = sessionHarness();
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle(); app.change("#plan-name", "Private draft A"); stageFile(app);
    app.session("synthetic-B"); app.doc.querySelector(".tour-button").click();
    await waitFor(() => app.doc.querySelector('#plan-name').value === '');
    assert.equal(app.doc.querySelector("#plan-name").value, ""); assert.equal(app.view.files.length, 0);
    assert.equal(app.doc.querySelectorAll(".tour-button").length, 0); assert.equal(app.doc.querySelectorAll("#plan-client option").length, 1);
    assert.equal(app.doc.querySelector("dialog").open, false);
    app.change("#plan-name", "New draft B");
    const saved = JSON.parse(app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1"));
    assert.equal(saved.scope, app.service.scope); assert.equal(saved.planClient, "");
  } finally { app.close(); }
});
test("HTTP authentication refusal clears private state and requires sign-in instead of reporting an outage", async () => {
  const app = sessionHarness();
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle(); stageFile(app); app.refuse(); await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-name").value, ""); assert.equal(app.view.files.length, 0);
    assert.equal(app.doc.querySelectorAll(".tour-button").length, 0); assert.equal(app.doc.querySelectorAll("#plan-client option").length, 1);
    assert.match(app.doc.querySelector("#tour-library-state").textContent, /sign in/i);
    assert.equal(app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1"), null);
    await assert.rejects(app.service.library(), error => error.code === "authentication_required");
  } finally { app.close(); }
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test("manual refresh supersedes delayed boot library and client options", async () => {
  const oldLibrary = deferred(), oldClients = deferred();
  const app = harness({ library: () => oldLibrary.promise, clients: () => oldClients.promise });
  try {
    app.service.library = async () => [{ id: clientB, name: "New library", status: "draft" }]; app.service.clients = async () => [record(clientB)];
    app.doc.querySelector("#planner-refresh").click(); await settle();
    oldLibrary.resolve([{ id: clientA, name: "Old library", status: "draft" }]); oldClients.resolve([record(clientA)]); await app.view.ready;
    assert.match(app.doc.querySelector("#upcoming-tours").textContent, /New library/); assert.doesNotMatch(app.doc.querySelector("#upcoming-tours").textContent, /Old library/);
    assert.equal(app.doc.querySelectorAll('#plan-client option[value="' + clientA + '"]').length, 0);
  } finally { app.close(); }
});
test("new same-tour background detail supersedes delayed popup detail", async () => {
  const old = deferred(); const app = harness({ tour: () => old.promise });
  try {
    await app.view.ready; app.doc.querySelector(".tour-button").click();
    app.service.tour = async id => ({ id, name: "New detail", stops: [] }); await app.view.refresh();
    old.resolve({ id: clientA, name: "Old detail", stops: [] }); await settle();
    assert.equal(app.doc.querySelector("#detail-title").textContent, "New detail");
  } finally { app.close(); }
});
for (const prefix of ["plan", "space"]) test(`new same-client background record settles ${prefix} status and supersedes delayed prefill`, async () => {
  const old = deferred(); const app = harness({ client: () => old.promise });
  try {
    await app.view.ready; app.change(`#${prefix}-client`, clientA);
    assert.equal(app.doc.querySelector(`#${prefix}-message`).textContent, "Updating…");
    app.service.client = async id => ({ ...record(id), notes: "Newest record notes" }); await app.view.refresh();
    assert.equal(app.doc.querySelector(`#${prefix}-message`).textContent, "");
    assert.equal(app.doc.querySelector(".freshness").classList.contains("current"), true);
    old.resolve({ ...record(clientA), notes: "Stale record notes" }); await settle();
    await app.view.refresh();
    assert.equal(app.doc.querySelector(`#${prefix}-message`).textContent, "");
    assert.equal(app.doc.querySelector(`#${prefix}-area`).value, "Demo City, FL");
    if (prefix === "plan") {
      assert.equal(app.doc.querySelector("#plan-notes").value, "Newest record notes");
      app.doc.querySelector("#review-packet").click();
      assert.match(app.doc.querySelector("#detail-content details").textContent, /Newest record notes/);
    }
  } finally { app.close(); }
});
for (const prefix of ["plan", "space"]) test(`settled ${prefix} client refresh preserves an undo message`, async () => {
  const old = deferred(); const app = harness({ client: () => old.promise });
  try {
    await app.view.ready; app.change(`#${prefix}-client`, clientA);
    app.change(`#${prefix}-area`, "Typed area"); app.doc.querySelector(`#${prefix}-undo`).click();
    assert.equal(app.doc.querySelector(`#${prefix}-message`).textContent, "Change undone.");
    app.service.client = async id => record(id); await app.view.refresh();
    old.resolve(record(clientA)); await settle();
    assert.equal(app.doc.querySelector(`#${prefix}-message`).textContent, "Change undone.");
  } finally { app.close(); }
});
test("settled search client refresh preserves a save message", async () => {
  const old = deferred(); const app = harness({ client: () => old.promise });
  try {
    await app.view.ready; app.change("#space-client", clientA); app.change("#space-area", "Typed area");
    app.doc.querySelector("#space-form").dispatchEvent(new app.dom.window.Event("submit", { cancelable: true }));
    assert.equal(app.doc.querySelector("#space-message").textContent, "Search draft saved.");
    app.service.client = async id => record(id); await app.view.refresh();
    old.resolve(record(clientA)); await settle();
    assert.equal(app.doc.querySelector("#space-message").textContent, "Search draft saved.");
  } finally { app.close(); }
});
test("cancelled refresh cannot publish its late data or freshness", async () => {
  const app = harness(); const late = deferred(), controller = new AbortController();
  try {
    await app.view.ready; app.service.library = () => late.promise;
    const pending = app.view.refresh({ signal: controller.signal }); controller.abort();
    app.service.library = async () => [{ id: clientB, name: "Newest", status: "draft" }]; await app.view.refresh();
    late.resolve([{ id: clientA, name: "Cancelled", status: "draft" }]); await pending;
    assert.match(app.doc.querySelector("#upcoming-tours").textContent, /Newest/); assert.doesNotMatch(app.doc.querySelector("#upcoming-tours").textContent, /Cancelled/);
  } finally { app.close(); }
});

test("late transport response cannot roll the adapter back to an earlier session", async () => {
  const old = deferred(); let body = { csrf_token: "synthetic-A", data: { tours: [] } };
  const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: () => body }) });
  await api.library(); body = old.promise; const pending = api.library(); await settle();
  body = { csrf_token: "synthetic-B", data: { tours: [] } }; await api.library(); const scopeB = api.scope;
  old.resolve({ csrf_token: "synthetic-A", data: { tours: [] } }); await assert.rejects(pending, /session|superseded/i);
  assert.equal(api.scope, scopeB);
});
test("timed-out decoding cannot later change the adapter session", async () => {
  const late = deferred(); const api = createPlannerClient({ timeoutMs: 5, fetchImpl: async () => ({ ok: true, json: () => late.promise }) });
  await assert.rejects(api.library(), error => error.code === "read_timeout");
  late.resolve({ csrf_token: "late-session", data: { tours: [] } }); await settle(); await settle();
  assert.equal(api.scope, null);
});

test("delayed boot restore preserves edits and undo in both enabled forms", async () => {
  const boot = deferred();
  const app = harness({ scope: null, library: () => boot.promise }, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", JSON.stringify({ scope: "synthetic-scope", plan: { name: "Saved tour", date: "2026-10-10" }, search: { area: "Saved area", budget: "1200" } })));
  try {
    app.change("#plan-name", "New tour"); app.change("#space-area", "New area");
    app.service.scope = "synthetic-scope"; boot.resolve([]); await app.view.ready;
    assert.equal(app.doc.querySelector("#plan-name").value, "New tour"); assert.equal(app.doc.querySelector("#space-area").value, "New area");
    assert.equal(app.doc.querySelector("#plan-date").value, "2026-10-10"); assert.equal(app.doc.querySelector("#space-budget").value, "1200");
    app.doc.querySelector("#plan-undo").click(); app.doc.querySelector("#space-undo").click();
    assert.equal(app.doc.querySelector("#plan-name").value, ""); assert.equal(app.doc.querySelector("#space-area").value, "");
  } finally { app.close(); }
});
test("delayed boot restore never changes a newly selected client binding", async () => {
  const boot = deferred(); const app = harness({ scope: null, library: () => boot.promise }, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", JSON.stringify({ scope: "synthetic-scope", planClient: clientA, searchClient: clientA, plan: { name: "Saved A" }, search: { area: "Saved A area" } })));
  try {
    // Synthetic option represents a client picker already available while boot is pending.
    for (const prefix of ["plan", "space"]) { const option = app.doc.createElement("option"); option.value = clientB; app.doc.querySelector(`#${prefix}-client`).append(option); app.change(`#${prefix}-client`, clientB); }
    await settle(); app.service.scope = "synthetic-scope"; boot.resolve([]); await app.view.ready;
    assert.equal(app.doc.querySelector("#plan-client").value, clientB); assert.equal(app.doc.querySelector("#space-client").value, clientB);
    assert.match(app.doc.querySelector("#plan-name").value, /Demo Practice B/); assert.notEqual(app.doc.querySelector("#space-area").value, "Saved A area");
  } finally { app.close(); }
});

test("failed initial prefill recovers untouched suggestions in both forms and preserves recovery edits", async () => {
  for (const prefix of ["plan", "space"]) {
    const recovery = deferred(); const app = harness({ client: async () => { throw new Error("Synthetic first-read outage"); } });
    try {
      await app.view.ready; app.change(`#${prefix}-client`, clientA); await settle();
      assert.match(app.doc.querySelector(prefix === "plan" ? "#plan-message" : "#space-message").textContent, /unavailable/);
      app.service.client = () => recovery.promise; const pending = app.view.refresh(); await settle();
      app.change(`#${prefix}-area`, "Typed during recovery"); app.change(`#${prefix}-use`, "");
      recovery.resolve(record(clientA)); await pending;
      assert.equal(app.doc.querySelector(`#${prefix}-area`).value, "Typed during recovery"); assert.equal(app.doc.querySelector(`#${prefix}-use`).value, "");
      if (prefix === "plan") {
        assert.equal(app.doc.querySelector("#plan-name").value, "Demo Practice A · Tour"); assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
        app.doc.querySelector("#plan-undo").click(); assert.equal(app.doc.querySelector("#plan-notes").value, "");
        app.service.client = async id => record(id); await app.view.refresh(); assert.equal(app.doc.querySelector("#plan-notes").value, "");
      } else {
        // A second selection has no user overrides and receives the missed initial suggestions.
        app.service.client = async () => { throw new Error("Synthetic outage"); }; app.change("#space-client", clientB); await settle();
        app.service.client = async id => record(id); await app.view.refresh();
        assert.equal(app.doc.querySelector("#space-area").value, "Demo City, FL"); assert.equal(app.doc.querySelector("#space-use").value, "Demo specialty");
        app.doc.querySelector("#space-undo").click(); await app.view.refresh(); assert.equal(app.doc.querySelector("#space-use").value, "");
      }
    } finally { app.close(); }
  }
});

test("popup displays the newest producer route that Edit itinerary opens, not accepted history", async () => {
  const latest = { property_name: "Current draft property", property_address: "Synthetic latest address" };
  const historical = { property_name: "Historical accepted property", property_address: "Synthetic old address" };
  const app = harness({ tour: async id => ({ id, name: "Versioned tour", route_version_id: clientB, route_version_state: "draft", accepted_route_version: 1, stops: [latest], routes: [{ id: clientB, route_version: 2, accepted: false, stops: [latest] }, { id: clientA, route_version: 1, accepted: true, stops: [historical] }] }) });
  try {
    await app.view.ready; app.doc.querySelector(".tour-button").click(); await settle();
    assert.match(app.doc.querySelector("#detail-content").textContent, /Current draft property/); assert.doesNotMatch(app.doc.querySelector("#detail-content").textContent, /Historical accepted property/);
    assert.match(app.doc.querySelector("#detail-content a").href, new RegExp(`route-editor.html\\?tour=${clientA}`));
  } finally { app.close(); }
});

test("search storage failure reports tab-only outcome in the search form without claiming success", async () => {
  const app = harness({}, window => { window.Storage.prototype.setItem = () => { throw new Error("Synthetic quota or disabled storage"); }; });
  try {
    await app.view.ready; app.change("#space-area", "Synthetic research area"); app.doc.querySelector("#save-search").click();
    assert.doesNotMatch(app.doc.querySelector("#space-message").textContent, /saved/i); assert.match(app.doc.querySelector("#space-message").textContent, /stays in this tab/i);
    assert.equal(app.doc.querySelector("#plan-message").textContent, "");
    assert.equal(app.doc.querySelector("#space-area").value, "Synthetic research area");
  } finally { app.close(); }
});
test("search without an established session scope does not claim persistence", async () => {
  const app = harness({ scope: null, library: async () => { throw new Error("Synthetic boot outage"); } });
  try {
    await app.view.ready; app.change("#space-area", "Synthetic research area"); app.doc.querySelector("#save-search").click();
    assert.doesNotMatch(app.doc.querySelector("#space-message").textContent, /saved/i); assert.match(app.doc.querySelector("#space-message").textContent, /stays in this tab/i);
    assert.equal(app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1"), null);
  } finally { app.close(); }
});

test("adapter rejects malformed list members and consumed detail shapes", async () => {
  let body = { tours: [null] }; const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
  await assert.rejects(api.library(), /Invalid/);
  body = { id: clientA, stops: [null] }; await assert.rejects(api.tour(clientA), /Invalid/);
  body = { id: clientA, stops: [], routes: [null] }; await assert.rejects(api.tour(clientA), /Invalid/);
  body = { tours: [{ id: clientA, status: {} }] }; await assert.rejects(api.library(), /Invalid/);
  body = { rows: [null], page: 1, page_count: 1 }; await assert.rejects(api.clients(), /Invalid/);
});
test("repeated malformed detail remains unavailable and never becomes current", async () => {
  const app = harness({ tour: async id => ({ id, stops: [null] }) });
  try {
    await app.view.ready; app.doc.querySelector(".tour-button").click(); await settle();
    assert.match(app.doc.querySelector("#detail-message").textContent, /unavailable/);
    await app.view.refresh(); await app.view.refresh();
    assert.match(app.doc.querySelector("#detail-message").textContent, /unavailable/);
    assert.equal(app.doc.querySelector(".freshness").classList.contains("current"), false); assert.equal(app.doc.querySelector("#detail-content a"), null);
    app.service.tour = async id => ({ id, stops: [] }); await app.view.refresh();
    assert.equal(app.doc.querySelector("#detail-message").textContent, ""); assert.ok(app.doc.querySelector("#detail-content a"));
  } finally { app.close(); }
});
test("malformed library is handled as a failed read and recovery renders valid rows", async () => {
  const app = harness({ library: async () => [null] });
  try {
    await app.view.ready; assert.match(app.doc.querySelector("#tour-library-state").textContent, /unavailable/); assert.equal(app.doc.querySelector(".freshness").classList.contains("current"), false);
    app.service.library = async () => [{ id: clientA, name: "Recovered list", status: "draft" }]; await app.view.refresh(); assert.match(app.doc.querySelector("#upcoming-tours").textContent, /Recovered list/);
  } finally { app.close(); }
});
test("failed DOM rendering does not cache the detail as successfully rendered", async () => {
  const app = harness();
  try {
    await app.view.ready; const body = app.doc.querySelector("#detail-content"), append = body.append;
    body.append = () => { throw new Error("Synthetic renderer failure"); }; app.doc.querySelector(".tour-button").click(); await settle();
    assert.match(app.doc.querySelector("#detail-message").textContent, /unavailable/);
    body.append = append; await app.view.refresh();
    assert.ok(app.doc.querySelector("#detail-content a")); assert.equal(app.doc.querySelector("#detail-message").textContent, "");
  } finally { app.close(); }
});

test("authentication recovery cannot resurrect a saved private draft that invalidation removed", async () => {
  const app = harness({}, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", JSON.stringify({ scope: "synthetic-scope", planClient: clientA, plan: { name: "Saved private A" } })));
  try {
    await app.view.ready; assert.equal(app.doc.querySelector("#plan-name").value, "Saved private A");
    app.service.scope = null; await app.view.refresh(); app.service.scope = "synthetic-scope"; await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-name").value, ""); assert.equal(app.doc.querySelector("#plan-client").value, "");
  } finally { app.close(); }
});
test("first-read HTTP refusal clears an unscoped edit while boot transport outages remain recoverable", async () => {
  const held = deferred(); const api = createPlannerClient({ fetchImpl: () => held.promise }); const app = harness(api);
  try {
    app.change("#plan-name", "Private typed during boot"); held.resolve({ ok: false, status: 401 }); await app.view.ready;
    assert.equal(app.doc.querySelector("#plan-name").value, ""); assert.match(app.doc.querySelector("#tour-library-state").textContent, /sign in/i);
  } finally { app.close(); }
  const outage = harness({ scope: null, library: async () => { throw new Error("Synthetic transport outage"); } });
  try { await outage.view.ready; assert.match(outage.doc.querySelector("#tour-library-state").textContent, /temporarily unavailable/i); } finally { outage.close(); }
});

test("caller cancellation prevents late decoding from changing the authenticated session", async () => {
  const late = deferred(); let body = { csrf_token: "synthetic-A", data: { tours: [] } };
  const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: () => body }) });
  await api.library(); const original = api.scope, controller = new AbortController(); body = late.promise;
  const pending = api.library({ signal: controller.signal }); await settle(); controller.abort();
  late.resolve({ csrf_token: "synthetic-B", data: { tours: [] } });
  await assert.rejects(pending, error => error.code === "read_timeout"); await settle(); assert.equal(api.scope, original);
});

test("explicitly entered suggestion text becomes an override even when its value is unchanged", () => {
  const draft = createDraft(PLAN_FIELDS); draft.suggest({ area: "Demo area" });
  draft.set("area", "Demo area"); draft.refreshSuggestions({ area: "New source area" });
  assert.equal(draft.values.area, "Demo area");
});

test('QA-019 packet review retains the client access failure explanation', async () => {
  const app = sessionHarness();
  try {
    await app.view.ready;
    app.refuse(); await app.view.refresh();
    assert.equal(app.doc.querySelector('#plan-message').textContent,'Sign in to continue.');
    app.doc.querySelector('#review-packet').click();
    assert.equal(app.doc.querySelector('#plan-message').textContent,'Sign in to continue.');
  } finally {app.close();}
});

test('QA-019 review guidance while clients load clears when the picker becomes ready', async () => {
  const clients = deferred(); const app = harness({clients:()=>clients.promise});
  try {
    await settle();
    app.doc.querySelector('#review-packet').click();
    assert.match(app.doc.querySelector('#plan-message').textContent,/loading/);
    clients.resolve([record(clientA)]); await app.view.ready;
    assert.equal(app.doc.querySelector('#plan-client').options.length,2);
    assert.equal(app.doc.querySelector('#plan-message').textContent,'');
  } finally {app.close();}
});
