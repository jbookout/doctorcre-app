import { declaredStates, validateStateSpec, calendarCases } from './state-plan.mjs';
import { canContinueTraversal, canonicalIdentity, identityKey } from './traversal.mjs';

const requireState = value => { if (!value) throw new Error('Staging state obligation is invalid; no destination coverage was credited'); };
const copy = value => structuredClone(value);
const statuses = new Set(['pending', 'passed', 'failed']);
export function createStateLedger({ targets, routedScreens, prior = [], validateScreen, complete, finished = complete, attemptID }) {
  requireState(Array.isArray(prior));
  const plan = new Map(targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface).map(screen => [target.name + '|' + screen.path, { target, screen }])));
  const entries = new Map();
  const ownerFor = (sourceTarget, spec) => {
    const source = targets.find(target => target.name === sourceTarget);
    requireState(source && validateStateSpec(spec));
    const direct = plan.get(sourceTarget + '|' + spec.owner);
    if (direct) return direct.target.name;
    // A source press belongs to its source surface. Its destination executes
    // on the owning surface at the identical viewport, never on the source.
    const candidates = [...plan.values()].filter(({ target, screen }) =>
      screen.path === spec.owner && JSON.stringify(target.viewport || null) === JSON.stringify(source.viewport || null));
    requireState(candidates.length === 1);
    return candidates[0].target.name;
  };
  const keyFor = (target, spec) => 'state/' + target + spec.owner + '/' + spec.id;
  const validate = entry => {
    const owner = plan.get(entry?.target + '|' + entry?.spec?.owner);
    requireState(owner && validateStateSpec(entry.spec) && entry.key === keyFor(entry.target, entry.spec));
    requireState(JSON.stringify(entry.viewport) === JSON.stringify(owner.target.viewport || null) && statuses.has(entry.status) && Array.isArray(entry.sources));
    requireState(entry.history === undefined || Array.isArray(entry.history));
    for (const old of entry.history || []) {
      requireState(old && typeof old.attempt_id === 'string' && old.result && old.attempt_id !== entry.attempt_id);
      if (entry.spec.kind === 'calendar-operation') requireState(['failed', 'SKIPPED'].includes(old.result.status) && JSON.stringify(old.result.spec) === JSON.stringify(entry.spec));
      else { validateScreen(old.result); requireState(old.result.state_scope === entry.key && old.result.target === entry.target && old.result.path === entry.spec.owner && !complete(old.result)); }
    }
    for (const source of entry.sources) {
      requireState(source && typeof source.kind === 'string');
      if (source.kind === 'control') {
        requireState(plan.has(source.target + '|' + source.path) && ownerFor(source.target, entry.spec) === entry.target && typeof source.identity === 'string');
        requireState(source.key === source.target + '/' + source.path + '/' + identityKey(source.identity));
        requireState(Array.isArray(source.openers) && typeof source.observed_destination === 'string' && typeof source.evidence_path === 'string' && source.evidence_path);
      } else requireState(source.kind === 'calendar-read' && source.target === entry.target && source.path === '/calendar' && source.entry_binding === entry.spec.entry_binding && entry.spec.kind === 'calendar-record' && typeof source.evidence_path === 'string' && source.evidence_path);
    }
    if (entry.result) {
      requireState(typeof entry.attempt_id === 'string');
      if (entry.spec.kind === 'calendar-operation') {
        requireState(entry.result.spec && JSON.stringify(entry.result.spec) === JSON.stringify(entry.spec) && ['passed', 'failed', 'SKIPPED'].includes(entry.result.status));
        if (entry.result.status === 'SKIPPED') requireState(entry.result.reason && entry.result.execution?.press_attempted === false && entry.result.execution.handler_executions === 0);
        if (entry.result.status === 'failed') requireState(entry.result.failure && /^[a-z][a-z0-9-]*$/.test(entry.result.failure.code || ''));
        if (entry.result.status === 'passed') {
          const declared = calendarCases.find(row => row.id === entry.spec.case);
          requireState(entry.result.assertions && JSON.stringify(entry.result.steps) === JSON.stringify(declared.steps) && typeof entry.result.evidence_path === 'string' && entry.result.evidence_path);
        }
      } else {
        validateScreen(entry.result);
        requireState(entry.result.target === entry.target && entry.result.path === entry.spec.owner && entry.result.state_scope === entry.key);
      }
    }
    requireState(entry.status !== 'passed' || entry.result && (entry.spec.kind === 'calendar-operation' ? entry.result.status === 'passed' : complete(entry.result)));
  };
  for (const entry of prior) { validate(entry); requireState(!entries.has(entry.key)); entries.set(entry.key, copy(entry)); }
  const register = (sourceTarget, spec, source) => {
    const target = ownerFor(sourceTarget, spec);
    const key = keyFor(target, spec), owner = plan.get(target + '|' + spec.owner);
    requireState(owner && validateStateSpec(spec));
    let entry = entries.get(key);
    if (!entry) { entry = { key, target, spec: copy(spec), viewport: copy(owner.target.viewport || null), status: 'pending', sources: [] }; entries.set(key, entry); }
    requireState(JSON.stringify(entry.spec) === JSON.stringify(spec));
    if (source) {
      const binding = canonicalIdentity(JSON.stringify(source));
      if (!entry.sources.some(old => canonicalIdentity(JSON.stringify(old)) === binding)) entry.sources.push(copy(source));
    }
    validate(entry);
    return key;
  };
  for (const { target, screen } of plan.values()) for (const spec of declaredStates([screen.path])) register(target.name, spec);
  return {
    register,
    collect(screen, stateKey) {
      for (const delegation of screen.delegations || []) {
        const row = screen.controls.find(row => row.key === delegation.source_key);
        requireState(row?.status === 'OBSERVED' && delegation.before && typeof delegation.after === 'string' && Array.isArray(delegation.states));
        const source = { kind: 'control', target: screen.target, path: screen.path, key: row.key, identity: row.identity, openers: copy(row.openers), observed_destination: delegation.after, evidence_path: row.evidence_path, ...(stateKey ? { state_scope: stateKey } : {}) };
        for (const spec of delegation.states) register(screen.target, spec, source);
      }
    },
    pending() { return [...entries.values()].filter(entry => entry.status !== 'passed').map(copy); },
    snapshot() { return [...entries.values()].map(copy); },
    record(key, result) {
      const entry = entries.get(key); requireState(entry && entry.status !== 'passed');
      if (entry.result && entry.spec.kind !== 'calendar-operation' && canContinueTraversal(entry.result)) {
        requireState(result.controls.length >= entry.result.controls.length && JSON.stringify(result.controls.slice(0, entry.result.controls.length)) === JSON.stringify(entry.result.controls));
      } else if (entry.result && entry.attempt_id !== attemptID) entry.history = [...(entry.history || []), { attempt_id: entry.attempt_id, result: copy(entry.result) }];
      if (!entry.result || entry.spec.kind === 'calendar-operation' || !canContinueTraversal(entry.result)) entry.attempt_id = attemptID;
      entry.result = copy(result);
      entry.status = entry.spec.kind === 'calendar-operation' ? (result.status === 'SKIPPED' ? 'pending' : result.status) : complete(result) ? 'passed' : 'pending';
      validate(entry);
      if (entry.spec.kind !== 'calendar-operation') this.collect(result, key);
    },
    validateSources(baseScreens) {
      const measured = [...baseScreens, ...[...entries.values()].flatMap(entry => [entry.result, ...(entry.history || []).map(old => old.result)]).filter(Boolean)];
      for (const entry of entries.values()) for (const source of entry.sources.filter(row => row.kind === 'control')) {
        requireState(measured.some(screen => screen.target === source.target && screen.path === source.path && (screen.state_scope || null) === (source.state_scope || null) &&
          screen.controls?.some(row => row.key === source.key && row.status === 'OBSERVED' && canonicalIdentity(row.identity) === canonicalIdentity(source.identity) && row.evidence_path === source.evidence_path && JSON.stringify(row.openers) === JSON.stringify(source.openers)) &&
          screen.delegations?.some(item => item.source_key === source.key && item.after === source.observed_destination && item.states.some(spec => JSON.stringify(spec) === JSON.stringify(entry.spec)))));
      }
    },
    finished() { return [...entries.values()].every(entry => entry.result && (entry.spec.kind === 'calendar-operation' ? ['passed', 'SKIPPED'].includes(entry.result.status) : finished(entry.result))); },
    completed() { return [...entries.values()].every(entry => entry.status === 'passed'); },
  };
}
