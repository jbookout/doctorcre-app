import { sessionFetch } from '../js/private-session.js';
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

export function createPlannerClient({ fetchImpl = sessionFetch, timeoutMs = 10_000 } = {}) {
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
      if (signal.aborted) throw new Error("Session superseded");
      if (revision !== scopeRevision && !payload.csrf_token) {
        if (revision === 0 && scopeRevision === 1 && scope !== null) return read(path, { signal });
        throw new Error("Session superseded");
      }
      return payload.data || payload;
    }, { timeoutMs, signal: parentSignal });
  };
  return {
    get scope() { return scope; },
    onScopeChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async library(options) { const data = await read("/api/tours/library", options); return validateTourList(data.tours); },
    async clients({ page = 1, signal } = {}) {
      if (!Number.isInteger(page) || page < 1) throw new Error("Invalid client page");
      const data = await read(`/api/v1/business/clients?scope=team&sort=name&page=${page}`, { signal });
      if (!Number.isInteger(data.page_count) || data.page_count < 0 || data.page !== page ||
          page > Math.max(1, data.page_count)) throw new Error("Invalid client list");
      return { rows: validateClientList(data.rows), page, pageCount: data.page_count };
    },
    async client(id, options) {
      if (!recordId.test(id)) throw new Error("Invalid client");
      const data = await read(`/api/v1/business/clients/${encodeURIComponent(id)}`, options);
      return validateClientRecord(data.record, id);
    },
    async tour(id, options) {
      if (!recordId.test(id)) throw new Error("Invalid tour");
      const data = await read(`/api/tours/detail?tour_id=${encodeURIComponent(id)}`, options);
      return validateTourDetail(data, id);
    },
    // Compilation and MLS reads have no authorized CARR verb.
    capabilities: Object.freeze({ compile: false, mls: false }),
  };
}
