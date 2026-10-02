import { acceptedRouteFromDetail, mountAcceptedItinerary } from "./itinerary-map.js";
import { createDayClient } from "./day-client.js";
import { createDayStore, createNoteSync, noteState } from "./day-store.js";
import { createDayRecorder } from "./day-recorder.js";
import { mountAutoRefresh, updatedLabel } from "../js/auto-refresh.mjs";

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

export function mountTourDay({ document, window, api = createDayClient(), store = createDayStore(window.indexedDB), mapFactory = mountAcceptedItinerary }) {
  const $ = selector => document.querySelector(selector);
  const make = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
  const tourId = new URL(window.location.href).searchParams.get("tour");
  const bindingKey = "doctorcre-tour-day-session-v1";
  let scope = null, userRef = null, tour = null, selected = null, map = null, notes = [], queue = null, disposed = false, epoch = 0, opener = null, urls = [], dialogNoteId = null, dialogSignature = null;
  let volatileNote = null, recordingMessage = "", offline = false;
  const status = text => { $("#day-status").textContent = text; };
  const selectedStop = () => orderedDayStops(tour).find(s => s.id === selected);
  const close = () => { $("#day-dialog").close(); urls.forEach(url => window.URL.revokeObjectURL(url)); urls = []; opener?.focus(); };
  $("#day-dialog-close").onclick = close;
  $("#day-dialog").addEventListener("close", () => { urls.forEach(url => window.URL.revokeObjectURL(url)); urls = []; });
  const recorder = createDayRecorder({ window, store,
    onChange(note) { volatileNote = note; renderControls(); if (!note || note.status !== "recording") void loadNotes().then(() => queue?.sync()); },
    onError(text, note) { recordingMessage = text; volatileNote = note; status(text); },
  });
  function renderControls() {
    const active = recorder.active;
    const record = $("#day-record");
    record.disabled = disposed || !scope || !selectedStop() || !boundClientId(tour);
    record.toggleAttribute("data-recording", active?.phase === "recording");
    record.replaceChildren(make("span", active ? "■" : "●"), document.createTextNode(active ? active.phase === "requesting" ? "Cancel microphone" : "Finish note" : "Record note"));
    record.setAttribute("aria-label", active ? `Finish note for ${title(orderedDayStops(tour).find(s => s.id === active.route_stop_id))}` : `Record note for ${title(selectedStop())}`);
    const stops = orderedDayStops(tour), index = stops.findIndex(s => s.id === selected);
    $("#day-previous").disabled = index <= 0 || Boolean(active);
    $("#day-next").disabled = index < 0 || index >= stops.length - 1 || Boolean(active);
    if (recordingMessage) status(recordingMessage);
  }
  async function loadNotes() {
    const currentScope = scope;
    if (!currentScope) return;
    try {
      const rows = await store.list(currentScope, tourId);
      if (currentScope !== scope || disposed) return;
      for (const note of rows) if (note.status === "recording" && recorder.active?.id !== note.id) {
        note.status = note.audio?.size ? "local" : "empty";
        await store.patch(currentScope, note.id, { status: note.status });
      }
      if (currentScope !== scope || disposed) return;
      notes = rows.filter(n => n.status !== "empty"); renderNotes();
      if ($("#day-dialog").open) openDetails(opener, dialogNoteId ? notes.find(note => note.id === dialogNoteId) : null, true);
    } catch { status("Phone storage unavailable"); }
  }
  function noteBody(note, expanded = false) {
    const node = make("div");
    node.append(make("p", string(note.summary, note.status === "recording" ? "Recording voice note" : "Voice note")), make("p", note.storage_error ? "Audio not saved" : noteState(note, api.capabilities.voiceNotes), "note-state"));
    if (expanded) {
      const details = make("details"), summary = make("summary", "Details");
      details.append(summary, make("p", string(note.transcript, "Transcript pending")));
      if (note.audio?.size) {
        const audio = make("audio"); audio.controls = true; audio.preload = "none";
        const url = window.URL.createObjectURL(note.audio); urls.push(url); audio.src = url;
        const download = make("a", "Download audio"); download.href = url; download.download = `tour-note.${note.audio.type.includes("mp4") ? "m4a" : note.audio.type.includes("ogg") ? "ogg" : "webm"}`;
        details.append(audio, download);
      }
      node.append(details);
    }
    return node;
  }
  function renderNotes() {
    const root = $("#day-notes"); root.replaceChildren(make("h3", "Notes"));
    const current = notes.filter(note => note.property_id === selectedStop()?.property_id);
    if (volatileNote?.storage_error && volatileNote.property_id === selectedStop()?.property_id) {
      const index = current.findIndex(note => note.id === volatileNote.id);
      if (index >= 0) current[index] = volatileNote; else current.push(volatileNote);
    }
    if (!current.length) root.append(make("p", "No notes yet", "note-state"));
    for (const note of current.toSorted((a, b) => a.captured_at.localeCompare(b.captured_at))) {
      const button = make("button", null, "note-card"); button.type = "button"; button.append(noteBody(note), make("small", new Date(note.captured_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })));
      button.onclick = () => openDetails(button, note); root.append(button);
    }
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
    const signature = JSON.stringify({ stop, notes: (note ? [note] : notes.filter(n => n.property_id === stop.property_id)).map(n => ({ ...n, audio: n.audio?.size })) });
    if (refreshing && signature === dialogSignature) return;
    const dialog = $("#day-dialog"), scroll = dialog.scrollTop;
    const expanded = refreshing ? [...dialog.querySelectorAll("details")].map(d => d.open) : [];
    urls.forEach(url => window.URL.revokeObjectURL(url)); urls = [];
    dialogNoteId = note?.id || null; dialogSignature = signature;
    opener = trigger; $("#day-dialog-title").textContent = title(stop);
    const body = $("#day-dialog-body"); body.replaceChildren();
    const grid = make("div", null, "dialog-grid"), property = make("div"), feedback = make("div");
    property.append(make("p", address(stop), "property-address"), facts(stop), make("h3", "Access"), make("p", string(stop.access_notes, "Access notes unavailable"), "access-note"));
    feedback.append(make("h3", "Notes"));
    for (const item of note ? [note] : notes.filter(n => n.property_id === stop.property_id)) feedback.append(noteBody(item, true));
    grid.append(property, feedback); body.append(grid);
    [...body.querySelectorAll("details")].forEach((d, index) => { d.open = Boolean(expanded[index]); });
    if (!$("#day-dialog").open) $("#day-dialog").showModal();
    if (refreshing) dialog.scrollTop = scroll;
  }
  function select(id, popup = false, trigger = null) {
    if (recorder.active || !orderedDayStops(tour).some(s => s.id === id)) return;
    selected = id;
    try { window.sessionStorage.setItem(`doctorcre-tour-day-stop:${scope}:${tourId}`, id); } catch {}
    map?.dispatch({ type: "route_stop_change", route_stop_id: id }); render();
    if (popup) openDetails(trigger);
  }
  function render() {
    if (!tour) return;
    $("#day-title").textContent = tour.name || "Tour day";
    const stops = orderedDayStops(tour), root = $("#day-stops");
    root.replaceChildren();
    for (const stop of stops) {
      const row = make("li"), button = make("button", null, "day-stop"), text = make("span");
      button.type = "button"; button.dataset.stopId = stop.id;
      if (stop.id === selected) button.setAttribute("aria-current", "step");
      text.append(make("strong", title(stop)), make("small", address(stop)), make("small", string(stop.contact_name, "Contact unavailable"), "stop-contact"), make("small", string(stop.access_notes, "Access notes unavailable")));
      button.append(make("span", stop.route_label || String(stop.route_sequence), "stop-letter"), text);
      button.disabled = Boolean(recorder.active); button.onclick = () => select(stop.id, true, button); row.append(button); root.append(row);
    }
    const stop = selectedStop(), current = $("#day-current"); current.replaceChildren();
    if (stop) {
      const open = make("button", null, "property-open"); open.type = "button"; open.append(make("h2", title(stop)), make("span", address(stop), "property-address")); open.onclick = () => openDetails(open);
      current.append(make("p", `Stop ${stop.route_label || stop.route_sequence} · ${stops.findIndex(s => s.id === selected) + 1} of ${stops.length}`, "stop-eyebrow"), open, facts(stop), make("p", string(stop.access_notes, "Access notes unavailable"), "access-note"));
      const actions = make("div", null, "property-actions"), phone = safePhone(stop.contact_phone);
      if (phone) { const call = make("a", "Call contact"); call.href = phone; actions.append(call); }
      // Reuse the exact-coordinate, exact-promotion native handoff, including
      // its current-stop return receipt. No address or centroid fallback.
      for (const link of map?.navigationLinks?.() || []) actions.append(link);
      if (!actions.children.length) actions.append(make("p", "Directions unavailable", "note-state"));
      current.append(actions);
    } else current.append(make("h2", "No scheduled stops"));
    renderNotes(); renderControls();
    if ($("#day-dialog").open) openDetails(opener, dialogNoteId ? notes.find(note => note.id === dialogNoteId) : null, true);
  }
  function reset() {
    ++epoch; recorder.stop(); close(); map?.destroy(); map = null;
    scope = userRef = tour = selected = queue = null; notes = []; volatileNote = null;
    $("#day-current").replaceChildren(); $("#day-stops").replaceChildren(); $("#day-notes").replaceChildren(); $("#day-title").textContent = "Tour day";
    try { window.sessionStorage.removeItem(bindingKey); } catch {}
    renderControls();
  }
  async function refresh({ signal } = {}) {
    const seq = ++epoch;
    try {
      const session = await api.session({ signal });
      if (disposed || seq !== epoch) return;
      if (scope && session.scope !== scope) { reset(); status("Session changed"); return; }
      scope = session.scope; userRef = session.user_ref;
      window.sessionStorage.setItem(bindingKey, JSON.stringify({ scope, userRef, tourId }));
      const detail = await api.tour(tourId, { signal });
      if (disposed || seq !== epoch) return;
      tour = detail; offline = false;
      await store.putTour(scope, tour).catch(() => status("Offline itinerary unavailable"));
      await present(); $("#day-updated").textContent = updatedLabel(new Date());
      if (!recordingMessage) status(api.capabilities.voiceNotes ? "" : "Voice notes stay on this phone");
    } catch (error) {
      if (disposed || seq !== epoch) return;
      if (error.authentication) { reset(); status("Sign in to continue"); return; }
      offline = true;
      if (!scope && window.navigator.onLine === false) {
        try { const saved = JSON.parse(window.sessionStorage.getItem(bindingKey)); if (saved.tourId === tourId) { scope = saved.scope; userRef = saved.userRef; } } catch {}
      }
      if (!tour && scope) {
        const saved = await store.getTour(scope, tourId).catch(() => null);
        if (disposed || seq !== epoch) return;
        if (saved) { tour = saved.tour; $("#day-updated").textContent = updatedLabel(saved.updated_at); await present(); }
      }
      status(tour ? "Offline · Notes saved on phone" : "Tour unavailable"); renderControls();
    }
  }
  async function present() {
    const stops = orderedDayStops(tour);
    if (!stops.some(s => s.id === selected)) {
      try { selected = window.sessionStorage.getItem(`doctorcre-tour-day-stop:${scope}:${tourId}`); } catch {}
      if (!stops.some(s => s.id === selected)) selected = stops[0]?.id || null;
    }
    const route = acceptedRouteFromDetail(tour);
    if (route) {
      const options = { route, scope, user_ref: userRef, presentation: "day", canSelect: () => !recorder.active, promotion_receipt: tour.map_promotion_receipt || null, onSelect: id => { if (!recorder.active) { selected = id; render(); } } };
      try { if (map) map.update(options); else map = mapFactory($("#day-map"), options); map.dispatch({ type: "route_stop_change", route_stop_id: selected }); }
      catch { map?.destroy(); map = null; $("#day-map").replaceChildren(make("p", "Map unavailable", "day-map-state")); }
    } else { map?.destroy(); map = null; $("#day-map").replaceChildren(make("p", "Route unavailable", "day-map-state")); }
    await loadNotes(); render();
    queue ||= createNoteSync({ store, api, scope, tourId, onChange: () => void loadNotes() });
    if (!offline) await queue.sync();
  }
  $("#day-record").onclick = async () => {
    if (recorder.active) { recorder.stop(); return; }
    const stop = selectedStop(), route = tour?.routes?.find(r => r.accepted === true);
    if (!stop || !scope || !boundClientId(tour)) return;
    recordingMessage = "";
    try { await recorder.start({ scope, tour_id: tour.id, client_id: boundClientId(tour), property_id: stop.property_id, route_version_id: route.id, route_stop_id: stop.id }); render(); }
    catch (error) { status(error.name === "NotAllowedError" ? "Microphone access denied" : "Recording unavailable"); renderControls(); }
  };
  $("#day-previous").onclick = () => { const stops = orderedDayStops(tour), i = stops.findIndex(s => s.id === selected); if (i > 0) select(stops[i - 1].id); };
  $("#day-next").onclick = () => { const stops = orderedDayStops(tour), i = stops.findIndex(s => s.id === selected); if (i >= 0 && i < stops.length - 1) select(stops[i + 1].id); };
  const updates = mountAutoRefresh({ document, window, refresh });
  $("#day-refresh").onclick = () => updates.refresh();
  const hide = () => { if (document.visibilityState === "hidden") recorder.stop(); };
  const leave = () => recorder.stop();
  document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", leave);
  const ready = updates.refresh();
  return { ready, refresh, get notes() { return notes; }, get recorder() { return recorder; }, dispose() { disposed = true; ++epoch; updates.dispose(); recorder.dispose(); map?.destroy(); document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave); close(); } };
}
if (typeof document !== "undefined" && document.querySelector("#tour-day")) {
  mountTourDay({ document, window });
  if (navigator.serviceWorker && location.protocol === "https:") navigator.serviceWorker.register("/tours/day-sw.js", { scope: "/tours/" }).catch(() => {});
}
