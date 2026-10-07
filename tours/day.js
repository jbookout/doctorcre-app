import { acceptedRouteFromDetail, buildAcceptedRouteState, mountAcceptedItinerary } from "./itinerary-map.js";
import { createDayClient } from "./day-client.js";
import { createDayStore, noteState } from "./day-store.js";
import { createDayRecorder } from "./day-recorder.js";
import { mountAutoRefresh, updatedLabel } from "../js/auto-refresh.mjs";
import { offlineTourSession } from "../js/offline-tour-session.js";

export async function prepareOfflineShell(window) {
  if (!window.navigator.serviceWorker || !window.isSecureContext) throw new Error("offline_app_unavailable");
  const registration = await window.navigator.serviceWorker.register("/tours/day-sw.js", { scope: "/tours/" });
  const worker = registration.active || registration.installing || registration.waiting;
  if (!worker) throw new Error("offline_app_unavailable");
  if (worker.state === "activated") return;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (!["activated", "redundant"].includes(worker.state)) return;
      worker.removeEventListener("statechange", check);
      if (worker.state === "activated") resolve(); else reject(new Error("offline_app_unavailable"));
    };
    worker.addEventListener("statechange", check); check();
  });
}

function captureBinding(tour, selected, scope) {
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const routes = tour?.routes?.filter(route => route.accepted === true) || [];
  if (!scope || !uuid(tour?.id) || !boundClientId(tour) || routes.length !== 1 || !uuid(routes[0].id)) return null;
  const route = acceptedRouteFromDetail(tour);
  if (!route.stops.every(stop => uuid(stop.route_stop_id) && uuid(stop.property_id))) return null;
  try { buildAcceptedRouteState(route, { mode: "tour" }); } catch { return null; }
  const stop = route.stops.find(stop => stop.route_stop_id === selected);
  return stop ? { scope, tour_id: tour.id, client_id: boundClientId(tour), property_id: stop.property_id, route_version_id: route.route_version_id, route_stop_id: stop.route_stop_id, property_name: stop.title } : null;
}

