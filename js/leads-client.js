import { uuidv4 } from "./uuid.js";

/** A deliberately small MCP client for the lead board and candidate decisions.
 * Authentication remains the host's
 * same-origin cookie; there is no client-side identity or alternate endpoint. */
export function createLeadBoardClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((path, init) => fetch(path, init));
  const uuid = options.uuid || uuidv4;
  let rpcId = 0;

  function typedError(payload, fallback = "The lead board request was refused.") {
    const error = new Error(payload?.message || payload?.hint || fallback);
    error.code = payload?.error || payload?.code || "tool_error";
    error.payload = payload || {};
    return error;
  }

  async function rpc(name, args = {}) {
    let response;
    try {
      response = await fetchImpl("/mcp", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch (cause) {
      const error = new Error("The Lead Board could not reach the server.");
      error.code = "network_error";
      error.cause = cause;
      throw error;
    }
    const envelope = await response.json().catch(() => null);
    if (!response.ok) throw typedError(envelope, `The Lead Board request failed (${response.status}).`);
    if (envelope?.error) throw typedError(envelope.error, "The Lead Board request was refused.");
    const text = envelope?.result?.content?.find((item) => item.type === "text")?.text;
    let payload;
    try { payload = text ? JSON.parse(text) : null; }
    catch {
      const error = typedError(null, "The Lead Board returned an unreadable response. The result may be unknown.");
      error.code = "unreadable_response";
      throw error;
    }
    if (envelope?.result?.isError || payload?.error || payload?.ok === false) throw typedError(payload);
    return payload;
  }

  return {
    getLeadBoard: () => rpc("lead-board"),
    getClaimCard: () => rpc("claim-card", { limit: 5 }),
    promoteCandidate(candidate, evidence, idempotencyKey) {
      return rpc("promote-pool", {
        pool_id: candidate.pool_id, base_version: candidate.base_version,
        stage: "outreach_active", research_evidence: evidence,
        idempotency_key: idempotencyKey,
      });
    },
    declineCandidate(candidate, reason, idempotencyKey) {
      return rpc("decline-candidate", {
        pool_id: candidate.pool_id, base_version: candidate.base_version,
        reason, idempotency_key: idempotencyKey,
      });
    },
    moveLeadStage(lead, stage) {
      return rpc("update-lead", {
        lead: lead.registry_ref || lead.id,
        base_version: lead.base_version,
        fields: { stage },
        idempotency_key: uuid(),
      });
    },
  };
}
