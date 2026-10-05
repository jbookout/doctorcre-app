import { mountAutoRefresh, readWithDeadline } from './auto-refresh.mjs';

export function featureEnabled(payload, name) {
  return payload?.schema === 'feature-switches.v1'
    && Array.isArray(payload.switches) && payload.switches.some(row => row.name === name && row.available === true) === true;
}

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
