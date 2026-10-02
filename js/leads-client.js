import { uuidv4 } from "./uuid.js";
import { observeDocClient } from './doc-context.js';

/** A deliberately small MCP client for the lead board and candidate decisions.
 * Authentication remains the host's
 * same-origin cookie; there is no client-side identity or alternate endpoint. */
export function createLeadBoardClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((path, init) => fetch(path, init));
  const uuid = options.uuid || uuidv4;
  let rpcId = 0;

  function typedError(payload, fallback = "The lead board request was refused.", status) {
    const error = new Error(payload?.message || payload?.hint || fallback);
    error.code = payload?.error || payload?.code || "tool_error";
    error.payload = payload || {};
    if (status) error.status = status;
    return error;
  }

  function unknownOutcome(cause) {
    const error = new Error("The server did not confirm the result. Retry the same request key.");
    error.code = "unknown_outcome";
    error.cause = cause;
    return error;
  }

  async function rpc(name, args = {}, mutation = false, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl("/mcp", {
        method: "POST",
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch (cause) {
      if (mutation) throw unknownOutcome(cause);
      const error = new Error("The Lead Board could not reach the server.");
      error.code = "network_error";
      error.cause = cause;
      throw error;
    }
    let envelope;
    try { envelope = await response.json(); }
    catch (cause) { throw mutation ? unknownOutcome(cause) : typedError(null, "The Lead Board returned an unreadable response.", response.status); }
    if (!response.ok || envelope?.error) {
      if (mutation) throw unknownOutcome(envelope);
      throw typedError(envelope?.error || envelope, `The Lead Board request failed (${response.status}).`, response.status);
    }
    const content = envelope?.result?.content;
    const validContent = Array.isArray(content) && content.every((item) =>
      item !== null && typeof item === "object" && typeof item.type === "string" &&
      (item.type !== "text" || typeof item.text === "string"));
    if (!validContent) throw mutation ? unknownOutcome(envelope) : typedError(null, "The Lead Board returned malformed content.");
    const text = content.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw mutation ? unknownOutcome(envelope) : typedError(null, "The Lead Board returned an incomplete response.");
    let payload;
    try { payload = JSON.parse(text); }
    catch (cause) {
      if (mutation) throw unknownOutcome(cause);
      const error = typedError(null, "The Lead Board returned an unreadable response. The result may be unknown.");
      error.code = "unreadable_response";
      throw error;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw mutation ? unknownOutcome(payload) : typedError(null, "The Lead Board returned an incomplete response.");
    if (envelope?.result?.isError || payload?.error || payload?.ok === false) {
      if (payload?.error === "carr_unavailable") throw unknownOutcome(payload);
      throw typedError(payload);
    }
    if (mutation && payload.ok !== true) throw unknownOutcome(payload);
    return payload;
  }

  return observeDocClient({
    async getActor() {
      const board = await rpc("deal-room-board", { workspace: "team" });
      return typeof board.actor === "string" && board.actor.trim() ? board.actor : null;
    },
    getLeadBoard: (options = {}) => rpc("lead-board", {}, false, options),
    getClaimCard: () => rpc("claim-card", { limit: 5 }),
    promoteCandidate(candidate, evidence, idempotencyKey) {
      return rpc("promote-pool", {
        pool_id: candidate.pool_id, base_version: candidate.base_version,
        stage: "outreach_active", research_evidence: evidence,
        idempotency_key: idempotencyKey,
      }, true);
    },
    declineCandidate(candidate, reason, idempotencyKey) {
      return rpc("decline-candidate", {
        pool_id: candidate.pool_id, base_version: candidate.base_version,
        reason, idempotency_key: idempotencyKey,
      }, true);
    },
    moveLeadStage(lead, stage) {
      return rpc("update-lead", {
        lead: lead.registry_ref || lead.id,
        base_version: lead.base_version,
        fields: { stage },
        idempotency_key: uuid(),
      });
    },
  }, options.docContext === false ? null : undefined);
}
