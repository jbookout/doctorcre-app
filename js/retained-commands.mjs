import { beginCommand, classifyCommandOutcome, commandMessage, settleCommand } from './command-feedback.mjs';
import { uuidv4 } from './uuid.js';

/** Retain one exact, session-bound request until its server outcome is known.
 * Callers validate successful domain receipts in sendRequest and return ok:true.
 * This is in-memory recovery: keep the tab open while an outcome is unknown. */
export function createRetainedCommands({ newKey = uuidv4, scope = () => null } = {}) {
  let commands = {};
  const bindings = new Map();
  return {
    pending(operationKey) { return commands[operationKey]?.request || null; },
    async send(operationKey, args, sendRequest) {
      const binding = await scope();
      const prior = commands[operationKey];
      if (prior && bindings.get(operationKey) !== binding) {
        throw Object.assign(new Error('Session changed. The original request must be reconciled in its original session.'), { code: 'session_changed' });
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
      try {
        const response = await sendRequest(claim.request);
        const outcome = classifyCommandOutcome({ response });
        if (outcome.status === 'unknown') throw Object.assign(new Error('Outcome unknown. Check outcome replays the original request.'), { code: 'unknown_outcome' });
        commands = settleCommand(commands, operationKey, outcome);
        if (!commands[operationKey]) bindings.delete(operationKey);
        return response;
      } catch (error) {
        let outcome = classifyCommandOutcome({ error });
        // HTTP gateway failures are not authoritative business refusals, even
        // when their body happens to contain an error code. A later auth
        // failure also cannot disprove the original uncertain write.
        if (error?.status >= 500 || error?.status === 408 || error?.status === 429 ||
          ['carr_unavailable', 'wire_unavailable'].includes(error?.payload?.error) ||
          (claim.retry && [401, 403].includes(error?.status))) outcome = { status: 'unknown', reason: 'server_error' };
        commands = settleCommand(commands, operationKey, outcome);
        if (!commands[operationKey]) bindings.delete(operationKey);
        else error.pendingRequest = claim.request;
        throw error;
      }
    },
  };
}
