import { readWithDeadline } from "../js/auto-refresh.mjs";
const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value, fields) => fields.every(field => value[field] == null || typeof value[field] === "string");
const validRow = row => object(row) && recordId.test(row.id) && strings(row, ["name", "status"]);
const validStop = stop => object(stop) && strings(stop, ["stop_state", "property_name", "name", "property_address", "address", "appointment_start"]);
export function validateTourList(rows) {
  if (!Array.isArray(rows) || !rows.every(validRow)) throw new Error("Invalid tour list");
  return rows;
}
export function validateClientRecord(record, id = record?.id) {
  if (!validRow(record) || record.id !== id || !strings(record, ["city", "state", "vertical", "specialty", "notes"])) throw new Error("Invalid client record");
  return record;
}
export function validateClientList(rows) {
  if (!Array.isArray(rows)) throw new Error("Invalid client list");
  rows.forEach(row => validateClientRecord(row)); return rows;
}
export function validateTourDetail(tour, id = tour?.id) {
  if (!validRow(tour) || tour.id !== id || !Array.isArray(tour.stops) || !tour.stops.every(validStop) ||
      (tour.routes != null && (!Array.isArray(tour.routes) || !tour.routes.every(route => object(route) && Array.isArray(route.stops) && route.stops.every(validStop))))) throw new Error("Invalid tour detail");
  return tour;
}

export function createPlannerClient({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let scope = null, scopeRevision = 0;
  const listeners = new Set();
  function setScope(next) {
    if (scope === next) return;
    ++scopeRevision; scope = next; for (const listener of listeners) listener();
  }
  const read = (path, { signal: parentSignal } = {}) => {
    const revision = scopeRevision;
    return readWithDeadline(async signal => {
      const response = await fetchImpl(path, { signal, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      if (signal.aborted) throw new Error("Read cancelled");
      if (revision !== scopeRevision && !response.ok) throw new Error("Session superseded");
      if ([401, 403].includes(response.status)) {
        setScope(null);
        const error = new Error("Sign in required"); error.code = "authentication_required"; throw error;
      }
      if (!response.ok) throw new Error("Unavailable");
      const payload = await response.json();
      if (payload.csrf_token) {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.csrf_token));
        if (signal.aborted) throw new Error("Read cancelled");
        const nextScope = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (revision !== scopeRevision && nextScope !== scope) throw new Error("Session superseded");
        setScope(nextScope);
      }
      if (signal.aborted || (revision !== scopeRevision && !payload.csrf_token)) throw new Error("Session superseded");
      return payload.data || payload;
    }, { timeoutMs, signal: parentSignal });
  };
  return {
    get scope() { return scope; },
    onScopeChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async library(options) { const data = await read("/api/tours/library", options); return validateTourList(data.tours); },
    async clients(options) {
      const rows = []; let page = 1;
      do {
        const data = await read(`/api/v1/business/clients?scope=team&sort=name&page=${page}`, options);
        if (!Array.isArray(data.rows) || !Number.isInteger(data.page_count) || data.page !== page) throw new Error("Invalid client list");
        rows.push(...validateClientList(data.rows));
        if (page >= data.page_count) return rows;
        page += 1;
      } while (page <= 200);
      throw new Error("Client list incomplete");
    },
    async client(id, options) {
      if (!recordId.test(id)) throw new Error("Invalid client");
      const data = await read(`/api/v1/business/clients/${encodeURIComponent(id)}`, options);
      if (data.record?.id !== id) throw new Error("Client mismatch");
      return validateClientRecord(data.record, id);
    },
    async tour(id, options) {
      if (!recordId.test(id)) throw new Error("Invalid tour");
      const data = await read(`/api/tours/detail?tour_id=${encodeURIComponent(id)}`, options);
      if (data.id !== id) throw new Error("Tour mismatch"); return validateTourDetail(data, id);
    },
    // The deployed registry has no authorized raw-file compiler or MLS query.
    // The reviewed property register is deliberately not offered as an MLS feed.
    capabilities: Object.freeze({ compile: false, mls: false }),
  };
}
