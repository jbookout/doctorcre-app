// Tour route draft lifecycle. CARR retains route authority; this module owns
// the tab's edits, retained requests and explicit recovery of uncertain writes.
export function createTourRouteDraft({ routes, storage = globalThis.sessionStorage, crypto = globalThis.crypto, onChange = () => {}, onStorageUnavailable = () => {} }) {
  const id = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const text = (value, fallback = "") => typeof value === "string" && value ? value : fallback;
  const digest = value => /^sha256:[0-9a-f]{64}$/i.test(value);
  const uuid = () => crypto.randomUUID();
  async function sha256(value) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); return `sha256:${[...hash].map(byte => byte.toString(16).padStart(2,"0")).join("")}`; }
  let composer = null, tour = null, sessionBinding = "", createPending = null;
  const routeEndpoints = new Map();
  const pendingKey = "doctorcre-tour-pending-v1";
  const notify = () => onChange();
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
  function routeRows(tour) {
    return (Array.isArray(tour?.stops) ? tour.stops : []).filter(stop => id(stop.property_id)).map(stop => ({ ...stop,
      route_label: text(stop.route_label, String(stop.route_sequence || 1)), stop_state: stop.stop_state || "active",
      dwell_minutes: Number(stop.dwell_minutes || 0), buffer_minutes: Number(stop.buffer_minutes || 0),
      locked_appointment: stop.locked_appointment === true, appointment_start: stop.appointment_start || null, appointment_end: stop.appointment_end || null }));
  }
  function routeSnapshot(tour) { return JSON.stringify({ routeId: tour.route_version_id, prior: tour.accepted_route_version, routes: tour.routes, stops: tour.stops }); }
  function readPending() {
    try { const saved = JSON.parse(storage.getItem(pendingKey) || "null"); return saved?.sessionBinding === sessionBinding ? saved : null; } catch { return null; }
  }
  function persistPending() {
    if (!composer && readPending()?.composer?.plan) return;
    const pending = createPending ? { create: createPending } : composer?.plan ? { composer: { ...composer, busy: false, undo: null } } : null;
    try {
      if (pending) storage.setItem(pendingKey, JSON.stringify({ sessionBinding, ...pending }));
      else storage.removeItem(pendingKey);
    } catch { onStorageUnavailable(); }
  }
  async function bindSession(token) {
    const binding = await sha256(token), changed = Boolean(sessionBinding && sessionBinding !== binding);
    sessionBinding = binding;
    if (changed) {
      createPending = null; routeEndpoints.clear();
      if (composer) { composer.plan = null; composer.phase = "session-changed"; composer.saved = false; composer.dirty = false; composer.undo = null; composer.message = "session-changed"; }
      persistPending(); notify();
    }
    return changed;
  }
  async function write(path, body, binding) {
    if (!binding || binding !== sessionBinding) throw new Error("session_changed");
    const data = await routes.write(path, body, binding);
    if (binding !== sessionBinding) throw new Error("session_changed");
    return data;
  }
  async function read(tourId, { requireRoute = true } = {}) {
    const detail = await routes.detail(tourId);
    if (requireRoute || detail.routes?.length || createPending || readPending()?.composer?.plan) validateDetail(detail, tourId);
    return detail;
  }
  function init(detail) {
    tour = detail;
    const rows = routeRows(detail), accepted = (detail.routes || []).find(route => route.accepted);
    const base = accepted ? { ...accepted, stops: routeRows({ stops: accepted.stops }) } : null;
    composer = { sessionBinding, tourId: detail.id, routeId: detail.route_version_id, prior: Number(detail.accepted_route_version || 0), snapshot: routeSnapshot(detail), reviewDigest: detail.routes?.[0]?.acceptance_digest || "", rows, base, dirty: false, saved: detail.route_version_state === "draft" && rows.length > 0,
      phase: "ready", message: "", busy: false, plan: null, undo: null };
    const retained = readPending()?.composer;
    if (retained?.tourId === detail.id && retained.plan) composer = { ...retained, busy: false, phase: "unknown", message: "restored" };
    const values = Object.fromEntries(["start","end"].map(role => {
      const point = routeEndpoints.get(detail.id)?.[role], retainedPoint = composer.endpointDraft?.[role];
      return [role, {latitude: String(retainedPoint?.latitude ?? point?.latitude ?? ""), longitude: String(retainedPoint?.longitude ?? point?.longitude ?? ""), source: String(retainedPoint?.source ?? point?.source_ref ?? "")}];
    }));
    composer.endpointDraft = values; composer.endpointBaseline ??= values;
  }
  function editable() { return Boolean(composer && !createPending && !composer.busy && !composer.saved && composer.phase === "ready" && !composer.plan); }
  function open(detail) {
    const changed = Boolean(composer && composer.snapshot !== routeSnapshot(detail));
    if (changed && (composer.dirty || composer.plan || composer.busy)) return { blocked: true, changed };
    if (!composer || composer.tourId !== detail.id || changed) init(detail);
    tour = detail; notify(); return { blocked: false, changed };
  }
  function endpoint(role, value) {
    const latitude = String(value?.latitude ?? "").trim(), longitude = String(value?.longitude ?? "").trim(), source_ref = String(value?.source ?? "").trim();
    if (!latitude || !longitude || !source_ref || /(contact|phone|email|internal|client|@)/i.test(source_ref) || source_ref.length > 240 ||
      !Number.isFinite(Number(latitude)) || Math.abs(Number(latitude)) > 90 || !Number.isFinite(Number(longitude)) || Math.abs(Number(longitude)) > 180) throw new Error("point_invalid");
    return { latitude: Number(latitude), longitude: Number(longitude), position_role: role, precision_class: "approximate", source_ref };
  }
  function rememberEdit() { composer.undo = { rows: composer.rows.map(row => ({ ...row })), endpoints: composer.endpointDraft }; composer.dirty = true; composer.message = "edited"; }
  function edit(change) {
    if (!editable()) return;
    const rows = composer.rows;
    if (change.type === "add") {
      const added = change.properties.filter(property => !rows.some(row => row.property_id === property.property_id));
      if (!added.length) { composer.message = "all-added"; notify(); return; }
      if (rows.length + added.length > 100) { composer.message = "route-full"; notify(); return; }
      rememberEdit();
      for (const property of added) rows.push({ property_id: property.property_id, name: property.name || null, address: property.address || null,
        route_label: String(rows.length + 1), stop_state: "active", dwell_minutes: 30, buffer_minutes: 10, locked_appointment: false, appointment_start: null, appointment_end: null, access_coordinate_status: "unknown" });
    } else if (change.type === "field") {
      const row = rows.find(row => row.property_id === change.propertyId); if (!row) return;
      rememberEdit(); row[change.field] = change.value;
    } else if (change.type === "move") {
      const index = rows.findIndex(row => row.property_id === change.propertyId), destination = index + change.delta;
      if (index < 0 || destination < 0 || destination >= rows.length) return;
      rememberEdit(); [rows[index],rows[destination]] = [rows[destination],rows[index]];
    } else if (change.type === "endpoints") {
      rememberEdit(); composer.endpointDraft = change.values;
    } else if (change.type === "undo") {
      if (!composer.undo) return;
      composer.rows = composer.undo.rows; composer.endpointDraft = composer.undo.endpoints; composer.undo = null; composer.dirty = true; composer.message = "undone";
    }
    notify();
  }
  async function save({ endpoints, candidates = [] } = {}) {
    if (!editable() || !composer.dirty) return;
    const current = composer; current.busy = true; notify();
    try {
      let sequence = 0; const labels = new Set();
      const rows = current.rows.map(row => {
        const active = row.stop_state === "active", label = active ? row.route_label.trim() : null;
        if (active && (!/^[A-Za-z0-9]{1,3}$/.test(label) || labels.has(label))) throw new Error("labels-invalid");
        labels.add(label);
        if (![row.dwell_minutes, row.buffer_minutes].every(value => Number.isInteger(value) && value >= 0 && value <= 1440)) throw new Error("minutes-invalid");
        if (Boolean(row.appointment_start) !== Boolean(row.appointment_end) || (row.appointment_start && Date.parse(row.appointment_end) < Date.parse(row.appointment_start)) || (row.locked_appointment && !row.appointment_start)) throw new Error("appointment-invalid");
        if (row.locked_appointment && !active) throw new Error("fixed-inactive");
        return { ...row, route_sequence: active ? ++sequence : null, route_label: label };
      });
      if (!sequence) throw new Error("active-required");
      const locked = rows.filter(row => row.locked_appointment && row.stop_state === "active");
      if (locked.some((row, index) => index > 0 && Date.parse(row.appointment_start) < Date.parse(locked[index - 1].appointment_start))) throw new Error("fixed-order");
      const base = current.base, latest = tour.routes?.[0];
      const plan = { kind: "save", tourId: current.tourId, routeId: base ? null : tour.route_version_id, steps: [], index: 0 };
      if (base) plan.steps.push({ path: "/api/tours/route-draft", body: { idempotency_key: uuid(), tour_id: current.tourId,
        route_version: Number(latest?.route_version || tour.route_version || 1) + 1, base_route_version_id: base.id,
        expected_route_version: base.route_version, start_point: endpoint("start", endpoints?.start), end_point: endpoint("end", endpoints?.end) }, resultField: "route_version_id" });
      for (const row of rows) {
        // Bind the candidate facts visible to the operator; unknown access remains unknown.
        const assertion = row.assertion_set_digest || await sha256(JSON.stringify({ property_id: row.property_id, candidate: candidates.find(candidate => candidate.property_id === row.property_id) || { name: row.name, address: row.address } }));
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
      return await runComposerPlan(current);
    } catch (error) { current.message = error.message === "point_invalid" ? "point-invalid" : error.message; }
    finally { current.busy = false; notify(); }
  }
  async function runComposerPlan(current) {
    const plan = current.plan;
    try {
      for (; plan.index < plan.steps.length; plan.index++) {
        const step = plan.steps[plan.index];
        if (step.path === "/api/tours/route-stop") step.body.route_version_id = plan.routeId;
        if (step.path === "/api/tours/route-stop-transition") { step.body.new_route_version_id = plan.routeId; step.body.new_route_stop_id = plan.steps[step.stopIndex].result; }
        current.progress = { index: plan.index + 1, total: plan.steps.length }; current.message = "saving"; if (composer === current) notify();
        persistPending();
        const data = await write(step.path, step.body, current.sessionBinding);
        if (!id(data[step.resultField])) throw new Error("outcome_unknown");
        step.result = data[step.resultField]; if (step.path === "/api/tours/route-draft") { plan.routeId = step.result; routeEndpoints.set(plan.tourId, { start: step.body.start_point, end: step.body.end_point }); }
      }
      const detail = await read(plan.tourId);
      if (plan.kind !== "accept" && detail.route_version_id !== plan.routeId) throw new Error("outcome_unknown");
      if (plan.kind === "accept" ? !detail.routes.some(route => route.id === plan.routeId && route.accepted) :
        !plan.steps.filter(step => step.path === "/api/tours/route-stop").every(step => detail.stops?.some(stop => stop.id === step.result))) throw new Error("outcome_unknown");
      current.plan = null; current.phase = "ready"; current.dirty = false; current.saved = plan.kind !== "accept"; current.undo = null;
      persistPending();
      current.message = plan.kind === "accept" ? "accepted" : "saved";
      if (composer === current) {
        tour = detail;
        if (plan.kind === "accept") { init(detail); composer.message = "accepted"; }
        else { current.routeId = detail.route_version_id; current.prior = Number(detail.accepted_route_version || 0); current.snapshot = routeSnapshot(detail); current.reviewDigest = detail.routes[0].acceptance_digest || ""; current.rows = routeRows(detail); }
      }
      return detail;
    } catch (error) {
      if (current.sessionBinding !== sessionBinding) { current.plan = null; current.phase = "session-changed"; return; }
      current.phase = error.writeRefusal ? error.status === 409 ? "stale" : "refused" : "unknown";
      current.message = current.phase === "stale" ? "stale" : current.phase === "refused" ? "refused" : "unknown";
      persistPending();
    }
  }
  async function accept() {
    if (!composer || createPending || !composer.saved || composer.dirty || composer.busy || composer.phase !== "ready" || !digest(composer.reviewDigest)) return;
    const current = composer; current.busy = true; notify();
    const prior = current.prior, routeId = current.routeId;
    // Bind the displayed stop set; a fresh read at Accept could include unreviewed changes.
    current.plan = { kind: "accept", tourId: current.tourId, routeId, index: 0, steps: [{ path: "/api/tours/route-accept", resultField: "route_version_acceptance_id",
      body: { route_version_id: routeId, expected_prior_route_version: prior, acceptance_digest: current.reviewDigest, idempotency_key: uuid() } }] };
    persistPending();
    const detail = await runComposerPlan(current); current.busy = false; notify(); return detail;
  }
  async function recover(action) {
    if (!composer || composer.busy) return;
    const current = composer;
    if (action === "retry") {
      if (current.phase !== "reconciled" || !current.plan) return;
      current.busy = true; notify();
      const detail = await runComposerPlan(current); current.busy = false; notify(); return detail;
    }
    if (action === "reconcile") {
      if (current.phase !== "unknown") return;
      current.busy = true; notify();
      try {
        const detail = await read(current.tourId);
        if (current.plan?.kind === "accept" && detail.routes.some(route => route.id === current.plan.routeId && route.accepted)) {
          current.plan = null; persistPending(); init(detail); composer.message = "reconciled-accepted"; return detail;
        }
        current.phase = "reconciled"; current.message = "reconciled";
      } catch { current.message = "reconcile-failed"; }
      finally { current.busy = false; notify(); }
      return;
    }
    if (action === "reload") {
      if (["unknown", "reconciled"].includes(current.phase)) return;
      const plan = current.plan; current.busy = true; notify();
      try {
        const detail = await read(current.tourId);
        if (composer !== current || current.plan !== plan) return;
        if (plan?.kind === "save" && plan.routeId && plan.index < plan.steps.length && detail.routes?.some(route => route.id === plan.routeId)) {
          current.phase = "reconciled"; current.saved = false; current.message = "partial"; return;
        }
        current.plan = null; persistPending(); init(detail); composer.message = "reloaded"; return detail;
      } finally { current.busy = false; notify(); }
    }
  }
  function view() {
    if (!composer) return null;
    return { tourId: composer.tourId, routeId: composer.routeId, prior: composer.prior, reviewDigest: composer.reviewDigest,
      rows: composer.rows.map(row => ({...row})), base: composer.base ? {...composer.base, stops: composer.base.stops.map(row=>({...row}))} : null,
      dirty: composer.dirty, saved: composer.saved, phase: composer.phase, notice: composer.message, busy: composer.busy,
      pending: Boolean(composer.plan), canUndo: Boolean(composer.undo), editable: editable(),
      endpoints: Object.fromEntries(Object.entries(composer.endpointDraft || {}).map(([role,value])=>[role,{...value}])),
      endpointBaseline: Object.fromEntries(Object.entries(composer.endpointBaseline || {}).map(([role,value])=>[role,{...value}])), progress: composer.progress ? {...composer.progress} : null };
  }
  return {
    get view() { return view(); }, get binding() { return sessionBinding; },
    get pendingTourId() { const retained = readPending()?.composer; return !composer && retained?.plan ? retained.tourId || "" : ""; },
    get pendingCreation() { return createPending || readPending()?.create || null; },
    bindSession, read, open, edit, save, accept, recover,
    retainCreation(value) { createPending = value; persistPending(); notify(); },
    rememberCreatedTour(tourId, points) { routeEndpoints.set(tourId, points); },
  };
}
