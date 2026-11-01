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
        const response = await sendRequest(claim.request, binding);
        const outcome = classifyCommandOutcome({ response });
        if (outcome.status === 'unknown') throw Object.assign(new Error('Outcome unknown. Check outcome replays the original request.'), { code: 'unknown_outcome' });
        commands = settleCommand(commands, operationKey, outcome);
        if (!commands[operationKey]) bindings.delete(operationKey);
        return response;
      } catch (error) {
        const outcome = error.code === 'not_sent' && !claim.retry
          ? { status: 'refused', reason: 'cancelled' }
          // eslint-disable-next-line no-restricted-syntax -- Retained command error classification only; zero automatic attempts, and any retry requires a fresh user action.
          : classifyCommandOutcome({ error, retry: claim.retry });
        commands = settleCommand(commands, operationKey, outcome);
        if (!commands[operationKey]) bindings.delete(operationKey);
        else error.pendingRequest = claim.request;
        throw error;
      }
    },
  };
}
