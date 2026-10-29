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

// One gate per page and switch: every consumer on a page shares its poll and
// its answer, so two controls on one page never disagree.
const gates = new WeakMap();

export function mountFeatureGate({ document, window, name, read, onChange }) {
  let byName = gates.get(document);
  if (!byName) gates.set(document, byName = new Map());
  let gate = byName.get(name);
  if (!gate) byName.set(name, gate = createGate({ document, window, name, read, drop: () => byName.delete(name) }));
  return gate.subscribe(onChange);
}

function createGate({ document, window, name, read, drop }) {
  const listeners = new Set();
  let enabled = false, epoch = 0, accepted = -1, disposed = false;
  const set = value => { enabled = value; for (const listener of [...listeners]) listener(value); };
  const auto = mountAutoRefresh({ document, window, onResume: () => { ++epoch; set(false); },
    refresh: async ({ signal } = {}) => {
      const started = epoch;
      let next = false;
      try { next = featureEnabled(await readWithDeadline(read, { signal, timeoutMs: 10_000 }), name); }
      catch { /* A failed read leaves the feature hidden until a fresh read succeeds. */ }
      if (disposed || signal?.aborted || started !== epoch) return;
      accepted = started; set(next);
    },
  });
  // CARR's refusal is newer than any answer in flight: hide at once, discard a
  // read that started before it, and confirm with one that starts after.
  const refused = async () => {
    const after = ++epoch; set(false);
    await auto.refresh();
    if (accepted !== after) await auto.refresh();
  };
  return {
    subscribe(listener) {
      listeners.add(listener); listener(enabled);
      if (listeners.size === 1) auto.refresh();
      return { refresh: auto.refresh, refused, dispose() {
        if (!listeners.delete(listener) || listeners.size) return;
        disposed = true; auto.dispose(); drop();
      } };
    },
  };
}
