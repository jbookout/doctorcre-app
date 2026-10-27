import { sessionFetch } from './private-session.js';
import { observeDocRead } from './doc-context.js';
import { uuidv4 } from "./uuid.js";
import { isHumanRef, validateHumanRef } from "./system-work-view.js";
import { readWithDeadline } from "./auto-refresh.mjs";
import { createRetainedCommands } from './retained-commands.mjs';

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCollection = (data) => isRecord(data) && Array.isArray(data.items) && data.items.every(item =>
  isRecord(item) && isHumanRef(item.human_ref) && typeof item.title === "string" && typeof item.state === "string");
const isCard = (data, ref) => isRecord(data) && data.human_ref === ref && typeof data.title === "string" &&
  typeof data.state === "string" && Number.isSafeInteger(data.version) && data.version >= 1;

export function createSystemWorkClient(options = {}) {
  const fetchImpl = options.fetchImpl || ((path, init) => sessionFetch(path, init));
  const uuid = options.uuid || uuidv4;
  let session = null;
  let pendingReport = null;
  const actions = createRetainedCommands({ newKey: uuid,
    scope: () => session ? `${session.actor?.slug}:${session.csrf_token}` : null });

  async function decode(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.hint || body.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = body.error || "request_failed";
      error.payload = body;
      throw error;
    }
    return body;
  }

  // A 200 counts only when its envelope is the one CARR sends; anything else is
  // an unavailable read, never an empty queue or a current card.
  async function decodeRead(response, valid) {
    if (!response.ok) return decode(response);
    const envelope = await response.json().catch(() => null);
    if (envelope?.ok !== true || !valid(envelope.data))
      throw Object.assign(new Error("Work Requests sent an unreadable response."), { code: "malformed_response" });
    return envelope.data;
  }

  async function bootstrap() {
    session = await decode(await fetchImpl("/api/system-work/session", {
      credentials: "same-origin", headers: { accept: "application/json" },
    }));
    return session;
  }

  function headers(challenge) {
    if (!session?.csrf_token) throw new Error("System work session is not ready.");
    return { "content-type": "application/json", accept: "application/json",
      "x-carr-csrf": session.csrf_token,
      ...(challenge ? { "x-carr-action-challenge": challenge } : {}) };
  }

  async function post(path, body, challenge) {
    return readWithDeadline(async signal => {
      const response = await fetchImpl(path, { method: "POST", signal, credentials: "same-origin",
        headers: headers(challenge), body: JSON.stringify(body) });
      const envelope = await decode(response);
      const data = envelope?.data ?? envelope;
      const confirmed = envelope?.ok === true || data?.ok === true ||
        (path.endsWith('/challenge') && typeof data?.challenge === 'string' && data.challenge) ||
        (path.endsWith('/report') && isHumanRef(data?.human_ref));
      if (!confirmed) throw new Error('Write outcome unknown. The server did not return a valid receipt.');
      return data;
    }, { timeoutMs: options.writeTimeoutMs || 15_000 });
  }

  async function challenge(action, material) {
    return post("/api/system-work/challenge", { action, ...material });
  }

  const withKey = (body) => ({ ...body, idempotency_key: body.idempotency_key || uuid() });

  const actionPaths = { triage: 'triage', preparePlan: 'plan', acceptPlan: 'plan/accept',
    proposeOutcome: 'outcomes', acceptOutcome: 'outcomes/accept' };
  async function mutate(method, humanRef, body) {
    const ref = validateHumanRef(humanRef);
    return actions.send(ref, { ...body, action: method }, async retained => {
      const { action, ...requestBody } = retained;
      let confirmation;
      if (action === 'acceptPlan' || action === 'acceptOutcome') {
        const hash = action === 'acceptPlan' ? 'plan_hash' : 'feedback_hash';
        const receipt = await challenge(action === 'acceptPlan' ? 'accept-ready-plan' : 'accept-outcome-feedback', {
          human_ref: ref, base_version: requestBody.base_version,
          [hash]: requestBody[hash], idempotency_key: requestBody.idempotency_key,
        });
        confirmation = receipt.challenge;
      }
      const result = await post(`/api/system-work/${ref}/${actionPaths[action]}`, requestBody, confirmation);
      if (result?.ok === false || result?.error) throw Object.assign(new Error(result.message || 'Request refused'), { payload: result });
      return { ok: true, data: result };
    }).then(result => result.data);
  }

  return {
    get session() { return session; },
    get pendingReport() { return pendingReport ? JSON.parse(JSON.stringify(pendingReport.request)) : null; },
    pendingAction(humanRef) {
      const retained = actions.pending(validateHumanRef(humanRef));
      if (!retained) return null;
      const { action, ...request } = retained;
      return { method: action, request };
    },
    reconcileAction(humanRef) {
      const pending = this.pendingAction(humanRef);
      if (!pending) throw new Error('No unresolved action for this Work Request.');
      return mutate(pending.method, humanRef, pending.request);
    },
    bootstrap,
    async current() {
      return observeDocRead('systemCurrent', [], () => readWithDeadline(async signal => {
        const response = await fetchImpl("/api/system-work/current", {
          signal,
          credentials: "same-origin", headers: { accept: "application/json" },
        });
        return decodeRead(response, isCollection);
      }, { timeoutMs: options.readTimeoutMs || 10_000 }));
    },
    async read(humanRef) {
      const ref = validateHumanRef(humanRef);
      return observeDocRead('systemRecord', [ref], () => readWithDeadline(async signal => {
        const response = await fetchImpl(`/api/system-work/${encodeURIComponent(ref)}`, {
          signal,
          credentials: "same-origin", headers: { accept: "application/json" },
        });
        return decodeRead(response, card => isCard(card, ref));
      }, { timeoutMs: options.readTimeoutMs || 10_000 }));
    },
    async report(body) {
      const { idempotency_key, ...intent } = body;
      const signature = JSON.stringify(intent);
      if (pendingReport && pendingReport.signature !== signature)
        throw new Error("Reconcile the previous report before submitting a different concern.");
      const binding = `${session?.actor?.slug}:${session?.csrf_token}`;
      if (pendingReport && pendingReport.binding !== binding) throw new Error('Session changed. Reconcile this report in its original session.');
      pendingReport ||= { signature, binding, request: structuredClone(withKey(body)), uncertain: false };
      try { return await post("/api/system-work/report", pendingReport.request); }
      catch (error) {
        if (error.status >= 400 && error.status < 500 && ![408,429].includes(error.status) &&
          !(pendingReport.uncertain && [401,403].includes(error.status)) && typeof error.payload?.error === "string" && error.payload.error) pendingReport = null;
        else pendingReport.uncertain = true;
        throw error;
      }
    },
    finishReport() { pendingReport = null; },
    triage: (humanRef, body) => mutate('triage', humanRef, body),
    preparePlan: (humanRef, body) => mutate('preparePlan', humanRef, body),
    acceptPlan: (humanRef, body) => mutate('acceptPlan', humanRef, body),
    proposeOutcome: (humanRef, body) => mutate('proposeOutcome', humanRef, body),
    acceptOutcome: (humanRef, body) => mutate('acceptOutcome', humanRef, body),
  };
}
