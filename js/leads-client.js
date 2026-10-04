import { observeDocClient } from './doc-context.js';
import { readWithDeadline } from "./auto-refresh.mjs";

/** A deliberately small MCP client for Home reads and the versioned Leads workspace.
 * Authentication remains the host's
 * same-origin cookie; there is no client-side identity or alternate endpoint. */
export function createLeadBoardClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((path, init) => fetch(path, init));
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

  function rpc(name, args = {}, mutation = false, { signal } = {}) {
    const promise = readWithDeadline(requestSignal => request(name, args, mutation, requestSignal),
      { timeoutMs: options.timeoutMs || 10_000, signal });
    return mutation ? promise.catch(error => { throw error.code === "read_timeout" ? unknownOutcome(error) : error; }) : promise;
  }
  async function request(name, args = {}, mutation = false, signal) {
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
    // Authorization is established by the headers even if the diagnostic body stalls.
    if (response.status === 401 || response.status === 403) {
      throw typedError({ error: response.status === 401 ? "not_authenticated" : "forbidden" },
        "Sign-in required", response.status);
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
    getWorkspace: async () => validateLeadWorkspace(await rpc("lead-board", { workspace: "leads" })),
    getLeadDetail: async (lead) => {
      const payload = validateLeadWorkspace(await rpc("lead-board", { workspace: "leads", lead_id: lead.id }));
      if (payload.detail !== null) validateLeadDetail(payload.detail, lead.id);
      return payload;
    },
    claimLead(lead, key, actor) {
      return rpc("claim-lead", { lead: lead.registry_ref || lead.id, base_version: lead.base_version,
        expected_actor: actor, idempotency_key: key }, true);
    },
    recordStage(lead, stage, review, key, actor) {
      return rpc("update-lead", { lead: lead.registry_ref || lead.id, base_version: lead.base_version,
        expected_actor: actor, fields: { stage }, stage_review: review, idempotency_key: key }, true);
    },
    linkClient(lead, clientId, key, actor) {
      return rpc("link-lead-client", { lead: lead.registry_ref || lead.id, base_version: lead.base_version,
        expected_actor: actor, client_id: clientId, confirmed: true, idempotency_key: key }, true);
    },
  }, options.docContext === false ? null : undefined);
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const optionalText = value => value == null || typeof value === "string";
function projection(condition) {
  if (!condition) throw Object.assign(new Error("Leads update unavailable"), { code: "invalid_projection" });
}
function validateLead(lead) {
  projection(object(lead) && text(lead.id) && Number.isSafeInteger(lead.base_version) && lead.base_version > 0 && text(lead.stage) && typeof lead.suppressed === "boolean");
  for (const key of ["registry_ref", "party_id", "doctor_name", "practice_name", "entity_name", "name", "owner", "city", "state", "market", "specialty", "vertical", "plan_type"]) projection(optionalText(lead[key]));
  for (const key of ["is_client", "linked_client", "is_past_client", "is_deal", "do_not_contact"]) projection(lead[key] == null || typeof lead[key] === "boolean");
  projection(lead.score == null || (["string", "number"].includes(typeof lead.score) && Number.isFinite(Number(lead.score))));
  projection(Array.isArray(lead.possible_clients) && lead.possible_clients.every(match => object(match) && text(match.client_id) && text(match.name)));
  projection(lead.last_stage_move == null || object(lead.last_stage_move));
  return lead;
}
export function validateLeadWorkspace(payload) {
  projection(object(payload) && payload.schema_version === "lead-workspace.v1" && Number.isFinite(Date.parse(payload.generated_at)) && Array.isArray(payload.leads));
  payload.leads.forEach(validateLead);
  projection(new Set(payload.leads.map(lead => lead.id)).size === payload.leads.length);
  return payload;
}
export function validateLeadDetail(detail, id) {
  validateLead(detail); projection(detail.id === id);
  for (const key of ["phone", "email", "notes", "plans", "est_lease_event"]) projection(optionalText(detail[key]));
  projection(Array.isArray(detail.correspondence) && detail.correspondence.every(entry => object(entry) && text(entry.id) && text(entry.kind) && Number.isFinite(Date.parse(entry.occurred_at)) && optionalText(entry.summary) && optionalText(entry.detail)));
  projection(Array.isArray(detail.stage_history) && detail.stage_history.every(entry => object(entry) && text(entry.event_id) && Number.isFinite(Date.parse(entry.occurred_at)) && optionalText(entry.prior_stage) && optionalText(entry.stage) && optionalText(entry.reason)));
  return detail;
}
