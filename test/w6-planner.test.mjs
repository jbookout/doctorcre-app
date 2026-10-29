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
    const link = app.doc.querySelector('#detail-content a[href^="/tours/day.html"]');
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

test("packet review retains every search constraint for the exact client without asking again", async () => {
  const app = harness();
  try {
    await app.view.ready;
    app.change("#space-client", clientA); await settle();
    const criteria = { area: "Synthetic region", use: "Synthetic specialty", minSize: "2100", maxSize: "3500", budget: "28", rentBasis: "sf_year", transaction: "Lease", availableBy: "2027-02-01", parking: "12 spaces", requirements: "Ground floor <script>inert</script>" };
    for (const [field, value] of Object.entries(criteria)) app.change(`#space-${field}`, value);
    app.change("#plan-client", clientA); await settle();
    app.doc.querySelector("#plan-form").dispatchEvent(new app.dom.window.Event("submit", { cancelable: true }));
    const section = app.doc.querySelector('#packet-search-criteria');
    assert.ok(section, "packet includes the search draft");
    assert.deepEqual([...section.querySelectorAll("dd")].map(node => node.textContent), ["Synthetic region", "Synthetic specialty", "2100", "3500", "28", "$/SF/year", "Lease", "2027-02-01", "12 spaces", "Ground floor <script>inert</script>"]);
    assert.match(section.textContent, /this tab/);
    assert.equal(section.querySelector("script"), null);
  } finally { app.close(); }
});

test("Plan from search selects the exact subject and keeps another client's plan independent", async () => {
  const app = harness();
  try {
    await app.view.ready;
    app.change("#plan-client", clientB); await settle(); app.change("#plan-notes", "Synthetic B itinerary notes");
    app.change("#space-client", clientA); await settle();
    app.change("#space-area", "Synthetic A region"); app.change("#space-minSize", "2400");
    const action = app.doc.querySelector("#plan-from-search");
    assert.ok(action, "search offers a path to planning"); action.click(); await settle();
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic A region");
    assert.equal(app.doc.activeElement.id, "plan-name");
    app.doc.querySelector("#review-packet").click();
    assert.match(app.doc.querySelector("#packet-search-criteria").textContent, /2400/);
    app.doc.querySelector("#detail-close").click();
    app.change("#plan-client", clientB); await settle();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic B itinerary notes");
  } finally { app.close(); }
});

test("Research carries search location without a client and invalid criteria leave the plan intact", async () => {
  const app = harness({ clients: async () => { throw new Error("offline"); } });
  try {
    await app.view.ready;
    app.change("#space-area", "Synthetic Research region"); app.change("#space-use", "Synthetic lab");
    app.doc.querySelector("#plan-from-search").click();
    assert.equal(app.doc.querySelector("#plan-purpose").value, "research");
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic Research region");
    assert.equal(app.doc.querySelector("#plan-use").value, "Synthetic lab");
    app.doc.querySelector("#review-packet").click();
    assert.equal(app.doc.querySelector("dialog").open, true);
    assert.match(app.doc.querySelector("#packet-search-criteria").textContent, /Synthetic lab/);
    app.doc.querySelector("#detail-close").click();
    app.change("#plan-notes", "Synthetic retained notes");
    app.change("#space-minSize", "3000"); app.change("#space-maxSize", "2000");
    app.doc.querySelector("#plan-from-search").click();
    assert.match(app.doc.querySelector("#space-message").textContent, /Maximum/);
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic retained notes");
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic Research region");
  } finally { app.close(); }
});