export function orderedDayStops(tour) {
  const route = tour?.routes?.find(r => r.accepted === true);
  return (route?.stops || []).filter(stop => stop.stop_state === "active").toSorted((a, b) => a.route_sequence - b.route_sequence);
}
const string = (value, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const title = stop => string(stop?.property_name || stop?.name, "Property");
const address = stop => string(stop?.property_address || stop?.address, "Address unavailable");
export function safePhone(value) {
  if (typeof value !== "string" || !/^\+?[\d ().-]{7,30}$/.test(value)) return null;
  const clean = value.replace(/[^\d+]/g, "");
  return /^\+?\d{7,15}$/.test(clean) ? `tel:${clean}` : null;
}
export function boundClientId(tour) {
  const id = tour?.subject_type === "client" ? tour.subject_id : null;
  return typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function mountTourDay({ document, window, api = createDayClient(), store = createDayStore(window.indexedDB), mapFactory = mountAcceptedItinerary, prepareOffline = prepareOfflineShell }) {
  const $ = selector => document.querySelector(selector);
  const make = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
  const tourId = new URL(window.location.href).searchParams.get("tour");
  const offlineSession = offlineTourSession(window);
  let scope = null, userRef = null, tour = null, selected = null, map = null, notes = [], disposed = false, epoch = 0, opener = null, urls = [], dialogNoteId = null, dialogSignature = null;
  let volatileNote = null, recordingMessage = "", offline = false, itineraryError = "", shellError = "", shellReady = false, preparingShell = null;
  const status = text => { $("#day-status").textContent = text; };
  const renderStatus = () => { if (tour) status([recordingMessage, itineraryError, shellError].filter(Boolean).join(" · ") || (offline ? "Offline · Notes saved on phone" : "Voice notes stay on this phone")); };
  const rememberFocus = () => document.activeElement?.dataset.focusKey;
  const focusControl = key => [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key)?.focus({ preventScroll: true });
  function currentNotes() {
    const rows = [...notes];
    if (volatileNote?.storage_error && volatileNote.scope === scope && volatileNote.tour_id === tourId) {
      const index = rows.findIndex(note => note.id === volatileNote.id);
      if (index >= 0) rows[index] = volatileNote; else rows.push(volatileNote);
    }
    return rows;
  }
  const selectedStop = () => orderedDayStops(tour).find(s => s.id === selected);
  const close = () => { $("#day-dialog").close(); urls.forEach(url => window.URL.revokeObjectURL(url)); urls = []; focusControl(opener); };
  $("#day-dialog-close").onclick = close;
  $("#day-dialog").addEventListener("close", () => { urls.forEach(url => window.URL.revokeObjectURL(url)); urls = []; focusControl(opener); });
  const recorder = createDayRecorder({ window, store,
    onChange(note) { if (disposed || (note && note.scope !== scope)) return; volatileNote = note; renderControls(); if (!note || note.status !== "recording") void loadNotes(); },
    onError(text, note) { if (disposed || note?.scope !== scope) return; recordingMessage = text; volatileNote = note; renderStatus(); },
  });
  function renderControls() {
    const active = recorder.active;
    const record = $("#day-record");
    record.disabled = disposed || !scope || (!active && !captureBinding(tour, selected, scope));
    record.toggleAttribute("data-recording", active?.phase === "recording");
    record.replaceChildren(make("span", active ? "■" : "●"), document.createTextNode(active ? active.phase === "requesting" ? "Cancel microphone" : "Finish note" : "Record note"));
    record.setAttribute("aria-label", active ? `Finish note for ${active.property_name}` : `Record note for ${title(selectedStop())}`);
    const stops = orderedDayStops(tour), index = stops.findIndex(s => s.id === selected);
    $("#day-previous").disabled = index <= 0 || Boolean(active);
    $("#day-next").disabled = index < 0 || index >= stops.length - 1 || Boolean(active);
    renderStatus();
  }
  async function loadNotes() {
    const currentScope = scope;
    const seq = epoch;
    if (!currentScope) return;
    try {
      const rows = await store.list(currentScope, tourId);
      if (currentScope !== scope || disposed || seq !== epoch) return;
      await recorder.recover(rows);
      if (currentScope !== scope || disposed || seq !== epoch) return;
      notes = rows.filter(n => n.status !== "empty"); renderNotes();
      if ($("#day-dialog").open) openDetails(opener, dialogNoteId ? currentNotes().find(note => note.id === dialogNoteId) : null, true);
    } catch { if (currentScope === scope && !disposed && seq === epoch) { recordingMessage = "Phone storage unavailable"; renderStatus(); } }
  }
  function noteBody(note, expanded = false) {
    const node = make("div");
    node.append(make("p", string(note.summary, note.status === "recording" ? "Recording voice note" : "Voice note")), make("p", noteState(note), "note-state"));
    if (expanded) {
      const details = make("details"), summary = make("summary", "Details");
      details.dataset.noteId = note.id; summary.dataset.focusKey = `details:${note.id}`;
      details.append(summary, make("p", string(note.transcript, "Transcript pending")));
      if (note.audio?.size) {
        const audio = make("audio"); audio.controls = true; audio.preload = "none";
        audio.dataset.focusKey = `audio:${note.id}`;
        const url = window.URL.createObjectURL(note.audio); urls.push(url); audio.src = url;
        const download = make("a", "Download audio"); download.href = url; download.download = `tour-note.${note.audio.type.includes("mp4") ? "m4a" : note.audio.type.includes("ogg") ? "ogg" : "webm"}`;
        download.dataset.focusKey = `download:${note.id}`;
        details.append(audio, download);
      }
      node.append(details);
    }
    return node;
  }
  function renderNotes() {
    const focus = rememberFocus();
    const root = $("#day-notes"); root.replaceChildren(make("h3", "Notes"));
    const current = currentNotes().filter(note => note.property_id === selectedStop()?.property_id);
    if (!current.length) root.append(make("p", "No notes yet", "note-state"));
    for (const note of current.toSorted((a, b) => a.captured_at.localeCompare(b.captured_at))) {
      const button = make("button", null, "note-card"); button.type = "button"; button.append(noteBody(note), make("small", new Date(note.captured_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })));
      button.dataset.focusKey = `note:${note.id}`;
      button.onclick = () => openDetails(button, note); root.append(button);
    }
    focusControl(focus);
  }
  function facts(stop) {
    const dl = make("dl", null, "property-facts");
    for (const [label, value] of [["Appointment", stop.appointment_start ? new Date(stop.appointment_start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true }) : "Flexible"], ["Contact", string(stop.contact_name, "Contact unavailable")], ["Visit", `${stop.dwell_minutes ?? "—"} min`], ["Travel buffer", `${stop.buffer_minutes ?? "—"} min`]]) {
      const row = make("div"); row.append(make("dt", label), make("dd", value)); dl.append(row);
    }
    return dl;
  }
  function openDetails(trigger, note = null, refreshing = false) {
    const stop = selectedStop(); if (!stop) return;
    const signature = JSON.stringify({ stop, notes: (note ? [note] : currentNotes().filter(n => n.property_id === stop.property_id)).map(n => ({ ...n, audio: n.audio?.size })) });
    if (refreshing && signature === dialogSignature) return;
    const dialog = $("#day-dialog"), scroll = dialog.scrollTop;
    const focus = refreshing && dialog.contains(document.activeElement) ? rememberFocus() : null;
    const expanded = new Set(refreshing ? [...dialog.querySelectorAll("details[open]")].map(d => d.dataset.noteId) : []);
    urls.forEach(url => window.URL.revokeObjectURL(url)); urls = [];
    dialogNoteId = note?.id || null; dialogSignature = signature;
    opener = typeof trigger === "string" ? trigger : trigger?.dataset.focusKey; $("#day-dialog-title").textContent = title(stop);
    const body = $("#day-dialog-body"); body.replaceChildren();
    const grid = make("div", null, "dialog-grid"), property = make("div"), feedback = make("div");
    property.append(make("p", address(stop), "property-address"), facts(stop), make("h3", "Access"), make("p", string(stop.access_notes, "Access notes unavailable"), "access-note"));
    feedback.append(make("h3", "Notes"));
    for (const item of note ? [note] : currentNotes().filter(n => n.property_id === stop.property_id)) feedback.append(noteBody(item, true));
    grid.append(property, feedback); body.append(grid);
    [...body.querySelectorAll("details")].forEach(d => { d.open = expanded.has(d.dataset.noteId); });
    if (!$("#day-dialog").open) $("#day-dialog").showModal();
    if (refreshing) dialog.scrollTop = scroll;
    focusControl(focus);
  }
  function select(id, popup = false, trigger = null) {
    if (recorder.active || !orderedDayStops(tour).some(s => s.id === id)) return;
    selected = id;
    map?.dispatch({ type: "route_stop_change", route_stop_id: id }); render();
    if (popup) openDetails(trigger);
  }
  function render() {
    if (!tour) return;
    const focus = rememberFocus();
    $("#day-title").textContent = tour.name || "Tour day";
    const stops = orderedDayStops(tour), root = $("#day-stops");
    root.replaceChildren();
    for (const stop of stops) {
      const row = make("li"), button = make("button", null, "day-stop"), text = make("span");
      button.type = "button"; button.dataset.stopId = stop.id;
      button.dataset.focusKey = `stop:${stop.id}`;
      if (stop.id === selected) button.setAttribute("aria-current", "step");
      text.append(make("strong", title(stop)), make("small", address(stop)), make("small", string(stop.contact_name, "Contact unavailable"), "stop-contact"), make("small", string(stop.access_notes, "Access notes unavailable")));
      button.append(make("span", stop.route_label || String(stop.route_sequence), "stop-letter"), text);
      button.disabled = Boolean(recorder.active); button.onclick = () => select(stop.id, true, button); row.append(button); root.append(row);
    }
    const stop = selectedStop(), current = $("#day-current"); current.replaceChildren();
    if (stop) {
      const open = make("button", null, "property-open"); open.type = "button"; open.append(make("h2", title(stop)), make("span", address(stop), "property-address")); open.onclick = () => openDetails(open);
      open.dataset.focusKey = `property:${stop.property_id}`;
      current.append(make("p", `Stop ${stop.route_label || stop.route_sequence} · ${stops.findIndex(s => s.id === selected) + 1} of ${stops.length}`, "stop-eyebrow"), open, facts(stop), make("p", string(stop.access_notes, "Access notes unavailable"), "access-note"));
      const actions = make("div", null, "property-actions"), phone = safePhone(stop.contact_phone);
      if (phone) { const call = make("a", "Call contact"); call.href = phone; call.dataset.focusKey = `call:${stop.property_id}`; actions.append(call); }
      // Reuse the exact-coordinate, exact-promotion native handoff, including
      // its current-stop return receipt. No address or centroid fallback.
      for (const link of map?.navigationLinks?.() || []) { link.dataset.focusKey = `navigation:${link.textContent}:${stop.property_id}`; actions.append(link); }
      if (!actions.children.length) actions.append(make("p", "Directions unavailable", "note-state"));
      current.append(actions);
    } else current.append(make("h2", "No scheduled stops"));
    renderNotes(); renderControls();
    if ($("#day-dialog").open) openDetails(opener, dialogNoteId ? currentNotes().find(note => note.id === dialogNoteId) : null, true);
    focusControl(focus);
  }
  function reset() {
    ++epoch; recorder.invalidate(); close(); map?.destroy(); map = null;
    scope = userRef = tour = selected = null; notes = []; volatileNote = null; recordingMessage = itineraryError = "";
    $("#day-current").replaceChildren(); $("#day-stops").replaceChildren(); $("#day-notes").replaceChildren(); $("#day-title").textContent = "Tour day";
    try { offlineSession.clear(); } catch {}
    renderControls();
  }
  async function refresh({ signal } = {}) {
    const seq = ++epoch;
    try {
      const session = await api.session({ signal });
      if (disposed || seq !== epoch) return;
      if (scope && session.scope !== scope) { reset(); status("Session changed"); return; }
      scope = session.scope; userRef = session.user_ref;
      offlineSession.save({ scope, userRef, tourId });
      const detail = await api.tour(tourId, { signal });
      if (disposed || seq !== epoch) return;
      tour = detail; offline = false;
      try { await store.putTour(scope, tour); if (disposed || seq !== epoch) return; itineraryError = ""; }
      catch { if (disposed || seq !== epoch) return; itineraryError = "Offline itinerary unavailable"; }
      void ensureOfflineShell();
      await present(); $("#day-updated").textContent = updatedLabel(new Date());
      renderStatus();
    } catch (error) {
      if (disposed || seq !== epoch) return;
      if (error.authentication) { reset(); status("Sign in to continue"); return; }
      offline = true;
      if (!scope && window.navigator.onLine === false) {
        const saved = offlineSession.read(tourId); if (saved) { scope = saved.scope; userRef = saved.userRef; }
      }
      if (!tour && scope) {
        const saved = await store.getTour(scope, tourId).catch(() => null);
        if (disposed || seq !== epoch) return;
        if (saved) { tour = saved.tour; $("#day-updated").textContent = updatedLabel(saved.updated_at); await present(); }
      }
      renderControls(); if (!tour) status("Tour unavailable");
    }
  }
  async function present() {
    const stops = orderedDayStops(tour);
    if (!stops.some(s => s.id === selected)) selected = stops[0]?.id || null;
    const route = acceptedRouteFromDetail(tour);
    if (route) {
      const options = { route, scope, user_ref: userRef, presentation: "day", canSelect: () => !recorder.active, promotion_receipt: tour.map_promotion_receipt || null, onSelect: id => { if (!recorder.active) { selected = id; render(); } } };
      try { if (map) map.update(options); else map = mapFactory($("#day-map"), options); selected = map.projection?.card?.route_stop_id || selected; }
      catch { map?.destroy(); map = null; $("#day-map").replaceChildren(make("p", "Map unavailable", "day-map-state")); }
    } else { map?.destroy(); map = null; $("#day-map").replaceChildren(make("p", "Route unavailable", "day-map-state")); }
    await loadNotes(); render();
  }
  $("#day-record").onclick = async () => {
    if (recorder.active) { recorder.stop(); return; }
    const binding = captureBinding(tour, selected, scope);
    if (!binding) return;
    recordingMessage = "";
    try { await recorder.start(binding); if (!disposed && scope === binding.scope) render(); }
    catch (error) { if (!disposed && scope === binding.scope) { recordingMessage = error.name === "NotAllowedError" ? "Microphone access denied" : "Recording unavailable"; renderControls(); } }
  };
  $("#day-previous").onclick = () => { const stops = orderedDayStops(tour), i = stops.findIndex(s => s.id === selected); if (i > 0) select(stops[i - 1].id); };
  $("#day-next").onclick = () => { const stops = orderedDayStops(tour), i = stops.findIndex(s => s.id === selected); if (i >= 0 && i < stops.length - 1) select(stops[i + 1].id); };
  const updates = mountAutoRefresh({ document, window, refresh });
  function ensureOfflineShell() {
    if (shellReady || preparingShell) return preparingShell;
    preparingShell = prepareOffline(window).then(() => { shellReady = true; shellError = ""; }, () => { shellError = "Offline app unavailable"; }).finally(() => { preparingShell = null; if (!disposed) renderStatus(); });
    return preparingShell;
  }
  $("#day-refresh").onclick = () => updates.refresh();
  const hide = () => { if (document.visibilityState === "hidden") recorder.stop(); };
  const leave = () => recorder.stop();
  const revoked = () => { reset(); status("Sign in to continue"); };
  window.addEventListener("doctorcre-offline-session-revoked", revoked);
  document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", leave);
  const ready = updates.refresh();
  return { ready, refresh, get notes() { return notes; }, get recorder() { return recorder; }, dispose() { disposed = true; ++epoch; updates.dispose(); recorder.dispose(); map?.destroy(); document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave); window.removeEventListener("doctorcre-offline-session-revoked", revoked); close(); } };
}
if (typeof document !== "undefined" && document.querySelector("#tour-day")) {
  mountTourDay({ document, window });
}
