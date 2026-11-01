import {onDialogClosed} from '../js/dialog-lifecycle.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from '../js/doc-context.js';
import { mountAutoRefresh, updatedLabel } from "../js/auto-refresh.mjs";
import { createPlannerClient, validateTourList, validateClientList, validateClientRecord, validateTourDetail } from "./planner-client.js";
import { cheatSheetText, tourDisplayName } from "./tour-format.js";
import { PLAN_FIELDS, SEARCH_FIELDS, createDraft, clientSuggestions, tourGroups, hasDayRoute, validateCriteria, addPrivateFiles } from "./planner-model.js";

// Each area button's market as a Census place point. Fort Walton / Destin uses the
// Fort Walton Beach place point. The map fits these five points.
const territoryAreas = [
  { key: "Mobile, AL", label: "Mobile", city: "Mobile", state: "AL" },
  { key: "Pensacola, FL", label: "Pensacola", city: "Pensacola", state: "FL" },
  { key: "Fort Walton Beach / Destin, FL", label: "Fort Walton / Destin", city: "Fort Walton Beach", state: "FL" },
  { key: "Panama City, FL", label: "Panama City", city: "Panama City", state: "FL" },
  { key: "Tallahassee, FL", label: "Tallahassee", city: "Tallahassee", state: "FL" },
];

