import { observeDocClient } from './doc-context.js';
import { createMcpRequests, unknownMcpOutcome } from "./mcp-requests.mjs";

/** A deliberately small MCP client for Home reads and the versioned Leads workspace.
 * Authentication remains the host's
 * same-origin cookie; there is no client-side identity or alternate endpoint. */
export function createLeadBoardClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((path, init) => fetch(path, init));
  const requestMcp = createMcpRequests({ fetchImpl, headers: { accept: "application/json" } });

  function typedError(payload, fallback = "The lead board request was refused.", status) {
    const error = new Error(payload?.message || payload?.hint || fallback);
    error.code = payload?.error || payload?.code || "tool_error";
    error.payload = payload || {};
    if (status) error.status = status;
    return error;
  }

  async function rpc(name, args = {}, mutation = false, { signal } = {}) {
    const outcome = await requestMcp(name, args, { signal, timeoutMs: options.timeoutMs || 10_000 });
    if (outcome.kind === "authorization") {
      throw typedError({ error: outcome.status === 401 ? "not_authenticated" : "forbidden" }, "Sign-in required", outcome.status);
    }
    if (outcome.kind === "unconfirmed") {
      if (mutation) throw unknownMcpOutcome(outcome.cause || outcome.payload);
      switch (outcome.reason) {
        case "deadline": throw outcome.cause;
        case "network": throw Object.assign(new Error("The Lead Board could not reach the server."), { code: "network_error", cause: outcome.cause });
        case "envelope": throw typedError(null, "The Lead Board returned an unreadable response.", outcome.status);
        case "http": case "rpc": throw typedError(outcome.reason === "rpc" ? outcome.cause : outcome.payload?.error || outcome.payload, `The Lead Board request failed (${outcome.status}).`, outcome.status);
        case "content": throw typedError(null, "The Lead Board returned malformed content.");
        case "missing": throw typedError(null, "The Lead Board returned an incomplete response.");
        case "payload": throw Object.assign(typedError(null, "The Lead Board returned an unreadable response. The result may be unknown."), { code: "unreadable_response" });
      }
    }
    const { payload, isError } = outcome;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw mutation ? unknownMcpOutcome(payload) : typedError(null, "The Lead Board returned an incomplete response.");
    if (isError || payload.error || payload.ok === false) {
      if (payload.error === "carr_unavailable") throw unknownMcpOutcome(payload);
      throw typedError(payload);
    }
    if (mutation && payload.ok !== true) throw unknownMcpOutcome(payload);
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
