import { readWithDeadline } from "../js/auto-refresh.mjs";
const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPlannerClient({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let scope = null;
  const read = path => readWithDeadline(async signal => {
    const response = await fetchImpl(path, { signal, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Unavailable");
    const payload = await response.json();
    if (payload.csrf_token) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.csrf_token));
      scope = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    return payload.data || payload;
  }, { timeoutMs });
  return {
    get scope() { return scope; },
    async library() { const data = await read("/api/tours/library"); if (!Array.isArray(data.tours)) throw new Error("Invalid tour list"); return data.tours; },
    async clients() {
      const rows = []; let page = 1;
      do {
        const data = await read(`/api/v1/business/clients?scope=team&sort=name&page=${page}`);
        if (!Array.isArray(data.rows) || !Number.isInteger(data.page_count) || data.page !== page) throw new Error("Invalid client list");
        rows.push(...data.rows);
        if (page >= data.page_count) return rows;
        page += 1;
      } while (page <= 200);
      throw new Error("Client list incomplete");
    },
    async client(id) {
      if (!recordId.test(id)) throw new Error("Invalid client");
      const data = await read(`/api/v1/business/clients/${encodeURIComponent(id)}`);
      if (data.record?.id !== id) throw new Error("Client mismatch");
      return data.record;
    },
    async tour(id) {
      if (!recordId.test(id)) throw new Error("Invalid tour");
      const data = await read(`/api/tours/detail?tour_id=${encodeURIComponent(id)}`);
      if (data.id !== id) throw new Error("Tour mismatch"); return data;
    },
    // The deployed registry has no authorized raw-file compiler or MLS query.
    // The reviewed property register is deliberately not offered as an MLS feed.
    capabilities: Object.freeze({ compile: false, mls: false }),
  };
}
