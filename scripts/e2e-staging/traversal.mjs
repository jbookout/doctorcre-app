import { createHash } from 'node:crypto';

const requireFrontier = value => { if (!value) throw new Error('Staging traversal checkpoint is invalid; no control was replayed'); };
const control = row => row && typeof row === 'object' && typeof row.identity === 'string' && row.identity && typeof row.selector === 'string' && row.selector && typeof row.role === 'string' && typeof row.name === 'string';

export function validateTraversal(screen) {
  const frontier = screen.traversal;
  requireFrontier(screen.in_progress === true);
  requireFrontier(frontier && frontier.schema === 'control-frontier.v1' && Array.isArray(frontier.seen) && Array.isArray(frontier.queue) && Array.isArray(frontier.destructive));
  const seen = new Set(frontier.seen);
  requireFrontier(seen.size === frontier.seen.length && seen.size === screen.controls.length);
  const measured = new Map();
  for (const row of screen.controls) {
    requireFrontier(control(row) && seen.has(row.identity));
    requireFrontier(row.key === screen.target + '/' + screen.path + '/' + createHash('sha256').update(row.identity).digest('hex').slice(0, 16));
    measured.set(row.identity, row);
  }
  const scheduled = new Set();
  const validateMeasuredAction = opener => {
    const row = measured.get(opener?.identity);
    requireFrontier(control(opener) && row?.status === 'OBSERVED');
    for (const key of ['identity', 'selector', 'role', 'name', 'inputType', 'optionValue', 'disabled', 'href'])
      requireFrontier(JSON.stringify(opener[key]) === JSON.stringify(row[key]));
  };
  const validateOpeners = openers => {
    requireFrontier(Array.isArray(openers));
    for (const opener of openers) validateMeasuredAction(opener);
  };
  const validateState = state => {
    requireFrontier(state && typeof state === 'object');
    validateOpeners(state.openers);
    requireFrontier(state.destructive === undefined || typeof state.destructive === 'boolean');
    requireFrontier(state.controls === null || Array.isArray(state.controls));
    if (state.controls === null) requireFrontier(screen.controls.length === 0 && state.openers.length === 0);
    for (const row of state.controls || []) {
      requireFrontier(control(row) && !seen.has(row.identity) && !scheduled.has(row.identity));
      scheduled.add(row.identity);
    }
  };
  if (frontier.active) validateState(frontier.active);
  for (const state of [...frontier.queue, ...frontier.destructive]) validateState(state);
  if (frontier.pending_discovery) {
    const pending = frontier.pending_discovery;
    validateOpeners(pending.openers);
    validateMeasuredAction(pending.control);
    requireFrontier(screen.controls.at(-1)?.identity === pending.control.identity);
  }
  requireFrontier(frontier.known_remaining === scheduled.size);
  const states = [frontier.active, ...frontier.queue, ...frontier.destructive].filter(Boolean);
  const maxDepth = Math.max(0, ...states.map(state => state.openers.length), frontier.pending_discovery ? frontier.pending_discovery.openers.length + 1 : 0);
  requireFrontier(frontier.max_opener_depth === maxDepth);
  return frontier;
}

export function canContinueTraversal(screen) {
  if (!screen?.traversal) return false;
  validateTraversal(screen);
  return screen.in_progress === true && !screen.exhausted && screen.controls.every(row => !['ERROR', 'UNREACHABLE'].includes(row.status));
}

export function traversalSnapshot({ queue, destructive, active, pending, seen }) {
  const scheduled = new Set();
  const validateMeasuredAction = opener => {
    const row = measured.get(opener?.identity);
    requireFrontier(control(opener) && row?.status === 'OBSERVED');
    for (const key of ['identity', 'selector', 'role', 'name', 'inputType', 'optionValue', 'disabled', 'href'])
      requireFrontier(JSON.stringify(opener[key]) === JSON.stringify(row[key]));
  };
  const copyState = state => {
    if (!state) return null;
    const copy = structuredClone(state);
    if (copy.controls) copy.controls = copy.controls.filter(row => !seen.has(row.identity) && !scheduled.has(row.identity) && scheduled.add(row.identity));
    return copy.controls && !copy.controls.length ? null : copy;
  };
  const current = copyState(active), queued = queue.map(copyState).filter(Boolean), deferred = destructive.map(copyState).filter(Boolean);
  const entries = [current, ...queued, ...deferred].filter(Boolean);
  return { schema: 'control-frontier.v1', seen: [...seen], active: current, queue: queued, destructive: deferred,
    pending_discovery: pending ? structuredClone(pending) : null, known_remaining: scheduled.size,
    max_opener_depth: Math.max(0, ...entries.map(state => state.openers.length), pending ? pending.openers.length + 1 : 0) };
}