test("Plan from search preserves private packet files when the plan already has that exact subject", async () => {
  const app = harness();
  try {
    await app.view.ready; app.change("#space-client", clientA); await settle();
    app.doc.querySelector("#plan-from-search").click(); await settle();
    const file = new app.dom.window.File(["synthetic packet bytes"], "synthetic-packet.txt");
    Object.defineProperty(app.doc.querySelector("#packet-upload"), "files", { value: [file], configurable: true });
    app.doc.querySelector("#packet-upload").dispatchEvent(new app.dom.window.Event("change"));
    app.change("#plan-notes", "Synthetic itinerary note");
    app.change("#space-minSize", "2600");
    app.doc.querySelector("#plan-from-search").click(); await settle();
    assert.equal(app.view.files.length, 1);
    app.doc.querySelector("#review-packet").click();
    assert.match(app.doc.querySelector("#detail-content").textContent, /synthetic-packet.txt/);
    assert.match(app.doc.querySelector("#detail-content").textContent, /Synthetic itinerary note/);
    assert.match(app.doc.querySelector("#packet-search-criteria").textContent, /2600/);
  } finally { app.close(); }
});

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
test("client lookup reads one producer page with an encoded search and verifies identity", async () => {
  const calls = []; const api = createPlannerClient({ fetchImpl: async path => {
    calls.push(path); return { ok: true, json: async () => path.includes(clientA) ? { record: record(clientB) } : { page: Number(new URL(path, "https://example.test").searchParams.get("page")), page_count: 2, rows: [record(clientA)] } };
  } });
  assert.equal((await api.clients({ query: "Demo & Harbor" })).length, 1); assert.equal(calls.length, 1);
  assert.match(calls[0], /scope=team&sort=name&page=1/); assert.equal(new URL(calls[0], "https://example.test").searchParams.get("q"), "Demo & Harbor");
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
    unavailable = true; app.doc.querySelector("#plan-client-find").click();
    await waitFor(() => /unavailable/.test(app.doc.querySelector("#plan-message").textContent));
    await app.view.refresh();
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
  const withheld = [...doc.querySelectorAll(".widget-actions button[disabled]")];
  assert.equal(withheld.length, 1);
  for (const button of withheld) {
    const reason = doc.getElementById(button.getAttribute("aria-describedby") || "");
    assert.match(reason?.textContent || "", /\bnot connected\b/, "a withheld action says why in words");
  }
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

for (const first of ["library", "clients"]) test(`initial ${first}-first reads preserve the producer's distinct response envelopes`, async () => {
  const libraryResponse = deferred(), clientsResponse = deferred();
  let clientReads = 0;
  const stale = { ...record(clientA), name: "Before scope was established" };
  const current = { ...record(clientA), name: "Current scoped client" };
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: true,
    json: () => path.includes("library") ? libraryResponse.promise : ++clientReads === 1
      ? clientsResponse.promise : { page: 1, page_count: 1, rows: [current] },
  }) });
  const library = api.library(), clients = api.clients();
  if (first === "library") {
    libraryResponse.resolve({ csrf_token: "synthetic-A", data: { tours: [] } });
    await library;
    clientsResponse.resolve({ page: 1, page_count: 1, rows: [stale] });
    assert.deepEqual(await clients, [current]);
    assert.equal(clientReads, 2);
  } else {
    clientsResponse.resolve({ page: 1, page_count: 1, rows: [stale] });
    assert.deepEqual(await clients, [stale]);
    libraryResponse.resolve({ csrf_token: "synthetic-A", data: { tours: [] } });
    await library;
    assert.equal(clientReads, 1);
  }
  assert.ok(api.scope);
});

test("known-scope client answers cannot cross an account transition", async () => {
  const pendingClients = deferred(); let token = "synthetic-A", clientReads = 0;
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: true, json: () => {
      if (path.includes("library")) return { csrf_token: token, data: { tours: [] } };
      clientReads++; return pendingClients.promise;
    },
  }) });
  await api.library();
  const clients = api.clients();
  token = "synthetic-B"; await api.library();
  const scopeB = api.scope;
  pendingClients.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await assert.rejects(clients, /Session superseded/);
  assert.equal(api.scope, scopeB); assert.equal(clientReads, 1);
});

test("the initial client re-read still refuses a later account transition", async () => {
  const unscoped = deferred(), scoped = deferred(), rereadStarted = deferred();
  let token = "synthetic-A", clientReads = 0;
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: true, json: () => {
      if (path.includes("library")) return { csrf_token: token, data: { tours: [] } };
      if (++clientReads === 1) return unscoped.promise;
      rereadStarted.resolve(); return scoped.promise;
    },
  }) });
  const clients = api.clients(); await api.library();
  unscoped.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await rereadStarted.promise;
  token = "synthetic-B"; await api.library(); const scopeB = api.scope;
  scoped.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await assert.rejects(clients, /Session superseded/);
  assert.equal(api.scope, scopeB); assert.equal(clientReads, 2);
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

