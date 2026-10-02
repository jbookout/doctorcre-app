import { buildRouteVersionState, projectRoute, reduceMapEvent, buildNativeNavLink, buildReturnState, resolveReturn } from "./vendor/tour-map-route-state.js";

// Presentation adapter only: the accepted record owns order and identity.
// access_coordinate_status alone never supplies coordinates or human approval.
export function acceptedRouteFromDetail(detail) {
  const accepted = detail?.routes?.find(route => route.accepted === true);
  if (!accepted) return null;
  return {
    tour_id: detail.id, route_version: accepted.route_version, route_version_id: accepted.id,
    projection_id: detail.projection_id || `unprojected:${accepted.id}`,
    canonical_dataset_version: detail.canonical_dataset_version ?? null,
    component_registry_version: detail.component_registry_version ?? null,
    start_point: accepted.start_point ?? null, end_point: accepted.end_point ?? null,
    stops: (accepted.stops || []).filter(stop => stop.stop_state === "active").map(stop => ({
      route_stop_id: stop.id, property_id: stop.property_id, route_sequence: stop.route_sequence,
      route_label: stop.route_label, locked_state: stop.locked_appointment ? "locked" : "flexible",
      appointment_start: stop.appointment_start, appointment_end: stop.appointment_end,
      dwell_minutes: stop.dwell_minutes, buffer_minutes: stop.buffer_minutes,
      title: stop.property_name || stop.name || "Saved property", address_line: stop.property_address || stop.address || "",
      position: stop.position ?? null, source_ref: stop.source_ref ?? null,
    })),
  };
}

const PLACEHOLDER_STYLE = { version: 8, sources: {}, layers: [
  { id: "background", type: "background", paint: { "background-color": "#07111f" } },
] };
async function loadVendoredMapLibre() {
  return import("./vendor/maplibre-gl-6.4.1/maplibre-gl.mjs");
}

// Provider bounds may span world copies; canonical bounds use EPSG:4326.
export function normalizedProviderBounds([[west, south], [east, north]]) {
  const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
  return east - west >= 360 ? [-180, south, 180, north] : [wrap(west), south, wrap(east), north];
}

// Read compatibility v1: the pinned composer permits equal ISO instants.
// Preserve those exact windows without changing the pinned map module or
// widening its validation of identity, order, durations or other appointments.
export function buildAcceptedRouteState(route, options) {
  const iso = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === (/\.\d{3}Z$/.test(value) ? value : value.replace(/Z$/, ".000Z"));
  };
  const equalWindows = new Map();
  const stops = Array.isArray(route.stops) ? route.stops.map(stop => {
    if (!iso(stop?.appointment_start) || !iso(stop?.appointment_end) || Date.parse(stop.appointment_start) !== Date.parse(stop.appointment_end)) return stop;
    equalWindows.set(stop.route_stop_id, { start: stop.appointment_start, end: stop.appointment_end });
    return { ...stop, appointment_start: null, appointment_end: null };
  }) : route.stops;
  const result = buildRouteVersionState({ ...route, stops }, options);
  for (const stop of result.route.stops) if (equalWindows.has(stop.route_stop_id)) stop.appointment = equalWindows.get(stop.route_stop_id);
  return result;
}

