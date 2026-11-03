import { beginCommand, classifyCommandOutcome, commandMessage, settleCommand, stableText } from './command-feedback.mjs';
import { uuidv4 } from './uuid.js';

/** Retain one exact, session-bound request until its server outcome is known.
 * Callers validate successful domain receipts in sendRequest and return ok:true.
 * This is in-memory recovery: keep the tab open while an outcome is unknown. */
/** @typedef {{ request: object, method: string | undefined, sendRequest: Function } &
 * ({ status: 'pending', promise: Promise<unknown> } | { status: 'unknown' })} RetainedCommand */
export function createRetainedCommands({ newKey = uuidv4, scope = () => null } = {}) {
  /** @type {Record<string, RetainedCommand>} */
  let commands = {};
  const bindings = new Map();
  return {
    pending(operationKey) { return commands[operationKey]?.request || null; },
    details(operationKey) {
      const entry = commands[operationKey];
      return entry ? { method: entry.method, request: structuredClone(entry.request) } : null;
    },
    async send(operationKey, args, sendRequest, method) {
      let binding;
      try { binding = await scope(); } catch (error) {
        const prior = commands[operationKey];
        if (prior) Object.assign(error, { pendingRequest: prior.request, pendingMethod: prior.method });
        throw error;
      }
      const prior = commands[operationKey];
      if (prior && bindings.get(operationKey) !== binding) {
        throw Object.assign(new Error('Session changed. The original request must be reconciled in its original session.'), { code: 'session_changed' });
      }
      if (prior && method) {
        if (prior.method !== method || stableText(prior.request) !== stableText(args))
          throw Object.assign(new Error('Reconcile the original email action before continuing.'), { code: 'unresolved_command', pendingMethod: prior.method, pendingRequest: structuredClone(prior.request) });
        if (prior.status === 'pending') return prior.promise;
        sendRequest = prior.sendRequest;
      }
      const claim = beginCommand(commands, { operationKey,
        args: structuredClone(args), newKey: () => args.idempotency_key || newKey() });
      commands = claim.state;
      if (!claim.started) {
        throw Object.assign(new Error(commandMessage({ reason: claim.reason })), {
          code: claim.reason === 'in_flight' ? 'command_in_flight' : 'unresolved_command',
          pendingRequest: prior.request,
        });
      }
      bindings.set(operationKey, binding);
      const entry = commands[operationKey];
      entry.method = method;
      entry.sendRequest = sendRequest;
      entry.promise = (async () => {
        try {
          const response = await sendRequest(claim.request, binding);
          const outcome = classifyCommandOutcome({ response });
          if (outcome.status === 'unknown') throw Object.assign(new Error('Outcome unknown. Check outcome replays the original request.'), { code: 'unknown_outcome' });
          commands = settleCommand(commands, operationKey, outcome);
          if (!commands[operationKey]) bindings.delete(operationKey);
          return response;
        } catch (error) {
          const outcome = error.code === 'not_sent' && !claim.retry
            ? { status: 'refused', reason: 'cancelled' }
            // eslint-disable-next-line no-restricted-syntax -- Retained command error classification only; 0 automatic attempts, and any retry requires a fresh user action.
            : classifyCommandOutcome({ error, retry: claim.retry });
          commands = settleCommand(commands, operationKey, outcome);
          if (!commands[operationKey]) bindings.delete(operationKey);
          else Object.assign(error, { pendingRequest: claim.request, pendingMethod: method });
          throw error;
        }
      })();
      return entry.promise;
    },
  };
}