test('saved tours open while the client directory is unresolved', async () => {
  const pending = deferred(), detail = deferred(), reload = deferred();
  let reads = 0, opened = false;
  // Before the tour is opened the only detail reads are the Next tour eligibility probes.
  const app = harness({ clients: () => pending.promise, tour: () => !opened ? Promise.reject(new Error('probe')) : ++reads === 1 ? detail.promise : reload.promise });
  try {
    await settle(); await settle();
    assert.equal(app.doc.querySelectorAll('.tour-button').length, 2);
    opened = true; app.doc.querySelector('.tour-button').click(); await settle();
    pending.resolve([]); await settle(); await settle();
    detail.resolve({ id: clientA, name: 'Demo tour', stops: [] }); await settle();
    assert.equal(app.doc.querySelector('#detail-title').textContent, 'Demo tour');
    assert.equal(app.doc.querySelector('dialog').open, true);
  } finally { pending.resolve([]); detail.resolve({ id: clientA, name: 'Demo tour', stops: [] }); reload.resolve({ id: clientA, name: 'Demo reload', stops: [] }); await app.view.ready; app.close(); }
});


test("library refresh retains bounded choices and refreshes only selected client details", async () => {
  let choices = 0; const details = [];
  const app = harness({ clients: async () => { choices++; return [record(clientA), record(clientB)]; }, client: async id => { details.push(id); return record(id); } });
  try {
    await app.view.ready; app.change("#plan-client", clientA); app.change("#space-client", clientA); await settle();
    details.length = 0; await app.view.refresh(); await app.view.refresh();
    assert.equal(choices, 1); assert.deepEqual(details, [clientA, clientA]);
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#space-client").value, clientA);
  } finally { app.close(); }
});

test("bounded client search retains selection and reports loading, empty and recovery states", async () => {
  const pending = deferred(); const queries = [];
  const app = harness();
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.change("#plan-name", "Typed tour");
    app.service.clients = ({ query }) => { queries.push(query); return pending.promise; };
    app.change("#space-client-query", "Harbor"); app.doc.querySelector("#space-client-find").click();
    assert.match(app.doc.querySelector("#plan-client-state").textContent, /loading/i);
    assert.equal(app.doc.querySelector("#plan-client-query").value, "Harbor");
    pending.resolve([]); await waitFor(() => /No clients/.test(app.doc.querySelector("#space-client-state").textContent));
    assert.deepEqual(queries, ["Harbor"]); assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#plan-name").value, "Typed tour");
    app.service.clients = async () => { throw Error("Synthetic outage"); };
    app.doc.querySelector("#plan-client-find").click();
    await waitFor(() => /unavailable/.test(app.doc.querySelector("#plan-client-state").textContent));
    app.service.clients = async () => [record(clientB)]; await app.view.refresh();
    assert.equal(app.doc.querySelector(`#space-client option[value="${clientB}"]`).textContent, "Demo Practice B");
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#plan-name").value, "Typed tour");
  } finally { app.close(); }
});


test("account change clears cached client choices and rejects a delayed search", async () => {
  const pending = deferred(); const app = sessionHarness();
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.service.clients = () => pending.promise;
    app.change("#plan-client-query", "Private A"); app.doc.querySelector("#plan-client-find").click();
    app.session("synthetic-B"); app.doc.querySelector(".tour-button").click();
    await waitFor(() => app.doc.querySelectorAll(".tour-button").length === 0);
    pending.resolve([record(clientA)]); await settle();
    assert.equal(app.doc.querySelector("#plan-client-query").value, "");
    assert.equal(app.doc.querySelector("#space-client-query").value, "");
    assert.equal(app.doc.querySelectorAll("#plan-client option").length, 1);
    assert.equal(app.doc.querySelector("#plan-name").value, "");
    app.service.clients = async () => [record(clientB)]; await app.view.refresh();
    assert.equal(app.doc.querySelectorAll(`#plan-client option[value="${clientA}"]`).length, 0);
    assert.equal(app.doc.querySelector(`#plan-client option[value="${clientB}"]`).textContent, "Demo Practice B");
  } finally { pending.resolve([]); app.close(); }
});

