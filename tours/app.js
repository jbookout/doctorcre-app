import { cheatSheetText, factSummary, formatTourDate, tourMetaLine } from "./tour-format.js";

(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const state = { csrf: "", tours: [], tour: null, rawShareToken: "", shareGrantId: "", shareStatus: "missing", shareGrants: [], projectionId: "", projectionDraftId: "", candidateDigest: "", renderJobId: "", pdfQcRunDigest: "", cheatDirty: false, cheatDraftTourId: "",
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
    const response = await fetch(path, { credentials: "same-origin", ...options });
    let payload = null; try { payload = await response.json(); } catch { /* only sanitized server errors are shown */ }
    if (!response.ok) throw new Error(payload?.error || "request_failed");
    if (typeof payload?.csrf_token === "string") state.csrf = payload.csrf_token;
    return payload?.data || {};
  }
  function post(path, body) { return request(path, { method: "POST", headers: { "content-type": "application/json", "x-carr-csrf": state.csrf }, body: JSON.stringify(body) }); }
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
  function renderShareGrants() { const list = $("#share-grants"); list.replaceChildren(); for (const grant of state.shareGrants) { if (!id(grant?.share_grant_id)) continue; const row = document.createElement("li"); const summary = document.createElement("span"); summary.textContent = `${text(grant.status, "unknown")} · projection ${text(grant.projection_id, "unknown")} · expires ${formatTourDate(grant.expires_at) || "unknown"}`; row.append(summary); if (grant.status === "active") { const button = document.createElement("button"); button.type = "button"; button.textContent = "Revoke"; button.dataset.shareGrantId = grant.share_grant_id; row.append(button); } list.append(row); } if (!list.children.length) list.textContent = "No active or rotatable confidential links."; }
  function renderTour() {
    const tour = state.tour; if (!tour) return;
    $("#empty-state").hidden = true; $("#tour-panel").hidden = false;
    $("#tour-name").textContent = text(tour.name, "Untitled tour"); $("#tour-state").textContent = text(tour.status, "Draft");
    $("#tour-meta").textContent = tourMetaLine(tour);
    $("#route-version").textContent = text(tour.route_version_label, tour.route_version_id ? "Current version" : "No route version");
    $("#save-route").hidden = tour.route_version_state !== "accepted";
    $("#reorder-route").hidden = tour.route_version_state !== "draft";
    $("#accept-route").hidden = tour.route_version_state !== "draft";
    state.projectionId = text(tour.projection_id); state.projectionDraftId = text(tour.projection_draft_id); state.shareGrantId = text(tour.share_grant_id); state.shareStatus = text(tour.share_status, "missing"); state.shareGrants = Array.isArray(tour.share_grants) ? tour.share_grants : [];
    const activeShareCount = state.shareGrants.filter((grant) => grant?.status === "active").length;
    $("#projection-state").textContent = state.projectionId ? "Approved" : tour.projection_status === "draft" ? "Draft · approval required" : "Not generated"; $("#share-state").textContent = activeShareCount ? `${activeShareCount} active` : state.shareStatus === "expired" ? "Expired · rotate" : "Not issued"; renderShareGrants();
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
  }
  async function loadLibrary() { status("Loading tours…"); const data = await request("/api/tours/library"); state.tours = Array.isArray(data.tours) ? data.tours.filter((tour) => id(tour?.id)) : []; renderLibrary(); status("Tour library ready."); }
  async function loadProjectionPreview() { const preview = $("#projection-preview"); state.candidateDigest = ""; preview.hidden = true; preview.textContent = ""; if (!id(state.projectionDraftId)) return; const data = await request(`/api/tours/projection/candidates?projection_id=${encodeURIComponent(state.projectionDraftId)}`); state.candidateDigest = text(data.candidate_digest); const rows = Array.isArray(data.preview) ? data.preview : []; preview.textContent = rows.map(row => { const facts = row?.facts && typeof row.facts === "object" ? row.facts : {}; return `${text(row.route_label, `Stop ${row.route_sequence || ""}`)} · ${text(facts["display.name"], "Unnamed property")}\n${text(facts["display.address"], "Address unavailable")}${factSummary(facts) ? `\n${factSummary(facts)}` : ""}`; }).join("\n\n"); preview.hidden = false; }
  async function loadTour(tourId) { status("Loading tour…"); if (state.tour?.id !== tourId) { ++state.hydrationSeq; state.cheatDirty = false; state.cheatDraftTourId = tourId; state.selectedIds = []; state.cart = null; state.selectionDirty = false; state.pendingSelection = null; state.undoSelectionIds = null; state.selectionTourId = tourId; } state.tour = await request(`/api/tours/detail?tour_id=${encodeURIComponent(tourId)}`); renderTour(); renderSelection(); await loadSelectionCart(tourId); await loadProjectionPreview(); status("Tour ready."); }
  function moveStop(stopId, delta) { const list = stops(); const index = list.findIndex((stop) => stop.id === stopId); const destination = index + delta; if (index < 0 || destination < 0 || destination >= list.length) return; [list[index], list[destination]] = [list[destination], list[index]]; renderTour(); }
  async function saveRoute(reorder = false) { if (!state.tour) return; const stopIds = stops().filter((stop) => stop.stop_state === "active").map((stop) => stop.id).filter(id); const path = reorder ? "/api/tours/route-reorder" : "/api/tours/route-version"; const payload = reorder ? { tour_id: state.tour.id, route_version_id: state.tour.route_version_id, expected_route_version: Number(state.tour.route_version || 0), stop_ids: stopIds, idempotency_key: uuid() } : { tour_id: state.tour.id, expected_route_version: Number(state.tour.route_version || 0), stop_ids: stopIds, idempotency_key: uuid() }; await post(path, payload); await loadTour(state.tour.id); status("Route version saved."); }
  async function saveSheet() { if (!state.tour) return; let content; try { content = JSON.parse($("#cheat-content").value || "{}"); } catch { content = { notes: $("#cheat-content").value }; } await post("/api/tours/cheat-sheet/autosave", { tour_id: state.tour.id, content, expected_revision_number: Number(state.tour.cheat_sheet?.revision_number || 0), idempotency_key: uuid() }); state.cheatDirty = false; await loadTour(state.tour.id); status("Internal cheat sheet saved."); }
  async function issueShare(rotate = false) { if (!state.projectionId) throw new Error("projection_required"); const raw = newShareToken(); const tokenDigest = await sha256(raw); const scopes = [...document.querySelectorAll('input[name="scope"]:checked')].map((box) => box.value); const expires = new Date($("#share-expiry").value).toISOString(); const receipt = $("#receipt-digest").value.trim(); if (!digest(receipt) || !scopes.length || !Number.isFinite(Date.parse(expires))) throw new Error("share_details_invalid"); const payload = { projection_id: state.projectionId, token_digest: tokenDigest, permission_scopes: scopes, expires_at: expires, receipt_digest: receipt, idempotency_key: uuid() }; const data = await post(rotate ? "/api/tours/share/rotate" : "/api/tours/share/issue", rotate ? { share_grant_id: state.shareGrantId, ...payload } : payload); state.rawShareToken = raw; state.shareGrantId = text(data.share_grant_id, state.shareGrantId); const url = `https://reports.doctorcre.com/share#token=${raw}`; $("#share-url").value = url; $("#share-link").hidden = false; $("#share-state").textContent = "Active"; status("Confidential link generated. Copy it now."); }
  async function revokeShare(grantId) { if (!id(grantId)) return; const receipt = $("#receipt-digest").value.trim(); if (!digest(receipt)) throw new Error("receipt_digest_required"); await post("/api/tours/share/revoke", { share_grant_id: grantId, reason: "Internal operator revoked link", revoked_at: new Date().toISOString(), receipt_digest: receipt, idempotency_key: uuid() }); state.rawShareToken = ""; $("#share-link").hidden = true; await loadTour(state.tour.id); status("Share link revoked."); }
  async function action(work) { try { await work(); } catch { status("The request could not be completed."); } }
  // Versioned route and cheat-sheet writes ignore a second click while a write to the same record is in flight.
  const writesInFlight = new Set();
  const exclusive = (record, work) => () => { if (writesInFlight.has(record)) return; writesInFlight.add(record); void action(work).finally(() => writesInFlight.delete(record)); };
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
  $("#accept-route").addEventListener("click", exclusive("route", async () => { if (!state.tour?.route_version_id) return; const prior = Number(state.tour.accepted_route_version || 0); await post("/api/tours/route-accept", { route_version_id: state.tour.route_version_id, expected_prior_route_version: prior, acceptance_digest: await sha256(`${state.tour.route_version_id}:${prior}`), idempotency_key: uuid() }); await loadTour(state.tour.id); status("Route version accepted."); }));
  $("#cheat-content").addEventListener("input", () => { state.cheatDirty = true; state.cheatDraftTourId = state.tour?.id || ""; $("#sheet-state").textContent = "Unsaved changes"; });
  $("#save-sheet").addEventListener("click", exclusive("sheet", saveSheet)); $("#restore-sheet").addEventListener("click", exclusive("sheet", async () => { const revision = state.tour?.cheat_sheet?.restore_revision_id; if (!state.tour || !id(revision)) return; await post("/api/tours/cheat-sheet/restore", { tour_id: state.tour.id, restore_revision_id: revision, expected_revision_number: Number(state.tour.cheat_sheet?.revision_number || 0), idempotency_key: uuid() }); state.cheatDirty = false; await loadTour(state.tour.id); }));
  $("#generate-projection").addEventListener("click", () => void action(async () => { if (!state.tour?.route_version_id || state.tour.route_version_state !== "accepted") return; await post("/api/tours/projection", { tour_id: state.tour.id, route_version_id: state.tour.route_version_id, as_of: new Date().toISOString(), idempotency_key: uuid() }); await loadTour(state.tour.id); status("Client projection draft created. Human approval is required before sharing."); }));
  $("#seal-projection").addEventListener("click", () => void action(async () => { const receipt = $("#receipt-digest").value.trim(); if (!id(state.projectionDraftId) || !digest(state.candidateDigest) || !digest(receipt)) throw new Error("projection_review_required"); await post("/api/tours/projection/seal", { projection_id: state.projectionDraftId, candidate_digest: state.candidateDigest, receipt_digest: receipt, idempotency_key: uuid() }); await loadTour(state.tour.id); status("Reviewed facts-only projection approved. It can now be shared or rendered."); }));
  $("#share-form").addEventListener("submit", (event) => { event.preventDefault(); void action(() => issueShare(id(state.shareGrantId))); }); $("#rotate-share").addEventListener("click", () => void action(() => issueShare(true)));
  $("#revoke-share").addEventListener("click", () => void action(() => revokeShare(state.shareGrantId)));
  $("#share-grants").addEventListener("click", (event) => { const grantId = event.target?.dataset?.shareGrantId; if (id(grantId)) void action(() => revokeShare(grantId)); });
  $("#copy-share").addEventListener("click", () => void action(async () => { await navigator.clipboard.writeText($("#share-url").value); status("Confidential link copied."); }));
  $("#render-pdf").addEventListener("click", () => void action(async () => { if (!id(state.projectionId)) throw new Error("projection_required"); const data = await post("/api/tours/pdf/render", { projection_id: state.projectionId, idempotency_key: uuid() }); state.renderJobId = text(data.render_job_id); state.pdfQcRunDigest = text(data.qc_run_digest); await loadTour(state.tour.id); status("PDF rendered and QC checked. Human review is required before download."); }));
  $("#review-pdf").addEventListener("click", () => void action(async () => { if (!id(state.renderJobId) || !digest(state.pdfQcRunDigest)) throw new Error("pdf_review_required"); const reviewedAt = new Date().toISOString(); await post("/api/tours/pdf/review", { render_job_id: state.renderJobId, qc_run_digest: state.pdfQcRunDigest, decision: "accept", reviewed_at: reviewedAt, review_receipt_digest: await sha256(`tour-pdf-human-review:${state.renderJobId}:${state.pdfQcRunDigest}:${reviewedAt}`), reason: "Internal operator visually reviewed the deterministic property pages", idempotency_key: uuid() }); await loadTour(state.tour.id); status("PDF review receipt recorded. Internal download is available."); }));
  $("#share-expiry").value = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16); void action(loadLibrary);
})();