/** One persistent map, with all surfaces derived from the CARR route projection. */
export function mountAcceptedItinerary(root, initial) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const make = (tag, text, className) => { const el = doc.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
  let options, state, projection, routeInput, map = null, gl = null, destroyed = false, generation = 0, mapFailure = "", returnNotice = "", storageNotice = "";
  const markers = new Map();
  const motion = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reducedMotion = initial.prefersReducedMotion ?? motion?.matches ?? false;
  const header = make("div", "", "itinerary-header"), title = make("h4", "Accepted itinerary");
  const version = make("span", "", "badge"), modes = make("div", "", "itinerary-modes");
  modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Map mode");
  for (const [mode, label] of [["search", "Search Mode"], ["tour", "Tour Mode"]]) {
    const button = make("button", label); button.type = "button"; button.dataset.mapMode = mode;
    button.addEventListener("click", () => dispatch({ type: "mode_change", mode })); modes.append(button);
  }
  header.append(title, version, modes);
  const notice = make("p", "", "hint"); notice.dataset.mapStatus = ""; notice.setAttribute("role", "status");
  const stage = make("div", "", "itinerary-stage"), canvas = make("div", "", "itinerary-map");
  canvas.setAttribute("role", "region"); canvas.setAttribute("aria-label", "Accepted itinerary map");
  const placeholder = make("p", "Basemap not configured · pins use CARR record coordinates", "itinerary-basemap-note");
  stage.append(canvas, placeholder);
  const legend = make("p", "● Fixed appointment · ◆ Flexible stop · Dashed pin: approximate location", "hint itinerary-legend");
  const grid = make("div", "", "itinerary-grid"), list = make("ol", "", "itinerary-list"), card = make("article", "", "itinerary-property-card");
  list.setAttribute("aria-label", "Accepted stops in visit order"); card.dataset.itineraryCard = "";
  card.setAttribute("aria-label", "Selected itinerary property"); grid.append(list, card);
  const day = initial.presentation === "day";
  if (day) {
    placeholder.textContent = "Stop locations · Street map unavailable";
    placeholder.className = "day-map-state";
    stage.removeChild(placeholder); notice.className = "day-map-state";
    root.replaceChildren(stage, placeholder, notice);
  } else root.replaceChildren(header, notice, stage, legend, grid);

  function key() {
    return `doctorcre-current-stop-v1:${JSON.stringify([options.scope, state.tour_id, state.route_version_id, state.route_version, state.projection_id])}`;
  }
  function persist(handoff = null) {
    if (!options.scope || !state?.current_route_stop_id) return;
    try {
      win.sessionStorage.setItem(key(), JSON.stringify({ stop: state.current_route_stop_id, return_state: handoff ? buildReturnState(handoff) : null }));
      win.sessionStorage.setItem("doctorcre-itinerary-tour-v1", JSON.stringify({ scope: options.scope, tour_id: state.tour_id }));
      storageNotice = "";
    } catch { storageNotice = "Storage unavailable; navigation return cannot be restored after reload. Current stop stays in this tab's memory; keep this tab open."; renderStatus(); }
  }
  function restore() {
    if (!options.scope) return;
    try {
      const saved = JSON.parse(win.sessionStorage.getItem(key()) || "null");
      if (saved?.return_state) {
        const returned = resolveReturn(state, saved.return_state, { now: new Date().toISOString(), user_ref: options.user_ref });
        if (returned.ok) { state = returned.state; return; }
        // A refused handoff marker must not be restored as an ordinary selection.
        returnNotice = "Navigation return could not be restored. Select the current stop from the ordered list.";
        return;
      }
      if (state.route.stops.some(stop => stop.route_stop_id === saved?.stop)) {
        state = reduceMapEvent(state, { type: "route_stop_change", route_version: state.route_version, route_stop_id: saved.stop }).state;
      }
    } catch { /* Invalid tab state is never authority for the accepted route. */ }
  }
  function provenance(stopId) {
    const raw = routeInput.stops.find(stop => stop.route_stop_id === stopId);
    return `Source ${raw?.source_ref || "unknown"} · Precision ${raw?.position?.precision_class?.replaceAll("_", " ") || "unknown"}`;
  }
  function fallback(reason) {
    mapFailure = reason; renderStatus();
  }
  function renderStatus() {
    const noCoordinates = projection && !projection.markers.some(marker => marker.position);
    canvas.hidden = Boolean(mapFailure || noCoordinates);
    if (day) {
      notice.textContent = mapFailure ? "Map unavailable" : noCoordinates ? "Stop locations unavailable" : "";
      placeholder.hidden = Boolean(mapFailure || noCoordinates);
      return;
    }
    notice.textContent = [storageNotice, returnNotice || (mapFailure || noCoordinates
      ? `${mapFailure || "No recorded coordinates are available."} Use the ordered list; visit order and current stop are preserved.`
      : "Pins show recorded locations. The basemap is a configured placeholder; use the ordered list for visit order.")].filter(Boolean).join(" ");
  }
  function select(stopId, feature = false) {
    if (options.canSelect?.() === false) return;
    const stop = state.route.stops.find(item => item.route_stop_id === stopId);
    if (!stop) return;
    dispatch(state.mode === "tour" ? { type: "route_stop_change", route_stop_id: stopId }
      : { type: feature ? "feature_click" : "selected_record", property_id: stop.property_id });
    focus();
    options.onSelect?.(stopId);
  }
  function dispatch(event) {
    if (!state || destroyed) return;
    state = reduceMapEvent(state, { ...event, route_version: state.route_version }).state;
    if (event.type === "route_stop_change") persist();
    render();
  }
  function focus() {
    const selected = projection?.markers.find(marker => marker.selected);
    if (!map || !selected?.position || canvas.hidden) return;
    const camera = { center: [selected.position.longitude, selected.position.latitude], zoom: 12, duration: projection.camera_plan.duration_ms };
    map[projection.camera_plan.method](camera);
  }
  function renderMarkers() {
    if (!map || !gl || !projection) return;
    const wanted = new Set(projection.markers.filter(marker => marker.position).map(marker => marker.route_stop_id));
    for (const [stopId, marker] of markers) if (!wanted.has(stopId)) { marker.remove(); markers.delete(stopId); }
    for (const item of projection.markers) {
      if (!item.position) continue;
      let marker = markers.get(item.route_stop_id);
      if (!marker) {
        const button = make("button"); button.type = "button"; button.dataset.routeStopId = item.route_stop_id;
        button.addEventListener("click", () => select(item.route_stop_id, true));
        marker = new gl.Marker({ element: button }).setLngLat([item.position.longitude, item.position.latitude]).addTo(map);
        // Keep DOM references on our view object, not in the canonical route state.
        marker.itineraryElement = button; markers.set(item.route_stop_id, marker);
      }
      marker.setLngLat([item.position.longitude, item.position.latitude]);
      const button = marker.itineraryElement;
      button.className = `itinerary-pin ${item.shape} ${item.display}${item.selected ? " selected" : ""}`;
      button.replaceChildren(make("span", item.label));
      if (!day) button.append(make("small", provenance(item.route_stop_id), "itinerary-pin-source"));
      button.setAttribute("aria-pressed", String(item.selected));
      button.setAttribute("aria-label", day ? item.accessible_name : `${item.accessible_name}. ${provenance(item.route_stop_id)}`);
      button.title = day ? item.accessible_name : `${item.accessible_name}. ${provenance(item.route_stop_id)}`;
    }
  }
  function render() {
    if (!state) return;
    const focusedStop = list.contains(doc.activeElement) ? doc.activeElement.closest('[data-itinerary-stop]')?.dataset.itineraryStop : null;
    projection = projectRoute(state, { prefersReducedMotion: reducedMotion, promotion_receipt: options.promotion_receipt, user_ref: options.user_ref });
    version.textContent = `Version ${projection.route_version} · accepted`;
    for (const button of modes.children) button.setAttribute("aria-pressed", String(button.dataset.mapMode === state.mode));
    list.replaceChildren();
    for (const item of projection.list) {
      const row = make("li", "", `itinerary-stop ${item.display}${item.selected ? " selected" : ""}`); row.dataset.itineraryStop = item.route_stop_id;
      row.dataset.propertyId = item.property_id;
      if (item.current) row.setAttribute("aria-current", "step");
      const button = make("button"); button.type = "button"; button.setAttribute("aria-pressed", String(item.selected));
      button.append(make("b", item.label, "itinerary-stop-label"), make("span", item.title));
      button.addEventListener("click", () => select(item.route_stop_id));
      const offlineStop = projection.offline_itinerary.find(stop => stop.route_stop_id === item.route_stop_id);
      row.append(button, make("small", offlineStop.address_line || "Address unknown"),
        make("small", `${item.precision_label} · ${item.current ? "Current stop · " : ""}${item.locked_state === "locked" ? "Fixed" : "Flexible"}`),
        make("small", `Dwell ${item.dwell_minutes ?? "unknown"} min · Buffer ${item.buffer_minutes ?? "unknown"} min`), make("small", provenance(item.route_stop_id)));
      if (item.appointment) row.append(make("small", `${new Date(item.appointment.start).toLocaleString(undefined, { hour12: true })} → ${new Date(item.appointment.end).toLocaleString(undefined, { hour12: true })}`));
      list.append(row);
    }
    if (!projection.list.length) list.append(make("li", "No active stops on this accepted route."));
    if (focusedStop) [...list.children].find(row => row.dataset.itineraryStop === focusedStop)?.querySelector("button")?.focus({ preventScroll: true });
    card.replaceChildren(); card.removeAttribute("data-property-id");
    const selected = projection.card;
    if (selected) {
      card.dataset.propertyId = selected.property_id;
      card.append(make("p", `Stop ${selected.label}`, "eyebrow"), make("h4", selected.title), make("p", selected.address_line || "Address unknown", "hint"),
        make("p", selected.precision_label, `itinerary-precision ${selected.display}`), make("p", provenance(selected.route_stop_id), "hint"),
        make("p", `${selected.locked_state === "locked" ? "Fixed appointment" : "Flexible stop"} · Dwell ${selected.dwell_minutes ?? "unknown"} min · Buffer ${selected.buffer_minutes ?? "unknown"} min`, "hint"));
      if (selected.appointment) {
        const local = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
        card.append(make("p", `${local(selected.appointment.start)} → ${local(selected.appointment.end)}`, "hint"));
      }
      const actions = make("div", "", "itinerary-navigation");
      for (const [platform, label] of [["apple_maps", "Apple Maps"], ["google_maps", "Google Maps"]]) {
        const handoff = buildNativeNavLink(state, { route_stop_id: selected.route_stop_id, platform, travel_mode: "driving", now: new Date().toISOString(), promotion_receipt: options.promotion_receipt, user_ref: options.user_ref });
        if (!handoff.available) continue;
        const link = make("a", label); link.href = handoff.link; link.rel = "noopener noreferrer";
        link.addEventListener("click", event => {
          const freshHandoff = buildNativeNavLink(state, { route_stop_id: selected.route_stop_id, platform, travel_mode: "driving", now: new Date().toISOString(), promotion_receipt: options.promotion_receipt, user_ref: options.user_ref });
          if (!freshHandoff.available) { event.preventDefault(); render(); return; }
          link.href = freshHandoff.link;
          // Search can inspect a property; navigation explicitly makes it current.
          state = reduceMapEvent(state, { type: "mode_change", mode: "tour", route_version: state.route_version }).state;
          state = reduceMapEvent(state, { type: "route_stop_change", route_stop_id: selected.route_stop_id, route_version: state.route_version }).state;
          persist(freshHandoff); render();
        }); actions.append(link);
      }
      if (actions.children.length) card.append(actions);
      else card.append(make("p", `Navigation unavailable. ${selected.native_navigation.reason}`, "hint itinerary-navigation-reason"));
    } else card.append(make("p", "Select a stop to inspect its recorded location.", "hint"));
    renderMarkers(); renderStatus();
  }
  function update(next) {
    const previousScope = options?.scope;
    options = { ...initial, ...next }; routeInput = options.route;
    if (!routeInput) { state = projection = null; root.hidden = true; return; }
    // Geometry is optional; identity, order and appointment validation remain canonical.
    if (Array.isArray(routeInput.stops)) routeInput = { ...routeInput, stops: routeInput.stops.map(stop => {
      const point = stop?.position;
      const usable = point && typeof point.latitude === "number" && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
        && typeof point.longitude === "number" && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
      return stop && { ...stop, position: usable ? point : null };
    }) };
    root.hidden = false;
    const same = state && state.tour_id === routeInput.tour_id && state.route_version_id === routeInput.route_version_id
      && state.route_version === routeInput.route_version && state.projection_id === routeInput.projection_id && options.scope === previousScope;
    const refreshed = buildAcceptedRouteState(routeInput, {
      mode: same ? state.mode : "tour", selected_property_id: same ? state.selected_property_id : null,
    });
    if (same) {
      state = { ...state, ...refreshed, camera: state.camera, filters: state.filters, sliders: state.sliders,
        drawn_geometry: state.drawn_geometry, lineage: state.lineage,
        current_route_stop_id: refreshed.route.stops.some(stop => stop.route_stop_id === state.current_route_stop_id) ? state.current_route_stop_id : null };
    } else {
      returnNotice = "";
      state = refreshed; restore();
      if (!state.selected_property_id && state.route.stops.length) state = reduceMapEvent(state, { type: "route_stop_change", route_version: state.route_version, route_stop_id: state.route.stops[0].route_stop_id }).state;
    }
    render();
    if (map) { map.resize(); focus(); }
  }
  const offline = () => fallback("Map unavailable offline.");
  const onMotion = event => { reducedMotion = event.matches; render(); };
  win.addEventListener("offline", offline); motion?.addEventListener("change", onMotion);
  update(initial);
  ++generation;
  let initializing = null;
  const initialize = () => initializing ||= (async () => {
    const thisGeneration = generation;
    try {
      if (win.navigator.onLine === false) { offline(); return; }
      gl = await (initial.loadMapLibre || loadVendoredMapLibre)();
      if (destroyed || generation !== thisGeneration) return;
      gl.setWorkerUrl(new URL("./vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs", import.meta.url).href);
      map = new gl.Map({ container: canvas, style: structuredClone(PLACEHOLDER_STYLE), center: [-87.3, 30.5], zoom: 8, attributionControl: false });
      map.on("error", () => fallback("Map could not load."));
      map.on("moveend", () => { if (!state || destroyed) return; dispatch({ type: "bounds_change", bounds: normalizedProviderBounds(map.getBounds().toArray()) }); });
      map.on("load", () => { if (!canvas.hidden && !destroyed) { renderMarkers(); focus(); } });
      renderMarkers(); renderStatus(); focus();
    } catch { fallback("Map could not load."); }
  })().finally(() => { initializing = null; });
  const online = () => {
    mapFailure = ""; renderStatus();
    if (!map) void initialize(); else { map.resize(); renderMarkers(); focus(); }
  };
  win.addEventListener("online", online);
  const ready = initialize();
  return {
    ready, update, dispatch, get projection() { return projection; },
    navigationLinks() { return [...card.querySelectorAll(".itinerary-navigation a")]; },
    destroy() { destroyed = true; ++generation; win.removeEventListener("offline", offline); win.removeEventListener("online", online); motion?.removeEventListener("change", onMotion); for (const marker of markers.values()) marker.remove(); map?.remove(); root.replaceChildren(); },
  };
}