test("clients-first boot restores both saved client selections when the session arrives", async () => {
  const library = deferred();
  const app = harness({ scope: null, library: () => library.promise }, window => {
    window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", JSON.stringify({ scope: "synthetic-scope", planClient: clientA, searchClient: clientB, plan: { name: "Saved tour" }, search: { area: "Saved area" } }));
  });
  try {
    await waitFor(() => app.doc.querySelectorAll("#plan-client option").length === 3);
    app.service.scope = "synthetic-scope"; library.resolve([]); await app.view.ready;
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#space-client").value, clientB);
    assert.equal(app.doc.querySelector("#plan-name").value, "Saved tour");
    assert.equal(app.doc.querySelector("#space-area").value, "Saved area");
  } finally { library.resolve([]); app.close(); }
});

test("a pending client search cannot block selected-client or open-tour refresh", async () => {
  const pending = deferred(); const app = harness(); let refreshing;
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.doc.querySelector(".tour-button").click(); await settle();
    app.service.clients = () => pending.promise;
    app.doc.querySelector("#plan-client-find").click();
    app.service.client = async id => ({ ...record(id), notes: "Newest selected client notes" });
    app.service.tour = async id => ({ id, name: "Newest open tour", stops: [] });
    refreshing = app.view.refresh();
    await waitFor(() => app.doc.querySelector("#detail-title").textContent === "Newest open tour");
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    assert.match(app.doc.querySelector("#plan-client-updates").textContent, /Newest selected client notes/);
    assert.equal(app.doc.querySelector("dialog").open, true);
  } finally { pending.resolve([]); await refreshing; app.close(); }
});

test("T02 Research reviews a packet without a client during a client-list outage", async () => {
  const app = harness({ clients: async () => { throw Error("Synthetic outage"); } });
  try {
    await app.view.ready;
    const purpose = app.doc.querySelector("#plan-purpose");
    assert.ok(purpose, "tour planning offers an explicit Research purpose");
    purpose.value = "research"; purpose.dispatchEvent(new app.dom.window.Event("change"));
    app.change("#plan-name", "Synthetic research tour");
    app.doc.querySelector("#review-packet").click();
    assert.equal(app.doc.querySelector("#tour-dialog").open, true);
    assert.equal(app.doc.querySelector("#detail-title").textContent, "Synthetic research tour");
    assert.match(app.doc.querySelector("#detail-content").textContent, /Research/);
    assert.equal(app.doc.querySelector("#plan-client").value, "");
    assert.equal(app.doc.querySelector("#plan-client-picker").hidden, true);
  } finally { app.close(); }
});

test("T02 returning to a client restores its search criteria and Research stays independent", async () => {
  const app = harness();
  try {
    await app.view.ready;
    app.change("#space-area", "Synthetic research region");
    app.change("#space-client", clientA); await settle();
    app.change("#space-area", "Synthetic client A region"); app.change("#space-minSize", "2100");
    app.change("#space-requirements", "Synthetic ground floor requirement");
    app.change("#space-client", clientB); await settle(); app.change("#space-area", "Synthetic client B region");
    app.change("#space-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#space-area").value, "Synthetic client A region");
    assert.equal(app.doc.querySelector("#space-minSize").value, "2100");
    assert.equal(app.doc.querySelector("#space-requirements").value, "Synthetic ground floor requirement");
    app.change("#space-client", ""); await settle();
    assert.equal(app.doc.querySelector("#space-area").value, "Synthetic research region");
    const stored = app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1");
    const reloaded = harness({}, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", stored));
    try {
      await reloaded.view.ready; reloaded.change("#space-client", clientA); await settle();
      assert.equal(reloaded.doc.querySelector("#space-area").value, "Synthetic client A region");
      assert.equal(reloaded.doc.querySelector("#space-minSize").value, "2100");
      reloaded.service.scope = "other-session"; await reloaded.view.refresh();
      reloaded.change("#space-client", clientA); await settle();
      assert.equal(reloaded.doc.querySelector("#space-minSize").value, "");
    } finally { reloaded.close(); }
  } finally { app.close(); }
});

