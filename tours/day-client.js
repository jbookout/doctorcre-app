import { readWithDeadline } from "../js/auto-refresh.mjs";
import { validateTourDetail } from "./planner-client.js";

export function createDayClient({ fetchImpl = globalThis.fetch } = {}) {
  let scope = null;
  async function read(path, options = {}) {
    return readWithDeadline(async signal => {
      const response = await fetchImpl(path, { credentials: "same-origin", cache: "no-store", signal });
      if ([401, 403].includes(response.status)) { scope = null; const e = new Error("sign_in_required"); e.authentication = true; throw e; }
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    }, options);
  }
  return {
    get scope() { return scope; },
    // No upload endpoint or transcription/dual-filing receipt is deployed or
    // pinned. This surface supports local capture only.
    capabilities: Object.freeze({ voiceNotes: false }),
    async session(options) {
      const session = await read("/api/system-work/session", options);
      if (!session.csrf_token || !session.actor?.slug) throw new Error("session_invalid");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.csrf_token));
      scope = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, "0")).join("");
      return { scope, user_ref: session.actor.slug };
    },
    async tour(id, options) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error("invalid_tour");
      const body = await read(`/api/tours/detail?tour_id=${encodeURIComponent(id)}`, options);
      return validateTourDetail(body.data || body, id);
    },
  };
}
