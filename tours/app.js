import { mountAutoRefresh } from "../js/auto-refresh.mjs";
import { mountAcceptedItinerary, acceptedRouteFromDetail } from "./itinerary-map.js";
import { mountPropertyPanel } from "./property-panel.js";
import { cheatSheetText, factSummary, formatTourDate, tourMetaLine } from "./tour-format.js";

(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const state = { csrf: "", tours: [], tour: null, feedback: null, feedbackSeq: 0, feedbackStatus: "missing", rawShareToken: "", shareGrantId: "", shareStatus: "missing", shareGrants: [], projectionId: "", projectionDraftId: "", candidateDigest: "", renderJobId: "", pdfQcRunDigest: "", cheatDirty: false, cheatDraftTourId: "",
    searchItems: [], knownProperties: new Map(), searchCursor: null, searchKey: null, searchCompleted: false, searchSeq: 0, hydrationSeq: 0, cart: null, selectedIds: [], selectionDirty: false, selectionTourId: "", pendingSelection: null, selectionSave: null, undoSelectionIds: null };
  const uuid = () => crypto.randomUUID();
  const status = (message) => { $("#status").textContent = message; };
  const text = (value, fallback = "") => typeof value === "string" && value ? value : fallback;
  const digest = (value) => /^sha256:[0-9a-f]{64}$/i.test(value);
  const id = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  async function sha256(value) { const bytes = new TextEncoder().encode(value); const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
  function newShareToken() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return base64url(bytes); }
  async function request(path, options = {}) {
    const controller = new AbortController(); let timer, result;
    try {
      result = await Promise.race([
        (async () => {
          const response = await fetch(path, { credentials: "same-origin", ...options, signal: controller.signal });
          let payload = null; try { payload = await response.json(); } catch { if (response.ok) throw new Error("read_invalid"); }
          return { response, payload };
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("request_timeout")); controller.abort(); }, 15000); }),
      ]);
    } finally { clearTimeout(timer); }
    const { response, payload } = result;
    if (!response.ok) { const error = new Error(payload?.error || "request_failed"); error.status = response.status; error.payload = payload; throw error; }
    if (typeof payload?.csrf_token === "string") {
      const binding = await sha256(payload.csrf_token), changed = sessionBinding && sessionBinding !== binding;
      state.csrf = payload.csrf_token; sessionBinding = binding;
      if (changed) {
        createPending = null; restoredTourId = ""; createPhase = "ready"; routeEndpoints.clear();
        itineraryView?.destroy(); itineraryView = null; $("#accepted-itinerary").hidden = true;
        if (composer) { composer.plan = null; composer.phase = "session-changed"; composer.saved = false; composer.dirty = false; composer.undo = null; composer.message = "Session changed. Previous requests cannot be retried here. Reload the route for this session."; }
        persistPending(); renderCreate(); renderComposerSummary();
        throw new Error("session_changed");
      }
    }
    return payload?.data || {};
  }
  function post(path, body, binding = sessionBinding) {
    if (!binding || binding !== sessionBinding) return Promise.reject(new Error("session_changed"));
    return request(path, { method: "POST", headers: { "content-type": "application/json", "x-carr-csrf": state.csrf }, body: JSON.stringify(body) }).then(data => { if (binding !== sessionBinding) throw new Error("session_changed"); return data; }).catch(error => { error.writeRefusal = error.status >= 400 && error.status < 500; throw error; });
  }
  function validateDetail(detail, tourId) {
    const stopArtifact = stops => stops.map(stop => Object.fromEntries(["id", "property_id", "route_sequence", "route_label", "stop_state", "locked_appointment", "appointment_start", "appointment_end", "dwell_minutes", "buffer_minutes"].map(field => [field, stop[field]])));
    const validStop = stop => id(stop?.id) && id(stop.property_id) && ["active", "held", "excluded"].includes(stop.stop_state) &&
      typeof stop.locked_appointment === "boolean" && Number.isInteger(stop.dwell_minutes) && Number.isInteger(stop.buffer_minutes) &&
      (stop.stop_state === "active" ? Number.isInteger(stop.route_sequence) && stop.route_sequence > 0 && typeof stop.route_label === "string" : stop.route_sequence === null && stop.route_label === null);
    if (detail?.id !== tourId || !id(detail.route_version_id) || !["draft", "accepted"].includes(detail.route_version_state) ||
      !Number.isInteger(detail.accepted_route_version) || !Array.isArray(detail.stops) || !detail.stops.every(validStop) ||
      !Array.isArray(detail.routes) || !detail.routes.length || !detail.routes.every(route => id(route?.id) && Number.isInteger(route.route_version) && route.route_version > 0 &&
        typeof route.accepted === "boolean" && Array.isArray(route.stops) && route.stops.every(validStop)) ||
      new Set(detail.routes.map(route => route.id)).size !== detail.routes.length ||
      detail.routes[0].id !== detail.route_version_id || detail.routes[0].accepted !== (detail.route_version_state === "accepted") ||
      JSON.stringify(stopArtifact(detail.stops)) !== JSON.stringify(stopArtifact(detail.routes[0].stops))) throw new Error("read_invalid");
    return detail;
  }
  async function composerDetail(tourId) { return validateDetail(await request(`/api/tours/detail?tour_id=${encodeURIComponent(tourId)}`), tourId); }
  let createPending = null, createBusy = false, createPhase = "ready", sessionBinding = "", navigationBusy = false, restoredTourId = "", libraryReady = false;
  const routeEndpoints = new Map();
  const pendingKey = "doctorcre-tour-pending-v1";
  function readPending() {
    try { const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null"); return saved?.sessionBinding === sessionBinding ? saved : null; } catch { return null; }
  }
  function persistPending() {
    if (restoredTourId && !composer) return;
    const pending = createPending ? { create: createPending } : composer?.plan ? { composer: { ...composer, busy: false, undo: null } } : null;
    try {
      if (pending) sessionStorage.setItem(pendingKey, JSON.stringify({ sessionBinding, ...pending }));
      else sessionStorage.removeItem(pendingKey);
    } catch { status("Pending request stays in this tab's memory. Tab storage is unavailable; keep this tab open until reconciliation finishes."); }
  }
  function renderCreate() {
    $("#create-tour").disabled = !libraryReady || Boolean(restoredTourId) || navigationBusy || createBusy || createPhase === "unknown";
    $("#create-tour").textContent = createPending ? "Retry same creation request" : "Create Tour";
    $("#reconcile-create").hidden = createPhase !== "unknown";
    for (const control of document.querySelectorAll("#create-tour-form input, #create-tour-form select")) control.disabled = Boolean(createPending) || createBusy;
  }
  function endpoint(role, prefix = "") {
    const latitude = $(`#${prefix}${role}-latitude`).value.trim(), longitude = $(`#${prefix}${role}-longitude`).value.trim(), source_ref = $(`#${prefix}${role}-source`).value.trim();
    if (!latitude || !longitude || !source_ref || /(contact|phone|email|internal|client|@)/i.test(source_ref) || source_ref.length > 240 ||
      !Number.isFinite(Number(latitude)) || Math.abs(Number(latitude)) > 90 || !Number.isFinite(Number(longitude)) || Math.abs(Number(longitude)) > 180) throw new Error("point_invalid");
    return { latitude: Number(latitude), longitude: Number(longitude), position_role: role, precision_class: "approximate", source_ref };
  }
  async function createTour() {
    if (!libraryReady || restoredTourId || createBusy || navigationBusy || createPhase === "unknown") return;
    if (composer?.dirty || composer?.plan || composer?.busy) { $("#create-tour-state").textContent = "Save or reconcile the current route before starting another Tour."; return; }
    createBusy = true; renderCreate();
    try {
      if (!createPending) createPending = { idempotency_key: uuid(), tour_name: $("#create-tour-name").value.trim(),
        subject_type: $("#create-subject-type").value, subject_id: $("#create-subject-id").value.trim(),
        canonical_dataset_version: $("#create-dataset").value.trim(), start_point: endpoint("start"), end_point: endpoint("end") };
      persistPending(); renderCreate();
      $("#create-tour-state").textContent = "Creating Tour…";
      const data = await post("/api/tours/create", createPending);
      if (!id(data.tour_id)) throw new Error("outcome_unknown");
      routeEndpoints.set(data.tour_id, { start: createPending.start_point, end: createPending.end_point });
      await loadLibrary(); await loadTour(data.tour_id);
      createPending = null; createPhase = "ready"; persistPending(); $("#create-tour-state").textContent = "Tour created. Add properties from the selection cart.";
      $("#create-tour-panel").open = false;
    } catch (error) {
      if (error.message === "session_changed") $("#create-tour-state").textContent = "Session changed. The previous creation request cannot be retried here.";
      else if (error.message === "point_invalid") $("#create-tour-state").textContent = "Enter valid start and end coordinates and location source references.";
      else if (error.writeRefusal) { createPending = null; createPhase = "ready"; persistPending(); $("#create-tour-state").textContent = "Tour creation refused. Review the subject and route details."; }
      else { createPhase = "unknown"; $("#create-tour-state").textContent = "Creation outcome unknown. Reconcile before retrying; your request and key are retained."; }
    } finally { createBusy = false; renderCreate(); renderComposerSummary(); }
  }
  function renderLibrary() {
    const list = $("#tour-list"); list.replaceChildren();
    for (const tour of state.tours) { const button = document.createElement("button"); button.type = "button"; button.className = "tour-button"; button.textContent = `${text(tour.name, "Untitled tour")} · ${text(tour.status, "draft")}`; button.addEventListener("click", () => void loadTour(tour.id)); const item = document.createElement("li"); item.append(button); list.append(item); }
    if (!state.tours.length) list.textContent = "No tours are available.";
    list.setAttribute("aria-busy", "false");
  }
  const countyNames = ["Escambia", "Santa Rosa", "Okaloosa", "Walton", "Bay"];
  function displayDate(value) { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "unknown"; }
  function searchFilters(cursor = null) {
    const size = (selector) => { const raw = $(selector).value.trim(); return raw ? Number(raw) : null; };
    const bool = $("#property-entrance").value;
    const kind = $("#property-type").value.trim().toLowerCase().replace(/\s+/g, "_");
    return { query: $("#property-query").value.trim() || null, counties: $("#property-county").value ? [$("#property-county").value] : [],
      property_types: kind ? [kind] : [], min_square_feet: size("#property-min-size"), max_square_feet: size("#property-max-size"),
      availability: $("#property-availability").value ? [$("#property-availability").value] : [],
      entrance_verified: bool === "" ? null : bool === "true", public_projection_ready: null, photos_available: null,
      sort: $("#property-sort").value, cursor, limit: 25 };
  }
  function updateTerritory() {
    for (const county of countyNames) {
      const node = [...document.querySelectorAll("#territory-visual .county")].find(item => item.dataset.county === county);
      if (!node) continue;
      const count = state.searchItems.filter(item => item.county === county).length;
      node.querySelector(".county-count").textContent = `${count} ${count === 1 ? "result" : "results"}`;
      node.classList.toggle("has-results", count > 0);
      node.classList.toggle("is-filtered", $("#property-county").value === county);
    }
  }
  function knownProperty(propertyId) { const item = state.knownProperties.get(propertyId); return item && (text(item.name) || text(item.address)) ? item : null; }
  function renderSelection() {
    const list = $("#selection-list"); list.replaceChildren();
    state.selectedIds.forEach((propertyId) => {
      const row = document.createElement("li"); row.className = "selection-item";
      const known = knownProperty(propertyId);
      const label = document.createElement("span");
      label.textContent = known ? `${text(known.name, text(known.address, "Unnamed property"))} · ${text(known.address, "Address unknown")}` :
        "Saved property · details unavailable";
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove";
      remove.addEventListener("click", () => toggleProperty(propertyId)); row.append(label, remove);
      list.append(row);
    });
    if (!state.selectedIds.length) list.textContent = "No properties selected.";
    $("#selection-tour").textContent = state.tour ? `For ${text(state.tour.name, "this Tour")}` : "Select a Tour from the library to save a selection.";
    $("#selection-version").textContent = state.cart?.selection_version ? `Saved version ${state.cart.selection_version}` : "No saved version";
    $("#save-selection").disabled = !state.tour || !state.selectionDirty || Boolean(state.selectionSave);
    $("#undo-selection").hidden = !state.undoSelectionIds;
    if (!state.selectionDirty) {
      const unresolved = state.selectedIds.filter(propertyId => !knownProperty(propertyId)).length;
      $("#selection-state").textContent = state.tour ? state.cart?.selection_version ?
        `${state.selectedIds.length} selected · saved${unresolved ? `. Details unavailable for ${unresolved}; remove any that no longer belong.` : ""}` :
        "No selection saved for this Tour." : "No Tour selected.";
    }
    renderComposerSummary();
  }
  function toggleProperty(propertyId) {
    if (!state.tour || !id(propertyId)) { $("#selection-state").textContent = "Select a Tour before adding properties."; return; }
    state.undoSelectionIds = [...state.selectedIds];
    const selected = new Set(state.selectedIds);
    if (selected.has(propertyId)) selected.delete(propertyId); else if (selected.size < 100) selected.add(propertyId);
    state.selectedIds = [...selected]; state.selectionDirty = true; state.pendingSelection = null;
    renderSelection(); renderSearchResults();
    $("#selection-state").textContent = `${state.selectedIds.length} selected · unsaved changes. Save selection to keep them with this Tour.`;
  }
  function renderSearchResults() {
    const list = $("#property-results"); list.replaceChildren();
    for (const item of state.searchItems) {
      if (!id(item.property_id)) continue;
      const row = document.createElement("li"); row.className = "property-result"; row.dataset.county = text(item.county);
      const header = document.createElement("div"); header.className = "property-result-head";
      const title = document.createElement("strong"); title.textContent = text(item.name, "Unnamed property");
      const action = document.createElement("button"); action.type = "button"; action.dataset.propertyId = item.property_id;
      const identifiable = Boolean(text(item.name) || text(item.address));
      action.textContent = identifiable ? state.selectedIds.includes(item.property_id) ? "Remove from selection" : "Add to selection" : "Details unavailable";
      action.disabled = !identifiable;
      action.setAttribute("aria-pressed", String(state.selectedIds.includes(item.property_id)));
      action.addEventListener("click", () => toggleProperty(item.property_id)); header.append(title, action);
      const address = document.createElement("p"); address.className = "property-address"; address.textContent = `${text(item.address, "Address unknown")} · ${text(item.county, "County unknown")}`;
      const facts = document.createElement("p"); facts.className = "property-facts";
      const size = typeof item.size?.value === "number" ? `${item.size.value.toLocaleString()} ${text(item.size.unit, "SF")}` : "Size unknown";
      facts.textContent = `${text(item.property_type, "Type unknown").replaceAll("_", " ")} · ${size} · ${text(item.availability, "unknown").replaceAll("_", " ")}`;
      const provenance = document.createElement("p"); provenance.className = "property-provenance";
      provenance.textContent = `${text(item.source_label, "Source unknown")} · Latest fact date ${displayDate(item.fact_as_of)} · Rights ${text(item.rights_status, "unknown")} · Precision ${text(item.coordinate_precision, "unknown").replaceAll("_", " ")} · ${item.entrance_verified === true ? "Entrance verified" : "Entrance status unknown"}`;
      const caution = document.createElement("p"); caution.className = "property-caution";
      caution.textContent = `Candidate facts need review before a route or client use. ${text(item.caveat)}`.trim();
      row.append(header, address, facts, provenance, caution); list.append(row);
    }
    if (!list.children.length) list.textContent = state.searchCompleted ? "No properties match these filters." : "Find properties to see candidates.";
    $("#search-count").textContent = `${state.searchItems.length} loaded`;
    $("#more-properties").hidden = !state.searchCursor;
    updateTerritory(); renderSelection();
  }
  async function searchProperties(more = false) {
    const currentFilters = searchFilters();
    const key = JSON.stringify(currentFilters);
    if (more && !state.searchCursor) return;
    if (more && key !== state.searchKey) more = false;
    const filters = { ...currentFilters, cursor: more ? state.searchCursor : null };
    if (filters.property_types.length && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(filters.property_types[0])) {
      $("#search-state").textContent = "Use words, numbers, spaces, or hyphens for property type."; return;
    }
    if (filters.min_square_feet !== null && filters.max_square_feet !== null && filters.min_square_feet > filters.max_square_feet) {
      $("#search-state").textContent = "Minimum size must be no greater than maximum size."; return;
    }
    const seq = ++state.searchSeq;
    if (!more) { state.searchItems = []; state.searchCursor = null; state.searchKey = key; state.searchCompleted = false; renderSearchResults(); }
    $("#search-state").textContent = "Searching reviewed properties…";
    try {
      const data = await post("/api/tours/properties/search", filters);
      if (seq !== state.searchSeq) return;
      const items = Array.isArray(data.search?.items) ? data.search.items.filter(item => id(item?.property_id)) : [];
      for (const item of items) if (text(item.name) || text(item.address)) state.knownProperties.set(item.property_id, item);
      state.searchItems = more ? [...state.searchItems, ...items.filter(item => !state.searchItems.some(old => old.property_id === item.property_id))] : items;
      state.searchCursor = typeof data.search?.cursor === "string" && data.search.has_more ? data.search.cursor : null;
      state.searchCompleted = true;
      renderSearchResults(); $("#search-state").textContent = `${state.searchItems.length} loaded candidate${state.searchItems.length === 1 ? "" : "s"}. Unknown facts stay visible.`;
    } catch { if (seq === state.searchSeq) $("#search-state").textContent = "Property search is unavailable. Your Tour selection is still here."; }
  }
  async function loadSelectionCart(tourId) {
    if (!id(tourId)) return;
    try {
      const data = await request(`/api/tours/selection-cart?tour_id=${encodeURIComponent(tourId)}`);
      if (state.tour?.id !== tourId) return;
      const cart = data.cart;
      if (cart?.tour_id !== tourId || !Array.isArray(cart.property_ids)) throw new Error("cart_invalid");
      state.cart = cart;
      if (!state.selectionDirty) state.selectedIds = cart.property_ids.filter(id).slice(0, 100);
      renderSearchResults(); void hydrateSelectedProperties(tourId); return true;
    } catch (error) {
      if (state.tour?.id !== tourId) return;
      if (error.message === "not_found") { state.cart = null; if (!state.selectionDirty) state.selectedIds = []; renderSearchResults(); }
      else $("#selection-state").textContent = "Saved selection could not be loaded. Current selection stays visible.";
      return false;
    }
  }
  async function hydrateSelectedProperties(tourId) {
    const seq = ++state.hydrationSeq;
    const missing = new Set(state.selectedIds.filter(propertyId => !knownProperty(propertyId)));
    if (!missing.size) return;
    let cursor = null;
    for (let page = 0; page < 20 && missing.size; page += 1) {
      const filters = { ...searchFilters(cursor), query: null, counties: [], property_types: [],
        min_square_feet: null, max_square_feet: null, availability: [], entrance_verified: null,
        public_projection_ready: null, photos_available: null, sort: "updated_desc", cursor, limit: 100 };
      let search;
      try { ({ search } = await post("/api/tours/properties/search", filters)); } catch { return; }
      if (seq !== state.hydrationSeq || state.tour?.id !== tourId) return;
      for (const item of Array.isArray(search?.items) ? search.items : []) {
        if (missing.has(item?.property_id) && id(item.property_id) && (text(item.name) || text(item.address))) {
          state.knownProperties.set(item.property_id, item); missing.delete(item.property_id);
        }
      }
      renderSelection();
      const next = search?.has_more && typeof search.cursor === "string" ? search.cursor : null;
      if (!next || next === cursor) return;
      cursor = next;
    }
  }
  // One save at a time: the pending request and its idempotency key are fixed before any await, so a double click reuses them.
  function saveSelection() {
    if (state.selectionSave) return state.selectionSave;
    if (!state.tour || !state.selectionDirty) return Promise.resolve();
    if (!state.pendingSelection) state.pendingSelection = { idempotency_key: uuid(), tour_id: state.tour.id,
      base_selection_version_id: state.cart?.selection_version_id || null, expected_selection_version: state.cart?.selection_version || 0,
      property_ids: [...state.selectedIds], selection_digest: null };
    const expected = state.pendingSelection;
    $("#save-selection").disabled = true;
    state.selectionSave = writeSelection(expected).finally(() => {
      state.selectionSave = null; $("#save-selection").disabled = !state.tour || !state.selectionDirty;
    });
    return state.selectionSave;
  }
  async function writeSelection(expected) {
    $("#selection-state").textContent = "Saving selection…";
    try {
      if (!expected.selection_digest) expected.selection_digest = await sha256(JSON.stringify(expected.property_ids));
      await post("/api/tours/selection-cart", expected);
      if (state.tour?.id !== expected.tour_id) return;
      const readBack = await loadSelectionCart(expected.tour_id);
      if (!readBack || state.cart?.selection_version !== expected.expected_selection_version + 1 ||
          JSON.stringify(state.cart.property_ids) !== JSON.stringify(expected.property_ids)) throw new Error("readback_unconfirmed");
      if (JSON.stringify(state.selectedIds) !== JSON.stringify(expected.property_ids)) {
        state.pendingSelection = null;
        renderSelection(); $("#selection-state").textContent = "Earlier selection saved. Your newer changes are unsaved; save again to keep them.";
        return;
      }
      state.selectionDirty = false; state.pendingSelection = null; state.undoSelectionIds = null;
      renderSelection(); $("#selection-state").textContent = `${state.selectedIds.length} selected · saved with this Tour.`;
    } catch (error) {
      if (error.message === "conflict") {
        const refreshed = await loadSelectionCart(state.tour.id);
        if (refreshed) state.pendingSelection = null;
        $("#selection-state").textContent = refreshed ?
          `Saved version changed to ${state.cart.selection_version}. Your draft remains; save again to replace that selection.` :
          "Saved version changed, but could not be loaded. Your draft remains; retry uses the same save request.";
      } else $("#selection-state").textContent =
        error.message === "readback_unconfirmed" ? "Save result could not be confirmed. Your choices remain here; retry uses the same save request." :
        "Selection could not be saved. Your choices remain here; retry uses the same save request.";
      renderSelection();
    }
  }
  function stops() { return Array.isArray(state.tour?.stops) ? state.tour.stops : []; }
  let composer = null, itineraryView = null;
  function renderAcceptedItinerary() {
    const root = $("#accepted-itinerary");
    const route = acceptedRouteFromDetail(state.tour);
    const options = { route, scope: sessionBinding };
    // PR 1443 deliberately does not authenticate or retrieve promotion receipts.
    // This surface withholds navigation until that upstream seam supplies one.
    if (!route) { itineraryView?.destroy(); itineraryView = null; root.hidden = true; return; }
    try {
      if (itineraryView) itineraryView.update(options);
      else itineraryView = mountAcceptedItinerary(root, options);
    } catch { itineraryView?.destroy(); itineraryView = null; root.hidden = false; root.textContent = "Accepted itinerary could not be read. Reload the saved Tour to retry."; }
  }
  const node = (tag, content, className) => { const el = document.createElement(tag); if (content) el.textContent = content; if (className) el.className = className; return el; };
  function routeRows(tour) {
    return (Array.isArray(tour?.stops) ? tour.stops : []).filter(stop => id(stop.property_id)).map(stop => ({ ...stop,
      route_label: text(stop.route_label, String(stop.route_sequence || 1)), stop_state: stop.stop_state || "active",
      dwell_minutes: Number(stop.dwell_minutes || 0), buffer_minutes: Number(stop.buffer_minutes || 0),
      locked_appointment: stop.locked_appointment === true, appointment_start: stop.appointment_start || null, appointment_end: stop.appointment_end || null }));
  }
  function initComposer(tour) {
    const rows = routeRows(tour), accepted = (tour.routes || []).find(route => route.accepted);
    const base = accepted ? { ...accepted, stops: routeRows({ stops: accepted.stops }) } : null;
    composer = { sessionBinding, tourId: tour.id, routeId: tour.route_version_id, prior: Number(tour.accepted_route_version || 0), snapshot: routeSnapshot(tour), reviewDigest: tour.routes?.[0]?.acceptance_digest || "", rows, base, dirty: false, saved: tour.route_version_state === "draft" && rows.length > 0,
      phase: "ready", message: "", busy: false, plan: null, undo: null };
    const retained = readPending()?.composer;
    if (retained?.tourId === tour.id && retained.plan) composer = { ...retained, busy: false, phase: "unknown", message: "Outcome unknown after reload. Reconcile the saved route before retrying the retained request." };
    for (const role of ["start", "end"]) {
      const point = routeEndpoints.get(tour.id)?.[role];
      const retainedPoint = composer.endpointDraft?.[role];
      $(`#edit-${role}-latitude`).value = retainedPoint?.latitude ?? point?.latitude ?? "";
      $(`#edit-${role}-longitude`).value = retainedPoint?.longitude ?? point?.longitude ?? "";
      $(`#edit-${role}-source`).value = retainedPoint?.source ?? point?.source_ref ?? "";
    }
    composer.endpointBaseline ??= endpointValues();
    $("#route-reviewed").checked = false;
  }
  function routeSnapshot(tour) { return JSON.stringify({ routeId: tour.route_version_id, prior: tour.accepted_route_version, routes: tour.routes, stops: tour.stops }); }
  function routeChanges() {
    if (!composer) return [];
    const prior = composer.base?.stops || [], changes = []; let order = 0;
    for (const row of composer.rows) {
      const seq = row.stop_state === "active" ? ++order : null;
      const old = prior.find(stop => stop.property_id === row.property_id);
      const name = text(row.name, text(knownProperty(row.property_id)?.name, "Saved property"));
      if (!old) changes.push(`${name}: added${row.stop_state !== "active" ? ` · ${row.stop_state}` : ` at ${seq}`}`);
      else {
        if (old.stop_state !== row.stop_state) changes.push(`${name}: ${old.stop_state} → ${row.stop_state}`);
        if (old.route_sequence !== seq) changes.push(`${name}: order ${old.route_sequence ?? "off route"} → ${seq ?? "off route"}`);
        if (old.route_label !== (row.stop_state === "active" ? row.route_label : null)) changes.push(`${name}: route label changed`);
        if (["dwell_minutes", "buffer_minutes", "appointment_start", "appointment_end", "locked_appointment"].some(field => old[field] !== row[field])) changes.push(`${name}: timing changed`);
      }
    }
    for (const old of prior) if (!composer.rows.some(row => row.property_id === old.property_id)) changes.push(`${text(old.name, "Saved property")}: removed`);
    for (const role of ["start", "end"]) if (JSON.stringify(composer.endpointBaseline?.[role]) !== JSON.stringify(endpointValues()[role])) changes.push(`${role === "start" ? "Start" : "End"} endpoint changed`);
    return changes;
  }
  function editableComposer() { return composer && !navigationBusy && !createPending && !createBusy && !composer.busy && !composer.saved && composer.phase === "ready" && !composer.plan; }
  function endpointValues() { return Object.fromEntries(["start", "end"].map(role => [role, Object.fromEntries(["latitude", "longitude", "source"].map(field => [field, $(`#edit-${role}-${field}`).value]))])); }
  function rememberEdit() { composer.undo = { rows: composer.rows.map(row => ({ ...row })), endpoints: composer.endpointDraft || endpointValues() }; composer.dirty = true; composer.message = "Unsaved route changes."; $("#route-reviewed").checked = false; }
  function localTime(value) {
    const date = new Date(value); if (!value || !Number.isFinite(date.getTime())) return "";
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function renderComposer() {
    if (!composer || !state.tour?.routes?.length) return;
    const editable = editableComposer(), list = $("#route-stops"); list.replaceChildren();
    let order = 0;
    composer.rows.forEach((row, index) => {
      const sequence = row.stop_state === "active" ? ++order : null;
      const item = node("li", "", `stop composer-stop ${row.stop_state}`); item.dataset.propertyId = row.property_id;
      const head = node("div", "", "stop-head"); head.append(node("span", sequence ? String(sequence).padStart(2, "0") : "—", "stop-number"), node("strong", text(row.name, text(knownProperty(row.property_id)?.name, "Saved property"))));
      item.append(head, node("p", text(row.address, text(knownProperty(row.property_id)?.address, "Address unavailable")), "hint"));
      const identity = node("details", "", "stop-identity"); identity.append(node("summary", "Property identity"), node("code", row.property_id)); item.append(identity);
      const fields = node("div", "", "stop-fields");
      for (const [field, title, type] of [["route_label", "Route label", "text"], ["stop_state", "Stop state", "select"], ["dwell_minutes", "Dwell minutes", "number"], ["buffer_minutes", "Buffer minutes", "number"], ["appointment_start", "Appointment start", "datetime-local"], ["appointment_end", "Appointment end", "datetime-local"], ["locked_appointment", "Fixed appointment", "checkbox"]]) {
        const label = node("label", title), control = node(type === "select" ? "select" : "input"); control.dataset.field = field;
        control.setAttribute("aria-label", `${title} for ${text(row.name, "saved property")}`);
        if (type === "select") for (const value of ["active", "held", "excluded"]) { const option = node("option", value[0].toUpperCase() + value.slice(1)); option.value = value; control.append(option); }
        else control.type = type;
        if (type === "checkbox") control.checked = row[field];
        else control.value = type === "datetime-local" ? localTime(row[field]) : row[field] ?? "";
        if (type === "number") { control.min = "0"; control.max = "1440"; control.step = "1"; }
        if (field === "route_label") control.maxLength = 3;
        const locked = composer.base?.stops.find(old => old.property_id === row.property_id)?.locked_appointment;
        control.disabled = !editable || (locked && field !== "route_label") || (row.stop_state !== "active" && field === "route_label");
        control.addEventListener(type === "checkbox" || type === "select" ? "change" : "input", () => {
          if (!editableComposer()) return; rememberEdit();
          row[field] = type === "checkbox" ? control.checked : type === "number" ? control.value === "" ? NaN : Number(control.value) : type === "datetime-local" ? control.value ? new Date(control.value).toISOString() : null : control.value;
          if (type === "select") renderComposer(); else renderComposerSummary();
        });
        label.append(control); fields.append(label);
      }
      item.append(fields);
      const controls = node("div", "", "stop-controls");
      for (const [word, delta] of [["Up", -1], ["Down", 1]]) {
        const button = node("button", word); button.type = "button"; button.disabled = !editable || index + delta < 0 || index + delta >= composer.rows.length;
        button.addEventListener("click", () => {
          if (!editableComposer()) return;
          const focused = document.activeElement === button;
          rememberEdit(); const rows = composer.rows;
          [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]];
          renderComposer();
          if (focused) {
            const moved = [...list.children].find(item => item.dataset.propertyId === row.property_id);
            const actions = [...moved.querySelectorAll(".stop-controls button")];
            (actions.find(action => action.textContent === word && !action.disabled) || actions.find(action => !action.disabled))?.focus();
          }
        }); controls.append(button);
      }
      item.append(controls); list.append(item);
    });
    if (!composer.rows.length) list.append(node("li", "Add properties from the selection cart."));
    renderComposerSummary();
    mountPropertyPanel({ tour: { ...state.tour, stops: composer.rows }, request });
  }
  function renderComposerSummary() {
    if (!composer) return;
    const changes = $("#route-changes"); changes.replaceChildren();
    for (const change of routeChanges()) changes.append(node("li", change));
    if (!changes.children.length) changes.append(node("li", "No changes from the accepted route."));
    $("#composer-badge").textContent = composer.phase === "ready" ? composer.dirty ? "Unsaved" : composer.saved ? "Review draft" : state.tour.route_version_state === "accepted" ? "Accepted" : "Draft" : composer.phase;
    $("#composer-badge").dataset.phase = composer.phase;
    $("#composer-state").textContent = (composer.saved && composer.phase === "ready" && !digest(composer.reviewDigest) ? "Route review digest unavailable. Reload after the Tour service is updated before accepting." : composer.message || (composer.saved ? "Draft saved. Review all changes before accepting this route." : "Add cart properties, then set stop order and timing."));
    $("#add-cart-stops").disabled = !editableComposer() || !state.selectedIds.length;
    $("#route-endpoint-editor").hidden = !composer.base;
    for (const control of document.querySelectorAll("#route-endpoint-editor input")) control.disabled = !editableComposer();
    $("#undo-route").hidden = !composer.undo || !editableComposer();
    $("#save-composer").disabled = !editableComposer() || !composer.dirty || !composer.rows.some(row => row.stop_state === "active");
    $("#reconcile-composer").hidden = composer.phase !== "unknown";
    $("#retry-composer").hidden = composer.phase !== "reconciled";
    $("#reload-composer").disabled = navigationBusy || composer.busy || composer.phase === "unknown" || composer.phase === "reconciled";
    $("#route-reviewed").disabled = navigationBusy || Boolean(createPending) || composer.busy || composer.dirty || composer.phase !== "ready" || !composer.saved || !digest(composer.reviewDigest);
    $("#accept-route").hidden = state.tour.route_version_state !== "draft";
    $("#accept-route").disabled = navigationBusy || Boolean(createPending) || !composer.saved || composer.dirty || composer.busy || composer.phase !== "ready" || !$("#route-reviewed").checked || !digest(composer.reviewDigest);
  }
  function addCartStops() {
    if (!editableComposer()) return;
    const added = state.selectedIds.filter(propertyId => !composer.rows.some(row => row.property_id === propertyId));
    if (!added.length) { composer.message = "All cart properties are already in this route."; renderComposerSummary(); return; }
    if (composer.rows.length + added.length > 100) { composer.message = "A route supports up to 100 properties."; renderComposerSummary(); return; }
    rememberEdit();
    for (const property_id of added) {
      const property = knownProperty(property_id);
      composer.rows.push({ property_id, name: property?.name || null, address: property?.address || null,
        route_label: String(composer.rows.length + 1), stop_state: "active", dwell_minutes: 30, buffer_minutes: 10,
        locked_appointment: false, appointment_start: null, appointment_end: null, access_coordinate_status: "unknown" });
    }
    renderComposer();
  }
  async function saveComposer() {
    if (!editableComposer() || !composer.dirty) return;
    const current = composer; current.busy = true; renderComposerSummary();
    try {
      let sequence = 0; const labels = new Set();
      const rows = current.rows.map(row => {
        const active = row.stop_state === "active", label = active ? row.route_label.trim() : null;
        if (active && (!/^[A-Za-z0-9]{1,3}$/.test(label) || labels.has(label))) throw new Error("Use a unique route label of 1–3 letters or numbers for each active stop.");
        labels.add(label);
        if (![row.dwell_minutes, row.buffer_minutes].every(value => Number.isInteger(value) && value >= 0 && value <= 1440)) throw new Error("Dwell and buffer must be whole minutes from 0 to 1440.");
        if (Boolean(row.appointment_start) !== Boolean(row.appointment_end) || (row.appointment_start && Date.parse(row.appointment_end) < Date.parse(row.appointment_start)) || (row.locked_appointment && !row.appointment_start)) throw new Error("Each appointment needs a start and end; a fixed appointment needs a time window.");
        if (row.locked_appointment && !active) throw new Error("A fixed appointment must stay active. Reactivate the stop or clear its fixed appointment before saving.");
        return { ...row, route_sequence: active ? ++sequence : null, route_label: label };
      });
      if (!sequence) throw new Error("Keep at least one active stop before saving.");
      const locked = rows.filter(row => row.locked_appointment && row.stop_state === "active");
      if (locked.some((row, index) => index > 0 && Date.parse(row.appointment_start) < Date.parse(locked[index - 1].appointment_start))) throw new Error("Stop order must preserve the order of fixed appointments.");
      const base = current.base, latest = state.tour.routes?.[0];
      const plan = { kind: "save", tourId: current.tourId, routeId: base ? null : state.tour.route_version_id, steps: [], index: 0 };
      if (base) plan.steps.push({ path: "/api/tours/route-draft", body: { idempotency_key: uuid(), tour_id: current.tourId,
        route_version: Number(latest?.route_version || state.tour.route_version || 1) + 1, base_route_version_id: base.id,
        expected_route_version: base.route_version, start_point: endpoint("start", "edit-"), end_point: endpoint("end", "edit-") }, resultField: "route_version_id" });
      for (const row of rows) {
        // Bind the candidate facts visible to the operator; unknown access remains unknown.
        const assertion = row.assertion_set_digest || await sha256(JSON.stringify({ property_id: row.property_id, candidate: knownProperty(row.property_id) || { name: row.name, address: row.address } }));
        const stopIndex = plan.steps.length;
        plan.steps.push({ path: "/api/tours/route-stop", body: { idempotency_key: uuid(), route_version_id: plan.routeId,
          property_id: row.property_id, route_sequence: row.route_sequence, route_label: row.route_label, stop_state: row.stop_state,
          appointment_start: row.appointment_start, appointment_end: row.appointment_end, locked_appointment: row.locked_appointment,
          dwell_minutes: row.dwell_minutes, buffer_minutes: row.buffer_minutes, access_coordinate_status: row.access_coordinate_status || "unknown", assertion_set_digest: assertion }, resultField: "route_stop_id" });
        const old = base?.stops.find(stop => stop.property_id === row.property_id);
        const disposition = !old ? "added" : row.stop_state !== "active" ? row.stop_state : old.route_sequence !== row.route_sequence ? "reordered" : "unchanged";
        plan.steps.push({ path: "/api/tours/route-stop-transition", stopIndex, body: { idempotency_key: uuid(),
          old_route_version_id: old ? base.id : null, new_route_version_id: plan.routeId, old_route_stop_id: old?.id || null,
          new_route_stop_id: null, disposition }, resultField: "route_stop_transition_id" });
      }
      current.rows = rows; current.plan = plan;
      persistPending();
      await runComposerPlan(current);
    } catch (error) { if (error.message === "point_invalid") $("#route-endpoint-editor").open = true; current.message = error.message === "point_invalid" ? "Enter route endpoints with valid coordinates and location sources for this new version." : error.message; }
    finally { current.busy = false; if (composer === current) renderComposer(); }
  }
  async function runComposerPlan(current) {
    const plan = current.plan;
    try {
      for (; plan.index < plan.steps.length; plan.index++) {
        const step = plan.steps[plan.index];
        if (step.path === "/api/tours/route-stop") step.body.route_version_id = plan.routeId;
        if (step.path === "/api/tours/route-stop-transition") { step.body.new_route_version_id = plan.routeId; step.body.new_route_stop_id = plan.steps[step.stopIndex].result; }
        current.message = `Saving draft · ${plan.index + 1} of ${plan.steps.length}`; if (composer === current) renderComposerSummary();
        persistPending();
        const data = await post(step.path, step.body, current.sessionBinding);
        if (!id(data[step.resultField])) throw new Error("outcome_unknown");
        step.result = data[step.resultField]; if (step.path === "/api/tours/route-draft") { plan.routeId = step.result; routeEndpoints.set(plan.tourId, { start: step.body.start_point, end: step.body.end_point }); }
      }
      const detail = await composerDetail(plan.tourId);
      if (plan.kind !== "accept" && detail.route_version_id !== plan.routeId) throw new Error("outcome_unknown");
      if (plan.kind === "accept" ? !detail.routes.some(route => route.id === plan.routeId && route.accepted) :
        !plan.steps.filter(step => step.path === "/api/tours/route-stop").every(step => detail.stops?.some(stop => stop.id === step.result))) throw new Error("outcome_unknown");
      current.plan = null; current.phase = "ready"; current.dirty = false; current.saved = plan.kind !== "accept"; current.undo = null;
      persistPending();
      current.message = plan.kind === "accept" ? "Route accepted. Later edits create a new version." : "Draft saved. Review every changed order and exclusion, then accept the route.";
      if (composer === current) {
        state.tour = detail;
        if (plan.kind === "accept") { initComposer(detail); composer.message = "Route accepted. Later edits create a new version."; }
        else { current.routeId = detail.route_version_id; current.prior = Number(detail.accepted_route_version || 0); current.snapshot = routeSnapshot(detail); current.reviewDigest = detail.routes[0].acceptance_digest || ""; current.rows = routeRows(detail); }
        $("#route-reviewed").checked = false; renderTour();
      }
    } catch (error) {
      if (current.sessionBinding !== sessionBinding) { current.plan = null; current.phase = "session-changed"; return; }
      current.phase = error.writeRefusal ? error.status === 409 ? "stale" : "refused" : "unknown";
      current.message = current.phase === "stale" ? "Saved route changed. This write was refused; your draft remains. Reload the saved route before editing again." : current.phase === "refused" ? "Write refused. Your draft remains. Reload the saved route to review the current version." : "Outcome unknown. Some writes may have landed. Reconcile before retrying; the same request keys are retained.";
      persistPending();
    }
  }
  async function acceptComposer() {
    if (!composer || navigationBusy || createPending || !composer.saved || composer.dirty || composer.busy || composer.phase !== "ready" || !$("#route-reviewed").checked || !digest(composer.reviewDigest)) return;
    const current = composer; current.busy = true; renderComposerSummary();
    const prior = current.prior, routeId = current.routeId;
    // Bind the displayed stop set; a fresh read at Accept could include unreviewed changes.
    current.plan = { kind: "accept", tourId: current.tourId, routeId, index: 0, steps: [{ path: "/api/tours/route-accept", resultField: "route_version_acceptance_id",
      body: { route_version_id: routeId, expected_prior_route_version: prior, acceptance_digest: current.reviewDigest, idempotency_key: uuid() } }] };
    persistPending();
    await runComposerPlan(current); current.busy = false; if (composer === current) renderComposer();
  }
  function renderShareGrants() { const list = $("#share-grants"); list.replaceChildren(); for (const grant of state.shareGrants) { if (!id(grant?.share_grant_id)) continue; const row = document.createElement("li"); const summary = document.createElement("span"); summary.textContent = `${text(grant.status, "unknown")} · projection ${text(grant.projection_id, "unknown")} · expires ${formatTourDate(grant.expires_at) || "unknown"}`; row.append(summary); if (grant.status === "active") { const button = document.createElement("button"); button.type = "button"; button.textContent = "Revoke"; button.dataset.shareGrantId = grant.share_grant_id; row.append(button); } list.append(row); } if (!list.children.length) list.textContent = "No active or rotatable confidential links."; }
  function renderFeedback() {
    const list = $("#feedback-list"); list.replaceChildren();
    const items = Array.isArray(state.feedback?.items) ? state.feedback.items : [];
    for (const item of items) {
      if (!item.shortlisted && !item.comments?.length) continue;
      const row = document.createElement("li");
      const title = document.createElement("strong"); title.textContent = text(item.route_label, "Tour property"); row.append(title);
      if (item.shortlisted) { const badge = document.createElement("p"); badge.className = "shortlisted"; badge.textContent = "Shortlisted"; row.append(badge); }
      for (const entry of Array.isArray(item.comments) ? item.comments : []) {
        const comment = document.createElement("p"); comment.textContent = text(entry.comment); row.append(comment);
      }
      list.append(row);
    }
    $("#feedback-empty").hidden = state.feedbackStatus !== "ready" || list.children.length > 0;
    list.setAttribute("aria-busy", String(state.feedbackStatus === "loading"));
    $("#feedback-state").textContent = state.feedbackStatus === "loading" ? "Loading client responses…" :
      state.feedbackStatus === "unavailable" ? "Client responses temporarily unavailable" :
      state.feedbackStatus === "missing" ? "Client responses unavailable" : "";
    $("#refresh-feedback").disabled = !id(state.projectionId);
  }
  async function loadFeedback() {
    const projectionId = state.projectionId;
    const seq = ++state.feedbackSeq;
    state.feedback = null;
    state.feedbackStatus = id(projectionId) ? "loading" : "missing";
    renderFeedback();
    if (id(projectionId)) {
      try {
        const data = await request(`/api/tours/feedback?projection_id=${encodeURIComponent(projectionId)}`);
        const feedback = data.feedback;
        if (!Array.isArray(feedback?.items)) throw new Error("read_invalid");
        if (seq !== state.feedbackSeq || projectionId !== state.projectionId) return;
        state.feedback = feedback;
        state.feedbackStatus = "ready";
        status("Client responses loaded.");
      }
      catch {
        if (seq !== state.feedbackSeq || projectionId !== state.projectionId) return;
        state.feedbackStatus = "unavailable";
        status("Client responses are unavailable.");
      }
    }
    if (seq !== state.feedbackSeq || projectionId !== state.projectionId) return;
    renderFeedback();
  }
  function renderTour() {
    const tour = state.tour; if (!tour) return;
    const priorProjectionId = state.projectionId;
    $("#empty-state").hidden = true; $("#tour-panel").hidden = false;
    $("#tour-name").textContent = text(tour.name, "Untitled tour"); $("#tour-state").textContent = text(tour.status, "Draft");
    $("#tour-meta").textContent = tourMetaLine(tour);
    $("#route-version").textContent = text(tour.route_version_label, tour.route_version_id ? "Current version" : "No route version");
    $("#save-route").hidden = tour.route_version_state !== "accepted";
    $("#reorder-route").hidden = tour.route_version_state !== "draft";
    $("#accept-route").hidden = tour.route_version_state !== "draft";
    state.projectionId = text(tour.projection_id); state.projectionDraftId = text(tour.projection_draft_id); state.shareGrantId = text(tour.share_grant_id); state.shareStatus = text(tour.share_status, "missing"); state.shareGrants = Array.isArray(tour.share_grants) ? tour.share_grants : [];
    if (priorProjectionId !== state.projectionId) {
      ++state.feedbackSeq; state.feedback = null;
      state.feedbackStatus = id(state.projectionId) ? "loading" : "missing";
    }
    renderFeedback();
    const activeShareCount = state.shareGrants.filter((grant) => grant?.status === "active").length;
    $("#projection-state").textContent = state.projectionId ? "Approved" : tour.projection_status === "draft" ? "Draft · approval required" : "Not generated"; $("#share-state").textContent = activeShareCount ? `${activeShareCount} active` : state.shareStatus === "expired" ? "Expired · rotate" : "Not issued"; renderShareGrants();
    if (state.pendingShare) {
      $("#share-link").hidden = true;
      $("#share-state").textContent = "Outcome unknown";
      $("#rotate-share").textContent = "Check link outcome";
    }
    $("#projection-note").textContent = state.projectionId ? "The approved projection is ready for a deliberately scoped, expiring share." : tour.projection_status === "draft" ? "A projection draft exists but cannot be shared until a human authority seals it." : "A projection is required before an external link can be issued.";
    if (!state.cheatDirty || state.cheatDraftTourId !== tour.id) {
      $("#cheat-content").value = cheatSheetText(tour.cheat_sheet?.content);
      state.cheatDirty = false; state.cheatDraftTourId = tour.id;
    }
    $("#sheet-state").textContent = state.cheatDirty ? "Unsaved changes" : text(tour.cheat_sheet?.revision_label, "Not saved");
    const list = $("#route-stops"); list.replaceChildren();
    for (const stop of stops()) { const row = document.createElement("li"); row.className = "stop"; row.dataset.stopId = text(stop.id); const label = document.createElement("span"); label.textContent = text(stop.label, text(stop.name, "Tour stop")); const controls = document.createElement("span"); for (const [word, delta] of [["Up", -1], ["Down", 1]]) { const button = document.createElement("button"); button.type = "button"; button.textContent = word; button.addEventListener("click", () => moveStop(stop.id, delta)); controls.append(button); } row.append(label, controls); list.append(row); }
    if (!stops().length) list.textContent = "No stops in this route cart.";
    state.renderJobId = text(tour.pdf_render_job_id); state.pdfQcRunDigest = text(tour.pdf_qc_run_digest);
    $("#pdf-state").textContent = text(tour.pdf_status, "Not rendered").replaceAll("_", " ");
    const reviewable = tour.pdf_status === "review_ready" && id(state.renderJobId);
    $("#preview-pdf").hidden = !reviewable;
    $("#review-pdf").hidden = !reviewable;
    if (reviewable) $("#preview-pdf").href = `/api/tours/pdf/preview?render_job_id=${encodeURIComponent(state.renderJobId)}`;
    const downloadable = tour.pdf_status === "available" && id(state.renderJobId);
    $("#download-pdf").hidden = !downloadable;
    if (downloadable) $("#download-pdf").href = `/api/tours/pdf/download?render_job_id=${encodeURIComponent(state.renderJobId)}`;
    mountPropertyPanel({ tour, request });
    if (composer && tour.routes?.length) renderComposer();
    renderAcceptedItinerary();
  }
  async function loadLibrary() {
    status("Loading tours…"); const data = await request("/api/tours/library");
    if (!Array.isArray(data.tours) || !data.tours.every(tour => id(tour?.id))) throw new Error("read_invalid");
    libraryReady = true;
    if (!createPending && readPending()?.create) { createPending = readPending().create; createPhase = "unknown"; $("#create-tour-panel").open = true; $("#create-tour-state").textContent = "Creation outcome unknown after reload. Reconcile before retrying the retained request."; renderCreate(); }
    state.tours = Array.isArray(data.tours) ? data.tours.filter((tour) => id(tour?.id)) : []; renderLibrary(); status("Tour library ready.");
    const retained = readPending()?.composer;
    if (!composer && retained?.plan && id(retained.tourId)) {
      restoredTourId = retained.tourId; renderCreate(); status("An unresolved route request must be reconciled before another Tour can be edited.");
      await loadTour(restoredTourId);
    }
    if (!state.tour && !retained?.plan && !createPending) {
      const requestedTour = new URLSearchParams(window.location.search).get("tour");
      if (id(requestedTour) && state.tours.some(tour => tour.id === requestedTour)) await loadTour(requestedTour, { requireComposerDetail: true });
      let saved = null;
      try {
        saved = JSON.parse(sessionStorage.getItem("doctorcre-itinerary-tour-v1") || "null");
      } catch { /* Invalid tab pointers do not select a Tour. */ }
      if (!state.tour && saved?.scope === sessionBinding && state.tours.some(tour => tour.id === saved.tour_id)) {
        try { await loadTour(saved.tour_id, { requireComposerDetail: true }); }
        catch { status("Saved Tour temporarily unavailable."); }
      }
    }
    renderCreate();
  }
  async function loadProjectionPreview() { const preview = $("#projection-preview"); state.candidateDigest = ""; preview.hidden = true; preview.textContent = ""; if (!id(state.projectionDraftId)) return; const data = await request(`/api/tours/projection/candidates?projection_id=${encodeURIComponent(state.projectionDraftId)}`); state.candidateDigest = text(data.candidate_digest); const rows = Array.isArray(data.preview) ? data.preview : []; preview.textContent = rows.map(row => { const facts = row?.facts && typeof row.facts === "object" ? row.facts : {}; return `${text(row.route_label, `Stop ${row.route_sequence || ""}`)} · ${text(facts["display.name"], "Unnamed property")}\n${text(facts["display.address"], "Address unavailable")}${factSummary(facts) ? `\n${factSummary(facts)}` : ""}`; }).join("\n\n"); preview.hidden = false; }
  let tourLoadSeq = 0;
  async function loadTour(tourId, { requireComposerDetail = false } = {}) {
    if (state.pendingShare && state.pendingShare.tourId !== tourId) { status("Check link outcome before switching Tours."); return; }
    if (state.shareBusy) return;
    if (restoredTourId && restoredTourId !== tourId) { status("Reconcile the retained Tour before switching Tours."); return; }
    if (navigationBusy || composer?.busy) return;
    if (composer?.tourId !== tourId && (composer?.dirty || composer?.plan || composer?.busy)) { status("Save or reconcile the current route before switching Tours."); return; }
    navigationBusy = true; if (composer) renderComposer(); renderCreate();
    try {
      const seq = ++tourLoadSeq; ++state.feedbackSeq; status("Loading tour…");
      const tour = await request(`/api/tours/detail?tour_id=${encodeURIComponent(tourId)}`);
      if (requireComposerDetail || tour.routes?.length || createPending || restoredTourId) validateDetail(tour, tourId);
      if (seq !== tourLoadSeq) return;
      const changed = composer && composer.snapshot !== routeSnapshot(tour);
      if (changed && (composer.dirty || composer.plan || composer.busy)) { status("Saved route changed. Save or reconcile the displayed draft before reloading."); return; }
      if (state.tour?.id !== tourId) { state.rawShareToken = ""; state.shareGrantId = ""; $("#share-url").value = ""; $("#share-link").hidden = true; ++state.hydrationSeq; state.cheatDirty = false; state.cheatDraftTourId = tourId; state.selectedIds = []; state.cart = null; state.selectionDirty = false; state.pendingSelection = null; state.undoSelectionIds = null; state.selectionTourId = tourId; }
      state.tour = tour;
      if (!composer || composer.tourId !== tourId || changed) initComposer(tour);
      restoredTourId = "";
      renderTour(); renderSelection(); await loadSelectionCart(tourId); await Promise.all([loadProjectionPreview(), loadFeedback()]);
      if (state.tour?.id === tourId) status(state.feedbackStatus === "unavailable" ? "Tour loaded. Client responses are unavailable." : "Tour ready.");
    } finally { navigationBusy = false; if (composer) renderComposer(); renderCreate(); }
  }
  function moveStop(stopId, delta) { const list = stops(); const index = list.findIndex((stop) => stop.id === stopId); const destination = index + delta; if (index < 0 || destination < 0 || destination >= list.length) return; [list[index], list[destination]] = [list[destination], list[index]]; renderTour(); }
  async function saveRoute(reorder = false) { if (!state.tour) return; const stopIds = stops().filter((stop) => stop.stop_state === "active").map((stop) => stop.id).filter(id); const path = reorder ? "/api/tours/route-reorder" : "/api/tours/route-version"; const payload = reorder ? { tour_id: state.tour.id, route_version_id: state.tour.route_version_id, expected_route_version: Number(state.tour.route_version || 0), stop_ids: stopIds, idempotency_key: uuid() } : { tour_id: state.tour.id, expected_route_version: Number(state.tour.route_version || 0), stop_ids: stopIds, idempotency_key: uuid() }; await post(path, payload); await loadTour(state.tour.id); status("Route version saved."); }
  async function saveSheet() {
    if (!state.tour) return;
    const tourId = state.tour.id, draft = $("#cheat-content").value;
    let content;
    try { content = JSON.parse(draft || "{}"); } catch { content = { notes: draft }; }
    await post("/api/tours/cheat-sheet/autosave", { tour_id: tourId, content,
      expected_revision_number: Number(state.tour.cheat_sheet?.revision_number || 0), idempotency_key: uuid() });
    if (state.tour?.id !== tourId) return;
    if ($("#cheat-content").value === draft) state.cheatDirty = false;
    await loadTour(tourId);
    status(state.cheatDirty ? "Internal cheat sheet saved. Newer changes remain unsaved." : "Internal cheat sheet saved.");
  }
  async function issueShare(rotate = false) {
    if (state.shareBusy) return;
    if (!state.pendingShare && !state.projectionId) throw new Error("projection_required");
    const tourId = state.tour?.id, projectionId = state.projectionId;
    if (state.pendingShare && state.pendingShare.tourId !== tourId) throw new Error("Reconcile the retained confidential link before switching Tours.");
    state.shareBusy = true;
    try {
      if (!state.pendingShare) {
        const scopes = [...document.querySelectorAll('input[name="scope"]:checked')].map(box => box.value);
        if ((scopes.includes("shortlist") || scopes.includes("comment")) && !scopes.includes("view_packet")) throw new Error("packet_scope_required");
        const expires = new Date($("#share-expiry").value).toISOString();
        const receipt = $("#receipt-digest").value.trim();
        if (!digest(receipt) || !scopes.length || !Number.isFinite(Date.parse(expires))) throw new Error("share_details_invalid");
        if (rotate && !id(state.shareGrantId)) throw new Error("share_grant_required");
        const raw = newShareToken(), tokenDigest = await sha256(raw);
        if (state.tour?.id !== tourId || state.projectionId !== projectionId) return;
        const payload = { projection_id: projectionId, token_digest: tokenDigest, permission_scopes: scopes,
          expires_at: expires, receipt_digest: receipt, idempotency_key: uuid(),
          ...(rotate ? { share_grant_id: state.shareGrantId } : {}) };
        state.pendingShare = { tourId, projectionId, raw, payload, path: rotate ? "/api/tours/share/rotate" : "/api/tours/share/issue" };
      }
      const pending = state.pendingShare;
      const data = await post(pending.path, pending.payload);
      if (state.tour?.id !== tourId) return;
      if (!id(data?.share_grant_id) || data.ok === false) throw new Error("share_receipt_unavailable");
      state.rawShareToken = pending.raw;
      const currentProjection = state.projectionId === pending.projectionId;
      if (currentProjection) state.shareGrantId = data.share_grant_id;
      state.pendingShare = null;
      $("#share-url").value = `https://reports.doctorcre.com/share#token=${pending.raw}`;
      $("#share-link").hidden = false;
      $("#share-state").textContent = currentProjection ? "Active" : "Active · earlier projection";
      $("#rotate-share").textContent = "Rotate current";
      status("Confidential link generated. Copy it now.");
    } catch (error) {
      if (state.pendingShare && state.tour?.id === tourId) {
        const validationRefused = error.status === 400 && typeof error.payload?.error === "string" && !!error.payload.error.trim();
        if (validationRefused && !state.pendingShare.uncertain) {
          state.pendingShare = null;
          $("#share-state").textContent = "Request refused";
          $("#rotate-share").textContent = "Rotate current";
          status("Link request refused. Correct the fields and try again.");
        } else {
          state.pendingShare.uncertain = true;
          $("#share-link").hidden = true;
          $("#share-state").textContent = "Outcome unknown";
          $("#rotate-share").textContent = "Check link outcome";
          status("Link outcome unknown. Check link outcome replays the retained request.");
        }
      }
      throw error;
    } finally { state.shareBusy = false; }
  }
  async function revokeShare(grantId) { if (!id(grantId)) return; const receipt = $("#receipt-digest").value.trim(); if (!digest(receipt)) throw new Error("receipt_digest_required"); await post("/api/tours/share/revoke", { share_grant_id: grantId, reason: "Internal operator revoked link", revoked_at: new Date().toISOString(), receipt_digest: receipt, idempotency_key: uuid() }); state.rawShareToken = ""; $("#share-link").hidden = true; await loadTour(state.tour.id); status("Share link revoked."); }
  async function action(work) { try { await work(); } catch { status("The request could not be completed."); } }
  // Versioned route and cheat-sheet writes ignore a second click while a write to the same record is in flight.
  const writesInFlight = new Set();
  const exclusive = (record, work) => () => { if (writesInFlight.has(record)) return; writesInFlight.add(record); void action(work).finally(() => writesInFlight.delete(record)); };
  $("#create-tour-form").addEventListener("submit", event => { event.preventDefault(); void createTour(); });
  $("#reconcile-create").addEventListener("click", () => void action(async () => {
    if (!createPending || createBusy || createPhase !== "unknown") return;
    createBusy = true; renderCreate();
    try { await loadLibrary(); createPhase = "reconciled"; $("#create-tour-state").textContent = "Tour library checked. Retry the same creation request to confirm its Tour without creating a duplicate."; }
    catch { $("#create-tour-state").textContent = "Creation reconciliation failed. Retry reconciliation; no creation was resent."; }
    finally { createBusy = false; renderCreate(); }
  }));
  $("#add-cart-stops").addEventListener("click", addCartStops);
  $("#save-composer").addEventListener("click", () => void saveComposer());
  for (const control of document.querySelectorAll("#route-endpoint-editor input")) control.addEventListener("input", () => {
    if (!editableComposer()) return;
    composer.endpointDraft ??= composer.endpointBaseline; rememberEdit(); composer.endpointDraft = endpointValues(); renderComposerSummary();
  });
  $("#undo-route").addEventListener("click", () => {
    if (!editableComposer() || !composer.undo) return;
    composer.rows = composer.undo.rows;
    for (const role of ["start", "end"]) for (const field of ["latitude", "longitude", "source"]) $(`#edit-${role}-${field}`).value = composer.undo.endpoints[role][field];
    composer.endpointDraft = endpointValues(); composer.undo = null; composer.dirty = true; composer.message = "Last route edit undone. Save to keep this draft."; renderComposer();
  });
  $("#route-reviewed").addEventListener("change", renderComposerSummary);
  $("#reload-composer").addEventListener("click", () => void action(async () => {
    if (!composer || navigationBusy || composer.busy || ["unknown", "reconciled"].includes(composer.phase)) return;
    const current = composer, plan = current.plan; current.busy = true; renderComposer();
    try {
      const detail = await composerDetail(current.tourId);
      if (composer !== current || current.plan !== plan) return;
      if (plan?.kind === "save" && plan.routeId && plan.index < plan.steps.length && detail.routes?.some(route => route.id === plan.routeId)) {
        current.phase = "reconciled"; current.saved = false;
        current.message = "Partial route assembly checked. Resume the retained request to finish stops and transitions before review.";
        return;
      }
      current.plan = null; persistPending(); state.tour = detail; initComposer(detail); composer.message = "Saved route reloaded. Local edits were discarded."; renderTour();
    } finally { current.busy = false; renderComposer(); }
  }));
  $("#reconcile-composer").addEventListener("click", () => void action(async () => {
    if (!composer || composer.busy || composer.phase !== "unknown") return;
    const current = composer; current.busy = true; renderComposerSummary();
    try {
      const detail = await composerDetail(current.tourId);
      if (current.plan?.kind === "accept" && detail.routes.some(route => route.id === current.plan.routeId && route.accepted)) {
        current.plan = null; persistPending(); state.tour = detail; initComposer(detail); composer.message = "Reconciled: this route was accepted. No duplicate acceptance was sent."; renderTour();
      } else { current.phase = "reconciled"; current.message = "Saved route checked. The write outcome still needs confirmation. Retry the retained request with the same keys."; }
    } catch { current.message = "Reconciliation read failed. Retry reconciliation; no write has been resent."; }
    finally { current.busy = false; renderComposerSummary(); }
  }));
  $("#retry-composer").addEventListener("click", () => void action(async () => {
    if (!composer || composer.busy || composer.phase !== "reconciled" || !composer.plan) return;
    const current = composer; current.busy = true; renderComposerSummary(); await runComposerPlan(current); current.busy = false; renderComposer();
  }));
  $("#property-search-form").addEventListener("submit", event => { event.preventDefault(); void searchProperties(); });
  const invalidateSearch = () => { ++state.searchSeq; state.searchItems = []; state.searchCursor = null; state.searchKey = null; state.searchCompleted = false; renderSearchResults(); $("#search-state").textContent = "Filters changed. Find properties to see matching candidates."; };
  $("#property-search-form").addEventListener("input", invalidateSearch);
  $("#property-search-form").addEventListener("change", invalidateSearch);
  $("#clear-search").addEventListener("click", () => { $("#property-search-form").reset(); void searchProperties(); });
  $("#more-properties").addEventListener("click", () => void searchProperties(true));
  $("#save-selection").addEventListener("click", () => void saveSelection());
  $("#undo-selection").addEventListener("click", () => { if (!state.undoSelectionIds) return; state.selectedIds = state.undoSelectionIds; state.undoSelectionIds = null; state.selectionDirty = true; state.pendingSelection = null; renderSearchResults(); $("#selection-state").textContent = "Selection change undone. Save to keep this version."; });
  for (const node of document.querySelectorAll("#territory-visual .county")) {
    node.setAttribute("tabindex", "0"); node.setAttribute("role", "button"); node.setAttribute("aria-label", `Filter ${node.dataset.county} county`);
    const activate = () => { $("#property-county").value = node.dataset.county; void searchProperties(); };
    node.addEventListener("click", activate);
    node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
    node.addEventListener("mouseenter", () => { for (const item of document.querySelectorAll("#property-results .property-result")) item.classList.toggle("county-highlight", item.dataset.county === node.dataset.county); });
    node.addEventListener("mouseleave", () => { for (const item of document.querySelectorAll("#property-results .property-result")) item.classList.remove("county-highlight"); });
  }
  $("#refresh").addEventListener("click", () => void action(loadLibrary)); $("#save-route").addEventListener("click", exclusive("route", () => saveRoute(false))); $("#reorder-route").addEventListener("click", exclusive("route", () => saveRoute(true)));
  $("#accept-route").addEventListener("click", exclusive("route", async () => { if (state.tour?.routes?.length) return acceptComposer(); if (!state.tour?.route_version_id || !digest(state.tour.route_acceptance_digest)) return; const prior = Number(state.tour.accepted_route_version || 0); await post("/api/tours/route-accept", { route_version_id: state.tour.route_version_id, expected_prior_route_version: prior, acceptance_digest: state.tour.route_acceptance_digest, idempotency_key: uuid() }); await loadTour(state.tour.id); status("Route version accepted."); }));
  $("#cheat-content").addEventListener("input", () => { state.cheatDirty = true; state.cheatDraftTourId = state.tour?.id || ""; $("#sheet-state").textContent = "Unsaved changes"; });
  $("#save-sheet").addEventListener("click", exclusive("sheet", saveSheet)); $("#restore-sheet").addEventListener("click", exclusive("sheet", async () => { const revision = state.tour?.cheat_sheet?.restore_revision_id; if (!state.tour || !id(revision)) return; await post("/api/tours/cheat-sheet/restore", { tour_id: state.tour.id, restore_revision_id: revision, expected_revision_number: Number(state.tour.cheat_sheet?.revision_number || 0), idempotency_key: uuid() }); state.cheatDirty = false; await loadTour(state.tour.id); }));
  $("#generate-projection").addEventListener("click", () => void action(async () => { if (!state.tour?.route_version_id || state.tour.route_version_state !== "accepted") return; await post("/api/tours/projection", { tour_id: state.tour.id, route_version_id: state.tour.route_version_id, as_of: new Date().toISOString(), idempotency_key: uuid() }); await loadTour(state.tour.id); status("Client projection draft created. Human approval is required before sharing."); }));
  $("#seal-projection").addEventListener("click", () => void action(async () => { const receipt = $("#receipt-digest").value.trim(); if (!id(state.projectionDraftId) || !digest(state.candidateDigest) || !digest(receipt)) throw new Error("projection_review_required"); await post("/api/tours/projection/seal", { projection_id: state.projectionDraftId, candidate_digest: state.candidateDigest, receipt_digest: receipt, idempotency_key: uuid() }); await loadTour(state.tour.id); status("Reviewed facts-only projection approved. It can now be shared or rendered."); }));
  $("#share-form").addEventListener("submit", (event) => { event.preventDefault(); void action(() => issueShare(id(state.shareGrantId))); }); $("#rotate-share").addEventListener("click", () => void action(() => issueShare(true)));
  $("#revoke-share").addEventListener("click", () => void action(() => revokeShare(state.shareGrantId)));
  $("#share-grants").addEventListener("click", (event) => { const grantId = event.target?.dataset?.shareGrantId; if (id(grantId)) void action(() => revokeShare(grantId)); });
  $("#refresh-feedback").addEventListener("click", () => void action(loadFeedback));
  $("#copy-share").addEventListener("click", () => void action(async () => { await navigator.clipboard.writeText($("#share-url").value); status("Confidential link copied."); }));
  $("#render-pdf").addEventListener("click", () => void action(async () => { if (!id(state.projectionId)) throw new Error("projection_required"); const data = await post("/api/tours/pdf/render", { projection_id: state.projectionId, idempotency_key: uuid() }); state.renderJobId = text(data.render_job_id); state.pdfQcRunDigest = text(data.qc_run_digest); await loadTour(state.tour.id); status("PDF rendered and QC checked. Human review is required before download."); }));
  $("#review-pdf").addEventListener("click", () => void action(async () => { if (!id(state.renderJobId) || !digest(state.pdfQcRunDigest)) throw new Error("pdf_review_required"); const reviewedAt = new Date().toISOString(); await post("/api/tours/pdf/review", { render_job_id: state.renderJobId, qc_run_digest: state.pdfQcRunDigest, decision: "accept", reviewed_at: reviewedAt, review_receipt_digest: await sha256(`tour-pdf-human-review:${state.renderJobId}:${state.pdfQcRunDigest}:${reviewedAt}`), reason: "Internal operator visually reviewed the deterministic property pages", idempotency_key: uuid() }); await loadTour(state.tour.id); status("PDF review receipt recorded. Internal download is available."); }));
  $("#share-expiry").value = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16); renderCreate(); void action(loadLibrary);
  mountAutoRefresh({ document, window, refresh: async () => {
    await loadLibrary();
    const draftOpen = state.selectionDirty || state.pendingSelection || state.selectionSave || state.cheatDirty || composer?.dirty || composer?.plan || composer?.busy || state.shareBusy || navigationBusy;
    if (id(state.tour?.id) && !draftOpen) await loadTour(state.tour.id);
    else if (id(state.projectionId)) await loadFeedback();
  } });
})();