test("T02 selecting a known client carries its saved search area into the plan without asking twice", async () => {
  const app = harness();
  try {
    await app.view.ready; app.change("#space-client", clientA); await settle();
    app.change("#space-area", "Synthetic preferred region"); app.change("#space-use", "Synthetic saved space type");
    app.change("#plan-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic preferred region");
    assert.equal(app.doc.querySelector("#plan-use").value, "Synthetic saved space type");
    app.change("#plan-name", "Synthetic edited tour");
    app.change("#plan-client", clientB); await settle(); app.change("#plan-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#plan-name").value, "Synthetic edited tour");
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic preferred region");
  } finally { app.close(); }
});

test("T02 a failed client detail read keeps selection and retries without erasing edits or files", async () => {
  let unavailable = true;
  const app = harness({ client: async id => { if (unavailable) throw Error("Synthetic outage"); return record(id); } });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.change("#plan-name", "Synthetic retained tour"); stageFile(app);
    app.doc.querySelector("#review-packet").click();
    assert.equal(app.doc.querySelector("#tour-dialog").open, false, "unloaded client cannot be reviewed as if ready");
    assert.match(app.doc.querySelector("#plan-message").textContent, /Client details temporarily unavailable/);
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    const retry = app.doc.querySelector("#plan-client-retry");
    assert.ok(retry); assert.equal(retry.hidden, false);
    unavailable = false; retry.click(); await settle();
    assert.equal(app.doc.querySelector("#plan-name").value, "Synthetic retained tour");
    assert.equal(app.view.files.length, 1); assert.equal(retry.hidden, true);
    app.doc.querySelector("#review-packet").click();
    assert.equal(app.doc.querySelector("#tour-dialog").open, true);
    assert.match(app.doc.querySelector("#detail-content").textContent, /Synthetic original entry/);
  } finally { app.close(); }
});

test("T02 client search preferences and deliberately cleared fields survive refresh and reselection", async () => {
  const app = harness();
  try {
    await app.view.ready; app.change("#space-client", clientA); await settle();
    app.change("#space-area", "Synthetic preferred region"); app.change("#space-use", "");
    app.change("#plan-client", clientA); await settle(); await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic preferred region");
    app.change("#space-client", clientB); await settle(); app.change("#space-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#space-use").value, "", "a deliberate blank is not filled again");
  } finally { app.close(); }
});

test("T02 a cleared plan field is not filled again from the saved search after switching or reload", async () => {
  const app = harness();
  try {
    await app.view.ready; app.change("#space-client", clientA); await settle();
    app.change("#space-area", "Synthetic saved region"); app.change("#plan-client", clientA); await settle();
    app.change("#plan-area", ""); app.change("#plan-client", clientB); await settle();
    app.change("#plan-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#plan-area").value, "");
    const stored = app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1");
    const reloaded = harness({}, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", stored));
    try { await reloaded.view.ready; assert.equal(reloaded.doc.querySelector("#plan-area").value, ""); }
    finally { reloaded.close(); }
  } finally { app.close(); }
});

test("T02 retry refreshes prior client suggestions while preserving typed fields", async () => {
  let unavailable = false, notes = "Synthetic prior notes";
  const app = harness({ client: async id => { if (unavailable) throw Error("Synthetic outage"); return { ...record(id), notes }; } });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.change("#plan-name", "Synthetic typed tour");
    unavailable = true; await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic prior notes");
    notes = "Synthetic refreshed notes"; unavailable = false;
    app.doc.querySelector("#plan-client-retry").click(); await settle();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic prior notes");
    app.doc.querySelector('#plan-client-updates [data-field="notes"] [data-choice="use"]').click();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic refreshed notes");
    assert.equal(app.doc.querySelector("#plan-name").value, "Synthetic typed tour");
  } finally { app.close(); }
});