export function mountPlanner({ document, window, api = createPlannerClient() }) {
  const $ = selector => document.querySelector(selector);
  const plan = createDraft(PLAN_FIELDS), search = createDraft(SEARCH_FIELDS);
  let clientsStatus = "pending", clientsMessage = "", clients = [], tours = [], files = [], planClient = "", searchClient = "", planEpoch = 0, searchEpoch = 0, dialogEpoch = 0, refreshEpoch = 0;
  let pendingClientName = null;
  let clientQuery = "", clientsEpoch = 0, planPurpose = "client";
  let currentTour = null, selectedRecord = null, scope = null, scopeEstablished = false, disposed = false, territory = null, territoryLoading = false;
  const key = "doctorcre-tour-planning-drafts-v1";
  const drafts = { plan: new Map(), space: new Map() };
  const clientDetails = { plan: "idle", space: "idle" };
  function setClientDetails(prefix, status) {
    clientDetails[prefix] = status;
    $(`#${prefix}-client-retry`).hidden = status !== "failed";
  }
  function subjectKey(prefix) {
    if (prefix === "space") return searchClient || "research";
    return planPurpose === "research" ? "research" : planClient || "client";
  }
  function rememberDrafts() {
    drafts.plan.set(subjectKey("plan"), { values: plan.values, clearedFields: plan.clearedFields });
    drafts.space.set(subjectKey("space"), { values: search.values, clearedFields: search.clearedFields });
  }
  const clientsUnavailable = "Clients temporarily unavailable. Refresh tours to try again.";
  const clientsLoading = "Clients are loading. Wait, then review again.";
  // Capture restoration input before an edit can persist a partial boot draft.
  let savedDraft = null;
  try { savedDraft = JSON.parse(window.sessionStorage.getItem(key)); } catch { /* Disabled or invalid storage. */ }
  const message = (selector, text) => { $(selector).textContent = text; };
  const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const option = (text, value) => { const node = element("option", text); node.value = value; return node; };
  function save(target) {
    restoreOrClear();
    let outcome = "Draft stays in this tab. Sign in to save.";
    if (scope) {
      rememberDrafts();
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ scope, planPurpose, planClient, searchClient, drafts: { plan: [...drafts.plan], space: [...drafts.space] }, plan: plan.values, search: search.values }));
        return true;
      } catch { outcome = "Draft stays in this tab."; }
    }
    if (target) message(target, outcome);
    return false;
  }
  function restoreOrClear(refused = false) {
    if (!refused && api.scope === scope) return;
    const first = !scopeEstablished && !refused; scope = api.scope; scopeEstablished = true;
    if (!first) {
      pageDocContext?.clear();
      ++clientsEpoch; clientQuery = "";
      for (const prefix of ["plan", "space"]) { $(`#${prefix}-client-query`).value = ""; $(`#${prefix}-client-state`).textContent = ""; }
      ++refreshEpoch; ++planEpoch; ++searchEpoch; ++dialogEpoch; planClient = ""; searchClient = ""; files = []; selectedRecord = null;
      for (const prefix of ["plan", "space"]) { $(`#${prefix}-client-updates`).hidden = true; $(`#${prefix}-client-updates`).replaceChildren(); }
      clearNameReview();
      savedDraft = null; drafts.plan.clear(); drafts.space.clear(); setClientDetails("plan", "idle"); setClientDetails("space", "idle"); planPurpose = "client"; clientsStatus = scope ? "pending" : "unavailable"; clientsMessage = scope ? "" : "Sign in to continue."; clients = []; tours = []; plan.reset(); search.reset(); closeDialog();
      $("#detail-content").replaceChildren(); renderedTour = null; message("#detail-title", "Tour"); message("#detail-message", ""); $("#tour-filter").value = ""; renderLibrary(); renderFiles();
      try { window.sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
      for (const target of ["#plan-message", "#space-message", "#tour-library-state"]) message(target, scope ? "Session changed. New draft started." : "Sign in to continue.");
      message("#planner-updated", "Unavailable");
      $(".freshness").classList.remove("current");
    } else if (scope) {
      try {
        if (savedDraft?.scope === scope) {
          for (const prefix of ["plan", "space"]) {
            for (const entry of Array.isArray(savedDraft.drafts?.[prefix]) ? savedDraft.drafts[prefix] : []) {
              if (!Array.isArray(entry) || typeof entry[0] !== "string" || !["client", "research"].includes(entry[0]) && !/^[0-9a-f-]{36}$/i.test(entry[0])) continue;
              const fields = prefix === "plan" ? PLAN_FIELDS : SEARCH_FIELDS;
              const values = Object.fromEntries(fields.filter(field => typeof entry[1]?.values?.[field] === "string").map(field => [field, entry[1].values[field]]));
              const clearedFields = fields.filter(field => Array.isArray(entry[1]?.clearedFields) && entry[1].clearedFields.includes(field));
              drafts[prefix].set(entry[0], { values, clearedFields });
            }
          }
          if (planEpoch === 0) { planPurpose = savedDraft.planPurpose === "research" ? "research" : "client"; planClient = planPurpose === "client" ? savedDraft.planClient || "" : ""; plan.restore(savedDraft.plan); }
          if (searchEpoch === 0) { searchClient = savedDraft.searchClient || ""; search.restore(savedDraft.search); }
        }
      } catch { /* An invalid draft never selects another client's record. */ }
    }
    $("#plan-purpose").value = planPurpose; $("#plan-client-picker").hidden = planPurpose === "research";
    syncForm("plan", plan); syncForm("space", search); fillClients();
  }
  async function read(operation) {
    try { return await operation(); }
    catch (error) { if (error?.code === "authentication_required") restoreOrClear(true); throw error; }
    finally { restoreOrClear(); }
  }
  const unavailable = error => error?.code === "authentication_required" ? "Sign in to continue." : null;
  function settleClientMessage(prefix) {
    const target = `#${prefix}-message`;
    if (["Updating…", "Client details temporarily unavailable."].includes($(target).textContent)) message(target, "");
  }
  function syncForm(prefix, draft) {
    for (const [field, value] of Object.entries(draft.values)) {
      const control = $(`#${prefix}-${field}`);
      if (control.value !== value) control.value = value;
      if (field === "area") control.title = value;
    }
    if (prefix === "space") {
      for (const button of document.querySelectorAll(".market-buttons [data-market]")) button.setAttribute("aria-pressed", String(button.dataset.market === draft.values.area));
      territory?.select(draft.values.area);
    }
    $(`#${prefix}-undo`).disabled = !draft.canUndo;
  }
  function wireDraft(prefix, draft) {
    for (const field of Object.keys(draft.values)) $(`#${prefix}-${field}`).addEventListener("input", event => {
      const value = event.target.value;
      if (scope !== null) restoreOrClear();
      if (prefix === "plan" && field === "name") clearNameReview();
      draft.set(field, value); syncForm(prefix, draft); save(prefix === "plan" ? "#plan-message" : "#space-message");
    });
    $(`#${prefix}-undo`).addEventListener("click", () => {
      const field = draft.undo(); syncForm(prefix, draft); save(prefix === "plan" ? "#plan-message" : "#space-message");
      if (field) { $(`#${prefix}-${field}`).focus(); message(prefix === "plan" ? "#plan-message" : "#space-message", "Change undone."); }
    });
  }
  function fillClients() {
    for (const [prefix, selected, research] of [["plan", planClient, false], ["space", searchClient, true]]) {
      const select = $(`#${prefix}-client`);
      const selectedLabel = select.value === selected ? select.selectedOptions[0]?.textContent : null;
      select.replaceChildren(option(research ? "Research only" : "Choose a client", ""));
      for (const client of clients) select.append(option(client.name || "Unnamed client", client.id));
      // Retain the exact draft binding while the picker is filtered or temporarily unavailable.
      if (selected && !clients.some(client => client.id === selected)) select.append(option(selectedLabel || "Selected client", selected));
      select.value = selected;
    }
  }
  async function loadClients({ signal } = {}) {
    const epoch = ++clientsEpoch;
    const active = () => !disposed && epoch === clientsEpoch && !signal?.aborted;
    clientsStatus = "pending";
    for (const prefix of ["plan", "space"]) message(`#${prefix}-client-state`, "Clients are loading.");
    try {
      const rows = await read(async () => validateClientList(await api.clients({ query: clientQuery, signal })));
      if (!active()) return;
      clients = rows; clientsStatus = "ready"; clientsMessage = ""; fillClients();
      for (const prefix of ["plan", "space"]) {
        message(`#${prefix}-client-state`, rows.length ? "Showing up to 25 matches. Search to narrow choices." : "No clients match. Try another search.");
        const target = `#${prefix}-message`;
        if ($(target).textContent === clientsLoading || $(target).textContent.startsWith(clientsUnavailable)) message(target, "");
      }
    } catch (error) {
      if (!active()) return;
      clientsStatus = "unavailable"; clientsMessage = unavailable(error) || clientsUnavailable;
      for (const prefix of ["plan", "space"]) { message(`#${prefix}-client-state`, clientsMessage); message(`#${prefix}-message`, clientsMessage); }
      throw error;
    }
  }
  async function prefill(prefix, id, purpose = planPurpose) {
    restoreOrClear(); rememberDrafts();
    const epoch = prefix === "plan" ? ++planEpoch : ++searchEpoch;
    const draft = prefix === "plan" ? plan : search;
    if (prefix === "plan") { clearNameReview(); planPurpose = purpose; $("#plan-purpose").value = purpose; $("#plan-client-picker").hidden = purpose === "research"; planClient = id; selectedRecord = null; files = []; renderFiles(); } else searchClient = id;
    // A new record starts an independent draft, so previous-client criteria never migrate.
    $(`#${prefix}-client-updates`).hidden = true; $(`#${prefix}-client-updates`).replaceChildren();
    const saved = drafts[prefix].get(subjectKey(prefix));
    draft.reset(); draft.restore(saved?.values);
    if (prefix === "plan" && (id || purpose === "research")) {
      const brief = drafts.space.get(subjectKey("plan"));
      const values = Object.fromEntries(["area", "use"].filter(field => brief?.values[field] || brief?.clearedFields.includes(field)).map(field => [field, brief.values[field]]));
      draft.restore(values);
    }
    syncForm(prefix, draft); fillClients(); save(prefix === "plan" ? "#plan-message" : "#space-message");
    const target = prefix === "plan" ? "#plan-message" : "#space-message";
    if (!id) { setClientDetails(prefix, "idle"); message(target, ""); return; }
    return loadClientDetails(prefix, id, epoch, !saved);
  }
  async function loadClientDetails(prefix, id, epoch, newDraft = false) {
    const target = `#${prefix}-message`;
    setClientDetails(prefix, "loading"); message(target, "Updating…");
    try {
      const record = await read(async () => validateClientRecord(await api.client(id), id));
      if (disposed || epoch !== (prefix === "plan" ? planEpoch : searchEpoch) || record.id !== id) return;
      setClientDetails(prefix, "ready");
      applyClientRecord(prefix, record, newDraft); save(prefix === "plan" ? "#plan-message" : "#space-message");
      message(target, "");
    } catch (error) { if (!disposed && epoch === (prefix === "plan" ? planEpoch : searchEpoch)) { setClientDetails(prefix, "failed"); message(target, unavailable(error) || "Client details temporarily unavailable."); } }
  }
  function clearNameReview() {
    pendingClientName = null;
    $("#plan-client-name-review").hidden = true;
    $("#client-name-before").textContent = ""; $("#client-name-after").textContent = "";
  }
  function applyClientRecord(prefix, record, newDraft = false) {
    const draft = prefix === "plan" ? plan : search;
    const suggestions = clientSuggestions(record);
    if (newDraft) draft.prefill(suggestions);
    const before = draft.values;
    if (prefix === "plan") {
      clearNameReview();
      if (suggestions.name !== before.name) {
        pendingClientName = suggestions.name;
        $("#client-name-before").textContent = before.name || "Empty";
        $("#client-name-after").textContent = suggestions.name || "Empty";
        $("#plan-client-name-review").hidden = false;
      }
    }
    const changes = Object.entries(suggestions).filter(([field, value]) => field !== "name" && before[field] !== value && Object.hasOwn(before, field));
    const root = $(`#${prefix}-client-updates`);
    if (changes.length) {
      const details = element("details");
      const labels = { area: "Area", use: "Space type", notes: "Tour notes" };
      const readAt = new Date();
      const time = element("time", readAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
      time.dateTime = readAt.toISOString();
      const stamp = element("p", "Client record read at "); stamp.append(time);
      details.append(element("summary", `Review ${changes.length} field ${changes.length === 1 ? "change" : "changes"}`));
      for (const [field, value] of changes) {
        const row = element("section", undefined, "client-update-row"); row.dataset.field = field;
        const facts = element("dl", undefined, "client-update-facts");
        facts.append(element("dt", "Current draft"), element("dd", before[field] || "Empty"), element("dt", "Client record"), element("dd", value || "Empty"));
        const actions = element("div", undefined, "client-name-actions");
        for (const choice of ["keep", "use"]) {
          const button = element("button", `${choice === "keep" ? "Keep" : "Use"} ${labels[field].toLowerCase()}`);
          button.type = "button"; button.dataset.choice = choice;
          button.addEventListener("click", () => {
            if (choice === "use" && draft.values[field] === before[field]) draft.set(field, value);
            if (choice === "keep" && draft.values[field] === before[field]) draft.set(field, before[field]);
            row.remove(); if (!details.querySelector("[data-field]")) root.hidden = true;
            syncForm(prefix, draft); save(prefix === "plan" ? "#plan-message" : "#space-message");
          });
          actions.append(button);
        }
        row.append(element("h4", labels[field]), facts, actions); details.append(row);
      }
      root.replaceChildren(stamp, details); root.hidden = false;
    } else { root.hidden = true; root.replaceChildren(); }
    if (prefix === "plan") selectedRecord = record;
    syncForm(prefix, draft);
  }
  function renderLibrary() {
    const focusedId = document.activeElement?.dataset?.tourId;
    const openerId = opener?.dataset?.tourId;
    const query = $("#tour-filter").value;
    const groups = tourGroups(tours, query);
    setDocFilters({query});
    publishDocRead('tourLibrary',{tours:[...groups.upcoming,...groups.history]});
    for (const group of ["upcoming", "history"]) {
      const list = $(`#${group}-tours`), scroll = list.scrollTop; list.replaceChildren();
      for (const tour of groups[group]) {
        const item = element("li"), button = element("button", undefined, "tour-button");
        button.type = "button"; button.dataset.tourId = tour.id;
        button.title = tour.name || "Untitled tour"; button.append(element("strong", tourDisplayName(tour.name)), element("span", (tour.status || "draft").replaceAll("_", " ")));
        button.addEventListener("click", () => void openTour(tour.id, button)); item.append(button); list.append(item);
      }
      if (!groups[group].length) list.append(element("li", $("#tour-filter").value ? "No matching tours" : group === "upcoming" ? "No upcoming tours" : "No past tours", "empty-library"));
      list.scrollTop = scroll;
    }
    const buttons = [...document.querySelectorAll(".tour-button")];
    if (openerId) opener = buttons.find(button => button.dataset.tourId === openerId) || $("#tour-filter");
    if (focusedId) (buttons.find(button => button.dataset.tourId === focusedId) || $("#tour-filter")).focus({ preventScroll: true });
  }
  let opener = null, renderedTour = null;
  function showDialog(title, trigger) {
    renderedTour = null; opener = trigger || document.activeElement; message("#detail-title", title); $("#detail-content").replaceChildren();
    if (!$("#tour-dialog").open) $("#tour-dialog").showModal();
  }
  function closeDialog() { selectDocRecord(null, null); ++dialogEpoch; currentTour = null; $("#tour-dialog").close(); opener?.focus?.(); }
  function renderTour(tour) {
    const signature = JSON.stringify(tour);
    if (signature === renderedTour) return;
    const body = $("#detail-content"), dialog = $("#tour-dialog"), scroll = dialog.scrollTop;
    const expanded = body.querySelector("details")?.open;
    const focused = body.contains(document.activeElement) ? document.activeElement.tagName : null;
    message("#detail-title", tourDisplayName(tour.name, "Tour"));
    body.replaceChildren();
    const summary = element("div", undefined, "detail-summary");
    summary.append(element("span", (tour.status || "draft").replaceAll("_", " "), "pill"));
    const stops = (tour.routes?.[0]?.stops || tour.stops || []).filter(stop => stop.stop_state !== "excluded");
    summary.append(element("span", `${stops.length} stops`, "pill")); body.append(summary);
    const list = element("ol", undefined, "detail-stops");
    for (const stop of stops) {
      const row = element("li"); row.append(element("strong", stop.property_name || stop.name || "Property"));
      row.append(element("span", stop.property_address || stop.address || "Address unavailable"));
      if (stop.appointment_start) row.append(element("time", new Date(stop.appointment_start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", hour12: true })));
      list.append(row);
    }
    body.append(list);
    const notes = cheatSheetText(tour.cheat_sheet?.content);
    if (typeof notes === "string" && notes) {
      body.append(element("h3", "Notes"), element("p", notes.length > 180 ? `${notes.slice(0, 177)}…` : notes));
      const details = element("details"); details.open = Boolean(expanded); details.append(element("summary", "Details"), element("p", notes)); body.append(details);
    }
    const link = element("a", "Edit itinerary", "download-button");
    link.href = `/tours/route-editor.html?tour=${encodeURIComponent(tour.id)}`; link.target = "_blank"; link.rel = "noopener"; body.append(link);
    if (hasDayRoute(tour)) {
      const day = element("a", "Tour day", "download-button");
      day.href = `/tours/day.html?tour=${encodeURIComponent(tour.id)}`; day.target = "_blank"; day.rel = "noopener noreferrer"; body.append(day);
    }
    if (focused === "SUMMARY") body.querySelector("summary")?.focus({ preventScroll: true });
    if (focused === "A") link.focus({ preventScroll: true });
    dialog.scrollTop = scroll;
    renderedTour = signature;
  }
  async function openTour(id, trigger) {
    selectDocRecord('tour', id);
    showDialog("Tour", trigger); const epoch = ++dialogEpoch; currentTour = id;
    const docTicket = pageDocContext?.begin('tourDetail', [id]);
    message("#detail-message", "Updating…");
    try {
      const tour = await read(async () => validateTourDetail(await api.tour(id), id));
      if (epoch !== dialogEpoch || currentTour !== id || disposed) return;
      pageDocContext?.finish(docTicket, tour); renderTour(tour); message("#detail-message", "");
    } catch (error) { pageDocContext?.fail(docTicket, error); if (epoch === dialogEpoch) message("#detail-message", unavailable(error) || "Tour temporarily unavailable."); }
  }
  function renderFiles() {
    const list = $("#packet-files"); list.replaceChildren();
    files.forEach((file, index) => {
      const row = element("li"); const label = element("span", `${file.name} · ${Math.max(1, Math.ceil(file.size / 1024))} KB`);
      const remove = element("button", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.addEventListener("click", () => { files.splice(index, 1); renderFiles(); }); row.append(label, remove); list.append(row);
    });
    message("#file-count", `${files.length} ${files.length === 1 ? "file" : "files"}`);
  }
  function acceptFiles(incoming) {
    restoreOrClear();
    try { files = addPrivateFiles(files, incoming); renderFiles(); message("#file-message", ""); }
    catch (error) { message("#file-message", error.message); }
    $("#packet-upload").value = "";
  }
  function reviewDraft(trigger) {
    if (planPurpose === "client" && clientsStatus !== "ready") { message("#plan-message", clientsStatus === "pending" ? clientsLoading : clientsMessage === clientsUnavailable ? `${clientsMessage} Your draft is retained.` : clientsMessage); return; }
    if (planPurpose === "client" && !planClient) { message("#plan-message", "Choose a client."); $("#plan-client").focus(); return; }
    if (planPurpose === "client" && clientDetails.plan !== "ready") {
      message("#plan-message", clientDetails.plan === "failed" ? "Client details temporarily unavailable." : "Client details are loading. Wait, then review again."); return;
    }
    if (pendingClientName !== null) { message("#plan-message", "Review the changed client name before continuing."); $("#keep-client-name").focus(); return; }
    currentTour = null; ++dialogEpoch; showDialog(plan.values.name || "Packet draft", trigger); message("#detail-message", "");
    const body = $("#detail-content"); const facts = element("dl", undefined, "draft-facts");
    const labels = { date: "Date", time: "Start time", area: "Area", use: "Space type", start: "Start", end: "Finish", dwell: "Minutes per stop", buffer: "Travel buffer", notes: "Notes" };
    for (const [field, label] of Object.entries(labels)) if (plan.values[field]) facts.append(element("dt", label), element("dd", plan.values[field]));
    body.append(element("span", planPurpose === "research" ? "Research · Private draft" : "Client · Private draft", "pill"), facts);
    const criteria = drafts.space.get(subjectKey("plan"))?.values;
    if (criteria && SEARCH_FIELDS.some(field => criteria[field])) {
      const section = element("section"); section.id = "packet-search-criteria"; section.setAttribute("aria-labelledby", "packet-search-heading");
      const heading = element("h3", "Search draft · this tab"); heading.id = "packet-search-heading";
      const searchFacts = element("dl", undefined, "draft-facts");
      const searchLabels = { area: "Area", use: "Space type", minSize: "Minimum SF", maxSize: "Maximum SF", budget: "Maximum budget", rentBasis: "Budget basis", transaction: "Transaction", availableBy: "Available by", parking: "Parking", requirements: "Must-haves" };
      const rentLabels = { sf_year: "$/SF/year", month: "$/month", purchase: "Purchase price" };
      for (const field of SEARCH_FIELDS) if (criteria[field]) {
        const value = field === "rentBasis" ? rentLabels[criteria[field]] || criteria[field] : criteria[field];
        searchFacts.append(element("dt", searchLabels[field]), element("dd", value));
      }
      section.append(heading, element("p", "Private draft criteria saved in this tab only. No space search or tour has been created."), searchFacts); body.append(section);
    }
    if (selectedRecord?.notes) {
      const details = element("details"); details.append(element("summary", "Client notes · Details"), element("p", selectedRecord.notes)); body.append(details);
    }
    body.append(element("h3", "Files")); const attachments = element("ul");
    for (const file of files) attachments.append(element("li", file.name)); body.append(attachments);
    body.append(element("p", "Packet compilation unavailable", "capability-state"));
  }
  // The first upcoming tours, in library order, that Tour day can open.
  async function showNextTour(revision, signal) {
    const link = $("#next-tour");
    // eslint-disable-next-line no-restricted-syntax -- Next-tour detail reads are bounded by upcoming.slice(0, 3), a max of three tours.
    for (const { id } of tourGroups(tours).upcoming.slice(0, 3)) {
      let detail;
      try { detail = validateTourDetail(await api.tour(id, { signal }), id); } catch { continue; }
      if (disposed || revision !== refreshEpoch || signal?.aborted) return;
      if (!hasDayRoute(detail)) continue;
      link.textContent = `Next tour · ${tourDisplayName(detail.name)}`; link.href = `/tours/day.html?tour=${encodeURIComponent(id)}`; link.hidden = false;
      return;
    }
    if (!disposed && revision === refreshEpoch) link.hidden = true;
  }
  async function refresh({ signal } = {}) {
    const openTourId = currentTour;
    // Boot, manual and scheduled reads share one generation boundary.
    const docTicket = pageDocContext?.begin('tourLibrary');
    const revision = ++refreshEpoch;
    const active = () => !disposed && revision === refreshEpoch && !signal?.aborted;
    const libraryRead = read(async () => validateTourList(await api.library({ signal }))).then(rows => {
      if (!active()) return;
      tours = rows; pageDocContext?.finish(docTicket, { tours }); renderLibrary(); message("#tour-library-state", "");
      void showNextTour(revision, signal);
    }, error => {
      if (!active()) return;
      pageDocContext?.fail(docTicket, error); message("#tour-library-state", unavailable(error) || "Tours temporarily unavailable.");
      throw error;
    });
    const clientRead = Promise.allSettled([clientsStatus === "ready" ? Promise.resolve() : loadClients({ signal })]);
    const [libraryResult] = await Promise.allSettled([libraryRead]);
    if (!active()) return;
    restoreOrClear();
    if (!active()) return;
    let current = libraryResult.status === "fulfilled";
    // Fresh source data remains separate from the user's edited draft.
    // eslint-disable-next-line no-restricted-syntax -- Client refresh visits at most 2 distinct IDs, planClient and searchClient, once each.
    for (const id of new Set([planClient, searchClient].filter(Boolean))) {
      const planRevision = planClient === id ? ++planEpoch : planEpoch, searchRevision = searchClient === id ? ++searchEpoch : searchEpoch;
      try {
        const record = await read(async () => validateClientRecord(await api.client(id, { signal }), id));
        if (!active()) return;
        if (record.id === id && [planClient, searchClient].includes(id)) {
          if (planClient === id && planEpoch === planRevision) { setClientDetails("plan", "ready"); applyClientRecord("plan", record); settleClientMessage("plan"); }
          if (searchClient === id && searchEpoch === searchRevision) { setClientDetails("space", "ready"); applyClientRecord("space", record); settleClientMessage("space"); }
          save();
        }
      } catch {
        if (!active()) return;
        current = false;
        if (planClient === id && planEpoch === planRevision) { setClientDetails("plan", "failed"); message("#plan-message", "Client details temporarily unavailable."); }
        if (searchClient === id && searchEpoch === searchRevision) { setClientDetails("space", "failed"); message("#space-message", "Client details temporarily unavailable."); }
      }
    }
    if (!active()) return;
    if (openTourId && currentTour === openTourId && $("#tour-dialog").open) {
      const id = openTourId, epoch = ++dialogEpoch;
      const detailTicket=pageDocContext?.begin('tourDetail',[id]);
      try { const detail = await read(async () => validateTourDetail(await api.tour(id, { signal }), id)); if (currentTour === id && epoch === dialogEpoch && active()) { pageDocContext?.finish(detailTicket,detail); renderTour(detail); message("#detail-message", ""); } }
      catch (error) { pageDocContext?.fail(detailTicket,error); if (!active()) return; current = false; if (epoch === dialogEpoch) message("#detail-message", unavailable(error) || "Tour temporarily unavailable."); }
    }
    if (!active()) return;
    const [clientResult] = await clientRead;
    if (!active()) return;
    current = current && clientResult.status === "fulfilled";
    message("#planner-updated", current ? updatedLabel(new Date().toISOString()) : "Unavailable");
    $(".freshness").classList.toggle("current", current);
  }
  wireDraft("plan", plan); wireDraft("space", search);
  for (const prefix of ["plan", "space"]) {
    const find = () => {
      clientQuery = $(`#${prefix}-client-query`).value.trim();
      for (const name of ["plan", "space"]) $(`#${name}-client-query`).value = clientQuery;
      void loadClients().catch(() => {});
    };
    $(`#${prefix}-client-retry`).addEventListener("click", () => {
      const id = prefix === "plan" ? planClient : searchClient;
      if (id) void loadClientDetails(prefix, id, prefix === "plan" ? ++planEpoch : ++searchEpoch);
    });
    $(`#${prefix}-client-find`).addEventListener("click", find);
    $(`#${prefix}-client-query`).addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); find(); } });
  }
  for (const choice of ["keep", "use"]) $(`#${choice}-client-name`).addEventListener("click", () => {
    restoreOrClear();
    if (pendingClientName === null) return;
    plan.set("name", choice === "use" ? pendingClientName : plan.values.name);
    clearNameReview(); syncForm("plan", plan); save("#plan-message"); message("#plan-message", "Tour name selected for this draft."); $("#plan-name").focus();
  });
  $("#plan-purpose").addEventListener("change", event => {
    void prefill("plan", "", event.target.value === "research" ? "research" : "client");
  });
  $("#plan-client").addEventListener("change", event => void prefill("plan", event.target.value));
  $("#space-client").addEventListener("change", event => void prefill("space", event.target.value));
  $("#tour-filter").addEventListener("input", renderLibrary);
  $("#plan-form").addEventListener("submit", event => { event.preventDefault(); save("#plan-message"); reviewDraft($("#review-packet")); });
  $("#space-form").addEventListener("submit", event => { event.preventDefault(); const error = validateCriteria(search.values); if (error) message("#space-message", error); else if (save("#space-message")) message("#space-message", "Search draft saved."); });
  $("#plan-from-search").addEventListener("click", () => {
    restoreOrClear();
    const error = validateCriteria(search.values);
    if (error) { message("#space-message", error); return; }
    if (subjectKey("plan") === (searchClient || "research")) save("#space-message");
    else void prefill("plan", searchClient, searchClient ? "client" : "research");
    $("#plan-name").focus();
  });
  $("#packet-upload").addEventListener("change", event => acceptFiles([...event.target.files]));
  const drop = $("#packet-drop");
  drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("dragging"); acceptFiles([...event.dataTransfer.files]); });
  $("#detail-close").addEventListener("click", closeDialog);
  onDialogClosed($("#tour-dialog"), () => { selectDocRecord(null,null); pageDocContext?.release('tourDetail'); ++dialogEpoch; currentTour=null; });
  $("#tour-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  const chooseMarket = market => { search.set("area", market); syncForm("space", search); save("#space-message"); };
  for (const button of document.querySelectorAll(".market-buttons [data-market]")) button.addEventListener("click", () => chooseMarket(button.dataset.market));
  const territoryAbort = new AbortController();
  $("#show-territory").addEventListener("click", async event => {
    const button = event.currentTarget, root = $("#planner-territory");
    root.hidden = !root.hidden; button.setAttribute("aria-expanded", String(!root.hidden));
    $("#territory-status").hidden = root.hidden;
    button.textContent = root.hidden ? "Show territory" : "Hide territory";
    if (root.hidden || territoryLoading) return;
    if (territory) { territory.resize(); return; }
    territoryLoading = true; delete root.dataset.state;
    try {
      const { mountTerritoryMap } = await import("../js/leads-territory-map.js");
      if (disposed) return;
      territory = await mountTerritoryMap(root, chooseMarket, () => {}, { signal: territoryAbort.signal, areas: territoryAreas,
        padding: root.clientWidth < 520 ? { top: 44, bottom: 44, left: 16, right: 16 } : { top: 56, bottom: 56, left: 96, right: 96 }, markets: territoryAreas });
      if (disposed) territory?.dispose();
      else { territory?.select(search.values.area); message("#territory-status", "Market context only. US Census 2025 geography; no property or navigation pins."); }
    } catch { if (!disposed) { root.dataset.state = "failed"; message("#territory-status", "Territory unavailable. Choose an area above; hide and show territory to retry."); } }
    finally { territoryLoading = false; }
  });
  const auto = mountAutoRefresh({ document, window, refresh });
  $("#planner-refresh").addEventListener("click", () => void auto.refresh());
  const unsubscribe = api.onScopeChange?.(restoreOrClear);
  const ready = refresh();
  return { ready, refresh, get files() { return [...files]; }, dispose() { disposed = true; territoryAbort.abort(); territory?.dispose(); unsubscribe?.(); ++planEpoch; ++searchEpoch; ++dialogEpoch; auto.dispose(); } };
}

if (typeof document !== "undefined" && document.querySelector("#plan-form")) mountPlanner({ document, window });
