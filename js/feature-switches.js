import { mountAutoRefresh, readWithDeadline } from './auto-refresh.mjs';

export function featureEnabled(payload, name) {
  return payload?.schema === 'feature-switches.v1'
    && Array.isArray(payload.switches) && payload.switches.some(row => row.name === name && row.available === true) === true;
}

export const SUGGESTION_ACTIONS_OFF = 'Dr. CRE suggestion actions are switched off. Nothing was sent; try again once they are back on.';

// CARR checks the switch before the verb's handler runs, so this refusal is a
// settled non-write: nothing was recorded and a fresh attempt may follow once
// the switch is back on.
export const FEATURE_DISABLED = 'feature_disabled';
export const featureSwitchRefusal = error => error?.payload?.error === FEATURE_DISABLED;

export function mountFeatureGate({ document, window, name, read, onChange }) {
  let disposed=false;
  onChange(false);
  const auto=mountAutoRefresh({document,window,intervalMs:30_000,onResume:()=>onChange(false),
    refresh:async ({signal}={})=>{
      let enabled=false;
      try { enabled=featureEnabled(await readWithDeadline(read,{signal,timeoutMs:10_000}),name); }
      catch { /* A failed read leaves the feature hidden until a fresh read succeeds. */ }
      if(!disposed && !signal?.aborted)onChange(enabled);
    },
  });
  auto.refresh();
  return {refresh:auto.refresh,dispose(){disposed=true;auto.dispose();}};
}