for (const reload of [false, true]) test(`T02 managed suggestions refresh after client reselection${reload ? " and reload" : ""} while typed overrides survive`, async () => {
  let notes = "Synthetic original notes";
  let app = harness({ client: async id => ({ ...record(id), notes }) });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#plan-notes").value, notes);
    app.change("#plan-name", "Synthetic typed override");
    app.change("#plan-client", clientB); await settle();
    notes = "Synthetic updated notes";
    app.change("#plan-client", clientA); await settle();
    if (reload) {
      const stored = app.dom.window.sessionStorage.getItem("doctorcre-tour-planning-drafts-v1");
      app.close();
      app = harness({ client: async id => ({ ...record(id), notes }) }, window => window.sessionStorage.setItem("doctorcre-tour-planning-drafts-v1", stored));
      await app.view.ready;
      notes = "Synthetic notes after reload";
    }
    await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original notes");
    app.doc.querySelector('#plan-client-updates [data-field="notes"] [data-choice="use"]').click();
    assert.equal(app.doc.querySelector("#plan-notes").value, notes);
    assert.equal(app.doc.querySelector("#plan-name").value, "Synthetic typed override");
    app.change("#plan-notes", "Synthetic typed notes");
    app.change("#plan-client", clientB); await settle();
    notes = "Synthetic newest source notes";
    app.change("#plan-client", clientA); await settle(); await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic typed notes");
  } finally { app.close(); }
});

for (const existing of ["first selection", "managed suggestion", "explicit edit"]) test(`T02 Search cleared fields survive Plan prefill and refresh with ${existing}`, async () => {
  const app = harness();
  try {
    await app.view.ready;
    if (existing !== "first selection") {
      app.change("#plan-client", clientA); await settle();
      if (existing === "explicit edit") app.change("#plan-use", "Synthetic plan override");
      app.change("#plan-client", clientB); await settle();
    }
    app.change("#space-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#space-use").value, "Demo specialty");
    app.change("#space-use", "");
    app.change("#plan-client", clientA); await settle();
    const expected = existing === "explicit edit" ? "Synthetic plan override" : "";
    assert.equal(app.doc.querySelector("#space-use").value, "");
    assert.equal(app.doc.querySelector("#plan-use").value, expected);
    await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-use").value, expected);
    app.change("#plan-client", clientB); await settle(); app.change("#plan-client", clientA); await settle();
    assert.equal(app.doc.querySelector("#plan-use").value, expected);
  } finally { app.close(); }
});

test("client refresh explains changed draft fields and retains the brief on failure until retry", async () => {
  let current = record(clientA), failed = false;
  const app = harness({ client: async () => { if (failed) throw new Error("Synthetic unavailable"); return current; } });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    app.change("#plan-area", "Synthetic approved region");
    current = { ...current, city: "Synthetic updated city", notes: "Synthetic refreshed notes" };
    await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-area").value, "Synthetic approved region");
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    const updates = app.doc.querySelector("#plan-client-updates");
    assert.ok(updates, "refresh offers a review of changed fields");
    assert.match(updates.textContent, /Tour notes/);
    assert.match(updates.textContent, /Synthetic original entry/);
    assert.match(updates.textContent, /Synthetic refreshed notes/);
    assert.ok(updates.querySelector("time[datetime]"), "refresh time is explicit");
    updates.querySelector('[data-field="notes"] [data-choice="use"]').click();
    failed = true; await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic refreshed notes");
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    assert.equal(app.doc.querySelector("#plan-client-retry").hidden, false);
    failed = false; current = { ...current, notes: "Synthetic retry notes" };
    app.doc.querySelector("#plan-client-retry").click(); await settle();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic refreshed notes");
    assert.match(updates.textContent, /Synthetic retry notes/);
  } finally { app.close(); }
});

test("changed recorded client name needs a choice before replacing the suggested tour name", async () => {
  let current = record(clientA);
  const app = harness({ client: async id => id === clientA ? current : record(id) });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    current = { ...current, name: "Synthetic renamed practice", notes: "Synthetic fresh record notes" };
    await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-name").value, "Demo Practice A · Tour");
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    const compare = app.doc.querySelector("#plan-client-name-review");
    assert.equal(compare.hidden, false);
    assert.match(compare.textContent, /Demo Practice A · Tour/);
    assert.match(compare.textContent, /Synthetic renamed practice · Tour/);
    app.doc.querySelector("#use-client-name").click();
    assert.equal(app.doc.querySelector("#plan-name").value, "Synthetic renamed practice · Tour");
    assert.equal(compare.hidden, true);
    assert.equal(app.doc.querySelector("#plan-client").value, clientA);
    await app.view.refresh();
    assert.equal(compare.hidden, true);
    app.change("#plan-client", clientB); await settle();
    assert.equal(app.doc.querySelector("#plan-client-updates").hidden, true);
    assert.doesNotMatch(app.doc.querySelector("#plan-client-updates").textContent, /Synthetic fresh/);
  } finally { app.close(); }
});

