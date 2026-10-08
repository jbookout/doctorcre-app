// Wraps an AI SDK language model so that every provider call is a charged
// model dispatch on the active RunBudget. Without an active budget the call
// refuses; with one, output tokens are clamped to the profile's cap and the
// call is aborted at the profile's hard per-call timeout. A profile with no
// model budget (the read-only Home smoke) refuses every call before the
// provider sees it.
//
// The SDK's own transport retries and the provider's OAuth token refresh run
// inside one wrapped call: retries arrive here as further charged calls, but a
// token refresh request is not counted as an HTTP request.
import { BudgetRefusal, activeBudget } from './run-budget.mjs';

const WRAPPED = new Set(['doGenerate', 'doStream']);

function limits(options = {}) {
  const budget = activeBudget();
  if (!budget) throw new BudgetRefusal('model-not-budgeted');
  const { modelOutputTokens, modelTimeoutMs } = budget.profile;
  const requested = Number.isSafeInteger(options.maxOutputTokens) && options.maxOutputTokens > 0 ? options.maxOutputTokens : modelOutputTokens;
  return { budget, maxOutputTokens: Math.min(requested, modelOutputTokens), timeoutMs: modelTimeoutMs };
}

async function call(target, method, options = {}) {
  const { budget, maxOutputTokens, timeoutMs } = limits(options);
  return budget.dispatch('model', async signal => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new BudgetRefusal('model-timeout')), timeoutMs);
    timer.unref?.();
    const timedOut = new Promise((_, reject) => deadline.signal.addEventListener('abort', () => reject(new BudgetRefusal('model-timeout')), { once: true }));
    timedOut.catch(() => {});
    const abortSignal = AbortSignal.any([signal, deadline.signal, ...(options.abortSignal ? [options.abortSignal] : [])]);
    let keepTimer = false;
    try {
      const result = await Promise.race([target[method]({ ...options, maxOutputTokens, abortSignal }), timedOut]);
      if (method === 'doStream' && result?.stream) {
        // The hard timeout covers the whole stream, not only its first byte.
        keepTimer = true;
        const finish = () => clearTimeout(timer);
        const guarded = result.stream.pipeThrough(new TransformStream({ flush: finish }));
        deadline.signal.addEventListener('abort', finish, { once: true });
        return { ...result, stream: guarded };
      }
      return result;
    } finally { if (!keepTimer) clearTimeout(timer); }
  });
}

export function budgetedModel(inner) {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (WRAPPED.has(property)) return options => call(target, property, options);
      return Reflect.get(target, property, receiver);
    },
  });
}
