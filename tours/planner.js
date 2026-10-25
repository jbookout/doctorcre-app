import {onDialogClosed} from '../js/dialog-lifecycle.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from '../js/doc-context.js';
import { mountAutoRefresh, updatedLabel } from "../js/auto-refresh.mjs";
import { createPlannerClient, validateTourList, validateClientList, validateClientRecord, validateTourDetail } from "./planner-client.js";
import { cheatSheetText, tourDisplayName } from "./tour-format.js";
import { PLAN_FIELDS, SEARCH_FIELDS, createDraft, clientSuggestions, tourGroups, validateCriteria, addPrivateFiles } from "./planner-model.js";

export function mountPlanner({ document, window, api = createPlannerClient() }) {
  const $ = selector => document.querySelector(selector);
  const plan = createDraft(PLAN_FIELDS), search = createDraft(SEARCH_FIELDS);
  let loadingClients = false, clientsMessage = "", clients = new Map(), tours = [], files = [], planClient = "", searchClient = "", planEpoch = 0, searchEpoch = 0, dialogEpoch = 0, refreshEpoch = 0;
  let currentTour = null, selectedRecord = null, scope = null, scopeEstablished = false, disposed = false;
  const key = "doctorcre-tour-planning-drafts-v1";
  let clientPage = 0, clientPageCount = 1, clientsEpoch = 0;
  const directoryClients = new Set();
  const clientsUnavailable = "Clients unavailable. Load clients to retry.";
  const clientsLoading = "Clients are loading…";
  const clientReadError = "Client details temporarily unavailable.";
  let savedDraft = null;
  try { savedDraft = JSON.parse(window.sessionStorage.getItem(key)); } catch { }
  const message = (selector, text) => { $(selector).textContent = text; };
  const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const option = (text, value) => { const node = element("option", text); node.value = value; return node; };
  function save(target) {
    restoreOrClear();
    let outcome = "Draft stays in this tab. Sign in to save.";
    if (scope) {
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ scope, planClient, searchClient, plan: plan.values, search: search.values }));
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
      ++refreshEpoch; ++planEpoch; ++searchEpoch; ++dialogEpoch; planClient = ""; searchClient = ""; files = []; selectedRecord = null;
      savedDraft = null; ++clientsEpoch; clientPage = 0; clientPageCount = 1; loadingClients = false; clientsMessage = scope ? "" : "Sign in to continue."; clients.clear(); directoryClients.clear(); tours = []; plan.reset(); search.reset(); closeDialog();
      $("#detail-content").replaceChildren(); renderedTour = null; message("#detail-title", "Tour"); message("#detail-message", ""); $("#tour-filter").value = ""; fillClients(); renderLibrary(); renderFiles();
      try { window.sessionStorage.removeItem(key); } catch { }
      for (const target of ["#plan-message", "#space-message", "#tour-library-state"]) message(target, scope ? "Session changed. New draft started." : "Sign in to continue.");
      message("#planner-updated", "Unavailable");
      $(".freshness").classList.remove("current");
    } else if (scope) { clientsMessage = "";
      try {
        if (savedDraft?.scope === scope) {
          if (planEpoch === 0) { plan.restore(savedDraft.plan); planClient = savedDraft.planClient || ""; }
          if (searchEpoch === 0) { search.restore(savedDraft.search); searchClient = savedDraft.searchClient || ""; }
        }
      } catch { }
    }
    syncForm("plan", plan); syncForm("space", search); fillClients(); renderClientChoices();
  }
  async function read(operation) {
    try { return await operation(); }
    catch (error) { if (error?.code === "authentication_required") restoreOrClear(true); throw error; }
    finally { restoreOrClear(); }
  }
  const unavailable = error => error?.code === "authentication_required" ? "Sign in to continue." : null;
  function settleClientMessage(prefix) {
    const target = `#${prefix}-message`;
    if (["Updating…", clientReadError].includes($(target).textContent)) message(target, "");
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
      const value = event.target.value;
      if (scope !== null) restoreOrClear();
      draft.set(field, value); syncForm(prefix, draft); save(`#${prefix}-message`);
    });
    $(`#${prefix}-undo`).addEventListener("click", () => {
      const field = draft.undo(); syncForm(prefix, draft); save(`#${prefix}-message`);
      if (field) { $(`#${prefix}-${field}`).focus(); message(`#${prefix}-message`, "Change undone."); }
    });
  }
  function fillClients() {
    for (const [prefix, selected, research] of [["plan", planClient, false], ["space", searchClient, true]]) {
      const select = $(`#${prefix}-client`);
      select.replaceChildren(option(research ? "Research only" : "Choose a client", ""));
      for (const id of directoryClients) select.append(option(clients.get(id).name || "Unnamed client", id));
      if (selected && !directoryClients.has(selected)) select.append(option(clients.get(selected)?.name || "Selected client", selected));
      select.value = selected;
    }
  }
  function cacheClients(rows) {
    for (const row of rows) clients.set(row.id, row);
    fillClients();
  }
  function renderClientChoices() {
    for (const prefix of ["plan", "space"]) {
      const button = $(`#${prefix}-load-clients`);
      button.disabled = loadingClients;
      button.hidden = clientPage >= clientPageCount;
      button.textContent = clientPage ? "Load more clients" : "Load clients";
      message(`#${prefix}-clients-state`, clientsMessage);
    }
  }
  async function loadClients() {
    restoreOrClear();
    if (disposed || loadingClients || clientPage >= clientPageCount) return;
    if (!scope) {
      clientsMessage = scopeEstablished ? "Sign in to continue." : "Refresh tours before loading clients.";
      renderClientChoices(); return;
    }
    const epoch = ++clientsEpoch;
    loadingClients = true; clientsMessage = clientsLoading; renderClientChoices();
    try {
      const result = await read(() => api.clients({ page: clientPage + 1 }));
      if (disposed || epoch !== clientsEpoch) return;
      const rows = validateClientList(result.rows);
      for (const row of rows) directoryClients.add(row.id);
      cacheClients(rows);
      clientPage = result.page; clientPageCount = result.pageCount;
      clientsMessage = "";
    } catch (error) {
      if (disposed || epoch !== clientsEpoch) return;
      clientsMessage = unavailable(error) || clientsUnavailable;
    }
    loadingClients = false;
    for (const target of ["#plan-message", "#space-message"]) if ([clientsLoading, clientsUnavailable].includes($(target).textContent)) message(target, clientsMessage);
    renderClientChoices();
  }
  async function prefill(prefix, id) {
    const epoch = prefix === "plan" ? ++planEpoch : ++searchEpoch;
    const draft = prefix === "plan" ? plan : search;
    if (prefix === "plan") { planClient = id; selectedRecord = null; files = []; renderFiles(); } else searchClient = id;
    draft.reset(); syncForm(prefix, draft); save(`#${prefix}-message`);
    const target = `#${prefix}-message`;
    message(target, id ? "Updating…" : "");
    if (!id) return;
    try {
      const record = await read(async () => validateClientRecord(await api.client(id), id));
      if (disposed || epoch !== (prefix === "plan" ? planEpoch : searchEpoch)) return;
      cacheClients([record]);
      if (prefix === "plan") selectedRecord = record;
      draft.suggest(clientSuggestions(record)); syncForm(prefix, draft); save(`#${prefix}-message`);
      message(target, "");
    } catch (error) { if (epoch === (prefix === "plan" ? planEpoch : searchEpoch)) message(target, unavailable(error) || clientReadError); }
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
    if (tour.routes?.some(route => route.accepted === true && route.stops?.some(stop => stop.stop_state === "active"))) {
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
    if (!planClient && !clientPage && !clientsMessage) void loadClients();
    if (!planClient) { message("#plan-message", clientsMessage || "Choose a client."); $("#plan-client").focus(); return; }
    if (!selectedRecord) return;
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
  async function refresh({ signal } = {}) {
    const docTicket = pageDocContext?.begin('tourLibrary');
    const revision = ++refreshEpoch;
    const active = () => !disposed && revision === refreshEpoch && !signal?.aborted;
    let current = true;
    const libraryRead = read(async () => validateTourList(await api.library({ signal }))).then(rows => {
      if (!active()) return;
      tours = rows; pageDocContext?.finish(docTicket, { tours }); renderLibrary(); message("#tour-library-state", "");
    }).catch(error => {
      if (!active()) return;
      current = false; pageDocContext?.fail(docTicket, error); message("#tour-library-state", unavailable(error) || "Tours temporarily unavailable.");
    });
    const selectedClientsRead = (async () => {
      if (!scopeEstablished) await libraryRead;
      if (!active()) return;
      for (const id of new Set([planClient, searchClient].filter(Boolean))) {
        const planRevision = planClient === id ? ++planEpoch : planEpoch, searchRevision = searchClient === id ? ++searchEpoch : searchEpoch;
        try {
          const record = await read(async () => validateClientRecord(await api.client(id, { signal }), id));
          if (!active()) return;
          if ([planClient, searchClient].includes(id)) {
            cacheClients([record]);
            if (planClient === id && planEpoch === planRevision) { selectedRecord = record; plan.refreshSuggestions(clientSuggestions(record)); syncForm("plan", plan); settleClientMessage("plan"); }
            if (searchClient === id && searchEpoch === searchRevision) { search.refreshSuggestions(clientSuggestions(record)); syncForm("space", search); settleClientMessage("space"); }
            save();
          }
        } catch {
          if (!active()) return;
          current = false;
          if (planClient === id && planEpoch === planRevision) message("#plan-message", clientReadError);
          if (searchClient === id && searchEpoch === searchRevision) message("#space-message", clientReadError);
        }
      }
    })();
    const tourRead = (async () => {
      if (!active()) return;
      const id = currentTour, epoch = currentTour ? ++dialogEpoch : dialogEpoch;
      if (id && $("#tour-dialog").open) {
        const detailTicket=pageDocContext?.begin('tourDetail',[id]);
        try { const detail = await read(async () => validateTourDetail(await api.tour(id, { signal }), id)); if (currentTour === id && epoch === dialogEpoch && active()) { pageDocContext?.finish(detailTicket,detail); renderTour(detail); message("#detail-message", ""); } }
        catch (error) { pageDocContext?.fail(detailTicket,error); if (!active()) return; current = false; if (epoch === dialogEpoch) message("#detail-message", unavailable(error) || "Tour temporarily unavailable."); }
      }
    })();
    await Promise.all([libraryRead, selectedClientsRead, tourRead]);
    if (!active()) return;
    message("#planner-updated", current ? updatedLabel(new Date().toISOString()) : "Unavailable");
    $(".freshness").classList.toggle("current", current);
  }
  wireDraft("plan", plan); wireDraft("space", search);
  for (const prefix of ["plan", "space"]) $(`#${prefix}-load-clients`).addEventListener("click", () => void loadClients());
  $("#plan-client").addEventListener("change", event => void prefill("plan", event.target.value));
  $("#space-client").addEventListener("change", event => void prefill("space", event.target.value));
  $("#tour-filter").addEventListener("input", renderLibrary);
  $("#plan-form").addEventListener("submit", event => { event.preventDefault(); save("#plan-message"); reviewDraft($("#review-packet")); });
  $("#space-form").addEventListener("submit", event => { event.preventDefault(); const error = validateCriteria(search.values); if (error) message("#space-message", error); else if (save("#space-message")) message("#space-message", "Search draft saved."); });
  $("#packet-upload").addEventListener("change", event => acceptFiles([...event.target.files]));
  const drop = $("#packet-drop");
  drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("dragging"); acceptFiles([...event.dataTransfer.files]); });
  $("#detail-close").addEventListener("click", closeDialog);
  onDialogClosed($("#tour-dialog"), () => { selectDocRecord(null,null); pageDocContext?.release('tourDetail'); ++dialogEpoch; currentTour=null; });
  $("#tour-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  for (const button of document.querySelectorAll("[data-market]")) button.addEventListener("click", () => {
    search.set("area", button.dataset.market); syncForm("space", search); save("#space-message");
  });
  const auto = mountAutoRefresh({ document, window, refresh });
  $("#planner-refresh").addEventListener("click", () => void auto.refresh());
  const unsubscribe = api.onScopeChange?.(restoreOrClear);
  const ready = refresh();
  return { ready, refresh, get files() { return [...files]; }, dispose() { disposed = true; ++clientsEpoch; unsubscribe?.(); ++planEpoch; ++searchEpoch; ++dialogEpoch; auto.dispose(); } };
}

if (typeof document !== "undefined" && document.querySelector("#plan-form")) mountPlanner({ document, window });