test("refreshed client fields wait for individual choices in Plan and Search", async () => {
  let current = record(clientA);
  const app = harness({ client: async () => current });
  try {
    await app.view.ready;
    app.change("#space-client", clientA); await settle();
    app.change("#plan-client", clientA); await settle();
    current = { ...current, city: "New City", vertical: "New specialty", notes: "New notes" };
    await app.view.refresh();
    for (const prefix of ["plan", "space"]) {
      assert.equal(app.doc.querySelector(`#${prefix}-area`).value, "Demo City, FL");
      assert.equal(app.doc.querySelector(`#${prefix}-use`).value, "Demo specialty");
      const root = app.doc.querySelector(`#${prefix}-client-updates`);
      assert.match(root.textContent, /New City/);
      root.querySelector('[data-field="area"] [data-choice="use"]').click();
      root.querySelector('[data-field="use"] [data-choice="keep"]').click();
      assert.equal(app.doc.querySelector(`#${prefix}-area`).value, "New City, FL");
      assert.equal(app.doc.querySelector(`#${prefix}-use`).value, "Demo specialty");
    }
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    app.doc.querySelector('#plan-client-updates [data-field="notes"] [data-choice="use"]').click();
    assert.equal(app.doc.querySelector("#plan-notes").value, "New notes");
  } finally { app.close(); }
});

test("declining refreshed notes and editing a pending field preserve the draft", async () => {
  let current = record(clientA);
  const app = harness({ client: async () => current });
  try {
    await app.view.ready; app.change("#plan-client", clientA); await settle();
    current = { ...current, city: "New City", notes: "New notes" };
    await app.view.refresh();
    const root = app.doc.querySelector("#plan-client-updates");
    root.querySelector('[data-field="notes"] [data-choice="keep"]').click();
    app.change("#plan-area", "Partner edit");
    root.querySelector('[data-field="area"] [data-choice="use"]').click();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    assert.equal(app.doc.querySelector("#plan-area").value, "Partner edit");
    await app.view.refresh();
    assert.equal(app.doc.querySelector("#plan-notes").value, "Synthetic original entry");
    assert.equal(app.doc.querySelector("#plan-area").value, "Partner edit");
  } finally { app.close(); }
});

test("initially empty client fields wait for a choice on later reads", async () => {
  let current = { ...record(clientA), city: "", state: "", vertical: "", specialty: "", notes: "" };
  const app = harness({ client: async () => current });
  try {
    await app.view.ready;
    app.change("#space-client", clientA); await settle();
    app.change("#plan-client", clientA); await settle();
    current = { ...current, city: "New City", vertical: "New specialty", notes: "New notes" };
    await app.view.refresh();
    for (const prefix of ["plan", "space"]) {
      for (const field of ["area", "use"]) {
        assert.equal(app.doc.querySelector(`#${prefix}-${field}`).value, "");
        const row = app.doc.querySelector(`#${prefix}-client-updates [data-field="${field}"]`);
        assert.match(row.textContent, /Empty/);
        row.querySelector('[data-choice="use"]').click();
        assert.equal(app.doc.querySelector(`#${prefix}-${field}`).value, field === "area" ? "New City" : "New specialty");
      }
    }
    assert.equal(app.doc.querySelector("#plan-notes").value, "");
    const notes = app.doc.querySelector('#plan-client-updates [data-field="notes"]');
    assert.match(notes.textContent, /Empty/);
    notes.querySelector('[data-choice="use"]').click();
    assert.equal(app.doc.querySelector("#plan-notes").value, "New notes");
  } finally { app.close(); }
});
