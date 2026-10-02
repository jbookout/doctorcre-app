import { mountAutoRefresh, updatedLabel } from "../js/auto-refresh.mjs";
import { createPlannerClient } from "./planner-client.js";
import { cheatSheetText } from "./tour-format.js";
import { PLAN_FIELDS, SEARCH_FIELDS, createDraft, clientSuggestions, tourGroups, validateCriteria, addPrivateFiles } from "./planner-model.js";

export function mountPlanner({ document, window, api = createPlannerClient() }) {
  const $ = selector => document.querySelector(selector);
  const plan = createDraft(PLAN_FIELDS), search = createDraft(SEARCH_FIELDS);
  let clients = [], tours = [], files = [], planClient = "", searchClient = "", planEpoch = 0, searchEpoch = 0, dialogEpoch = 0;
  let currentTour = null, selectedRecord = null, scope = null, disposed = false;
  const key = "doctorcre-tour-planning-drafts-v1";
  const message = (selector, text) => { $(selector).textContent = text; };
  const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const option = (text, value) => { const node = element("option", text); node.value = value; return node; };
  function save() {
    if (!scope) return;
    try { window.sessionStorage.setItem(key, JSON.stringify({ scope, planClient, searchClient, plan: plan.values, search: search.values })); }
    catch { message("#plan-message", "Draft stays in this tab."); }
  }
  function restoreOrClear() {
    if (api.scope === scope) return;
    const first = scope === null; scope = api.scope;
    if (!scope) return;
    if (!first) {
      ++planEpoch; ++searchEpoch; ++dialogEpoch; planClient = ""; searchClient = ""; files = []; selectedRecord = null;
      plan.reset(); search.reset(); closeDialog(); message("#plan-message", "Session changed. New draft started."); renderFiles();
    } else {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(key));
        if (saved?.scope === scope) { plan.reset(saved.plan); search.reset(saved.search); planClient = saved.planClient || ""; searchClient = saved.searchClient || ""; }
      } catch { /* An invalid draft never selects another client's record. */ }
    }
    syncForm("plan", plan); syncForm("space", search);
  }
  function syncForm(prefix, draft) {
    for (const [field, value] of Object.entries(draft.values)) {
      const control = $(`#${prefix}-${field}`);
      if (control.value !== value) control.value = value;
    }
    if (prefix === "space") for (const button of document.querySelectorAll("[data-market]")) button.setAttribute("aria-pressed", String(button.dataset.market === draft.values.area));
    $(`#${prefix}-undo`).disabled = !draft.canUndo;
  }
  function wireDraft(prefix, draft) {
    for (const field of Object.keys(draft.values)) $(`#${prefix}-${field}`).addEventListener("input", event => {
      draft.set(field, event.target.value); syncForm(prefix, draft); save();
    });
    $(`#${prefix}-undo`).addEventListener("click", () => {
      const field = draft.undo(); syncForm(prefix, draft); save();
      if (field) { $(`#${prefix}-${field}`).focus(); message(prefix === "plan" ? "#plan-message" : "#space-message", "Change undone."); }
    });
  }
  function fillClients() {
    for (const [prefix, selected, research] of [["plan", planClient, false], ["space", searchClient, true]]) {
      const select = $(`#${prefix}-client`);
      select.replaceChildren(option(research ? "Research only" : "Choose a client", ""));
      for (const client of clients) select.append(option(client.name || "Unnamed client", client.id));
      // Retain the exact draft binding while the picker is filtered or temporarily unavailable.
      if (selected && !clients.some(client => client.id === selected)) select.append(option("Selected client unavailable", selected));
      select.value = selected;
    }
  }
  async function prefill(prefix, id) {
    const epoch = prefix === "plan" ? ++planEpoch : ++searchEpoch;
    const draft = prefix === "plan" ? plan : search;
    if (prefix === "plan") { planClient = id; selectedRecord = null; files = []; renderFiles(); } else searchClient = id;
    // A new record starts an independent draft, so previous-client criteria never migrate.
    draft.reset(); syncForm(prefix, draft); save();
    const target = prefix === "plan" ? "#plan-message" : "#space-message";
    message(target, id ? "Updating…" : "");
    if (!id) return;
    try {
      const record = await api.client(id);
      if (disposed || epoch !== (prefix === "plan" ? planEpoch : searchEpoch) || record.id !== id) return;
      if (prefix === "plan") selectedRecord = record;
      draft.suggest(clientSuggestions(record)); syncForm(prefix, draft); save();
      message(target, "");
    } catch { if (epoch === (prefix === "plan" ? planEpoch : searchEpoch)) message(target, "Client details temporarily unavailable."); }
  }
  function renderLibrary() {
    const focusedId = document.activeElement?.dataset?.tourId;
    const openerId = opener?.dataset?.tourId;
    const groups = tourGroups(tours, $("#tour-filter").value);
    for (const group of ["upcoming", "history"]) {
      const list = $(`#${group}-tours`), scroll = list.scrollTop; list.replaceChildren();
      for (const tour of groups[group]) {
        const item = element("li"), button = element("button", undefined, "tour-button");
        button.type = "button"; button.dataset.tourId = tour.id;
        button.append(element("strong", tour.name || "Untitled tour"), element("span", (tour.status || "draft").replaceAll("_", " ")));
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
  function closeDialog() { ++dialogEpoch; currentTour = null; $("#tour-dialog").close(); opener?.focus?.(); }
  function renderTour(tour) {
    const signature = JSON.stringify(tour);
    if (signature === renderedTour) return;
    renderedTour = signature;
    const body = $("#detail-content"), dialog = $("#tour-dialog"), scroll = dialog.scrollTop;
    const expanded = body.querySelector("details")?.open;
    const focused = body.contains(document.activeElement) ? document.activeElement.tagName : null;
    message("#detail-title", tour.name || "Tour");
    body.replaceChildren();
    const summary = element("div", undefined, "detail-summary");
    summary.append(element("span", (tour.status || "draft").replaceAll("_", " "), "pill"));
    const stops = (tour.routes?.find(route => route.accepted)?.stops || tour.stops || []).filter(stop => stop.stop_state !== "excluded");
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
    if (focused === "SUMMARY") body.querySelector("summary")?.focus({ preventScroll: true });
    if (focused === "A") link.focus({ preventScroll: true });
    dialog.scrollTop = scroll;
  }
  async function openTour(id, trigger) {
    showDialog("Tour", trigger); const epoch = ++dialogEpoch; currentTour = id;
    message("#detail-message", "Updating…");
    try {
      const tour = await api.tour(id);
      if (epoch !== dialogEpoch || currentTour !== id || disposed) return;
      renderTour(tour); message("#detail-message", "");
    } catch { if (epoch === dialogEpoch) message("#detail-message", "Tour temporarily unavailable."); }
  }
  function renderFiles() {
    const list = $("#packet-files"); list.replaceChildren();
    files.forEach((file, index) => {
      const row = element("li"); const label = element("span", `${file.name} · ${Math.max(1, Math.ceil(file.size / 1024))} KB`);
      const remove = element("button", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.addEventListener("click", () => { files.splice(index, 1); renderFiles(); }); row.append(label, remove); list.append(row);
    });
    message("#file-count", `${files.length} files`);
  }
  function acceptFiles(incoming) {
    try { files = addPrivateFiles(files, incoming); renderFiles(); message("#file-message", ""); }
    catch (error) { message("#file-message", error.message); }
    $("#packet-upload").value = "";
  }
  function reviewDraft(trigger) {
    if (!planClient) { message("#plan-message", "Choose a client."); $("#plan-client").focus(); return; }
    currentTour = null; ++dialogEpoch; showDialog(plan.values.name || "Packet draft", trigger); message("#detail-message", "");
    const body = $("#detail-content"); const facts = element("dl", undefined, "draft-facts");
    const labels = { date: "Date", time: "Start time", area: "Area", use: "Space type", start: "Start", end: "Finish", dwell: "Minutes per stop", buffer: "Travel buffer", notes: "Notes" };
    for (const [field, label] of Object.entries(labels)) if (plan.values[field]) facts.append(element("dt", label), element("dd", plan.values[field]));
    body.append(element("span", "Private draft", "pill"), facts);
    if (selectedRecord?.notes) {
      const details = element("details"); details.append(element("summary", "Client notes · Details"), element("p", selectedRecord.notes)); body.append(details);
    }
    body.append(element("h3", "Files")); const attachments = element("ul");
    for (const file of files) attachments.append(element("li", file.name)); body.append(attachments);
    body.append(element("p", "Packet compilation unavailable", "capability-state"));
  }
  async function refresh() {
    const results = await Promise.allSettled([api.library(), api.clients()]);
    if (disposed) return;
    restoreOrClear();
    if (results[0].status === "fulfilled") { tours = results[0].value; renderLibrary(); message("#tour-library-state", ""); }
    else message("#tour-library-state", "Tours temporarily unavailable.");
    if (results[1].status === "fulfilled") {
      clients = results[1].value; fillClients();
      for (const target of ["#plan-message", "#space-message"]) if ($(target).textContent === "Clients temporarily unavailable.") message(target, "");
    }
    else { message("#plan-message", "Clients temporarily unavailable."); message("#space-message", "Clients temporarily unavailable."); }
    let current = results.every(result => result.status === "fulfilled");
    // Fresh source data remains separate from the user's edited draft.
    for (const id of new Set([planClient, searchClient].filter(Boolean))) {
      const planRevision = planEpoch, searchRevision = searchEpoch;
      try {
        const record = await api.client(id);
        if (disposed) return;
        if (record.id === id && [planClient, searchClient].includes(id)) {
          if (planClient === id && planEpoch === planRevision) { selectedRecord = record; plan.refreshSuggestions(clientSuggestions(record)); syncForm("plan", plan); }
          if (searchClient === id && searchEpoch === searchRevision) { search.refreshSuggestions(clientSuggestions(record)); syncForm("space", search); }
          for (const [selected, target] of [[planClient, "#plan-message"], [searchClient, "#space-message"]]) if (selected === id && $(target).textContent === "Client details temporarily unavailable.") message(target, "");
          save();
        }
      } catch {
        current = false;
        if (planClient === id && planEpoch === planRevision) message("#plan-message", "Client details temporarily unavailable.");
        if (searchClient === id && searchEpoch === searchRevision) message("#space-message", "Client details temporarily unavailable.");
      }
    }
    const id = currentTour, epoch = dialogEpoch;
    if (id && $("#tour-dialog").open) {
      try { const detail = await api.tour(id); if (currentTour === id && epoch === dialogEpoch && !disposed) { renderTour(detail); message("#detail-message", ""); } }
      catch { current = false; if (epoch === dialogEpoch) message("#detail-message", "Tour temporarily unavailable."); }
    }
    if (current) message("#planner-updated", updatedLabel(new Date().toISOString()));
    $(".freshness").classList.toggle("current", current);
  }
  wireDraft("plan", plan); wireDraft("space", search);
  $("#plan-client").addEventListener("change", event => void prefill("plan", event.target.value));
  $("#space-client").addEventListener("change", event => void prefill("space", event.target.value));
  $("#tour-filter").addEventListener("input", renderLibrary);
  $("#plan-form").addEventListener("submit", event => { event.preventDefault(); save(); reviewDraft($("#review-packet")); });
  $("#space-form").addEventListener("submit", event => { event.preventDefault(); const error = validateCriteria(search.values); save(); message("#space-message", error || "Search draft saved."); });
  $("#packet-upload").addEventListener("change", event => acceptFiles([...event.target.files]));
  const drop = $("#packet-drop");
  drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("dragging"); acceptFiles([...event.dataTransfer.files]); });
  $("#detail-close").addEventListener("click", closeDialog);
  $("#tour-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  for (const button of document.querySelectorAll("[data-market]")) button.addEventListener("click", () => {
    search.set("area", button.dataset.market); syncForm("space", search); save();
  });
  const auto = mountAutoRefresh({ document, window, refresh });
  $("#planner-refresh").addEventListener("click", () => void auto.refresh());
  const ready = refresh();
  return { ready, refresh, get files() { return [...files]; }, dispose() { disposed = true; ++planEpoch; ++searchEpoch; ++dialogEpoch; auto.dispose(); } };
}

if (typeof document !== "undefined" && document.querySelector("#plan-form")) mountPlanner({ document, window });
