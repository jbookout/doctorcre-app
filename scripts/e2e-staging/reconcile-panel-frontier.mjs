import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalIdentity, validateTraversal, traversalSnapshot } from './traversal.mjs';
import { sweepFindings } from './report.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = row => canonicalIdentity(row.identity);
const requireProof = value => assert.ok(value, 'Recorded panel reconciliation proof refused; checkpoint was not changed');
const legacyContext = row => {
  requireProof(typeof row.identity === 'string' && !row.identity.startsWith('control-state.v1:'));
  const [encoded, url] = row.identity.split('|');
  let context;
  try { context = JSON.parse(encoded); } catch { requireProof(false); }
  requireProof(Array.isArray(context) && context.length === 4 && typeof url === 'string');
  return {
    owner: context[0], controls: context[1], views: context[2],
    panels: context[3].map(([selector, label]) => ({ selector, label_sha256: digest(label) })),
    url,
  };
};
const actionFields = ['selector', 'name', 'role', 'inputType', 'optionValue', 'href', 'disabled'];
const sameAction = (a, b) => actionFields.every(field => same(a[field], b[field]));

// This is an explicit, offline reconciliation of one legacy record-panel
// frontier after a recorded next-step write. It never executes a control,
// writes a checkpoint, or relaxes the live traversal identity guard.
export function reconcileRecordedPanelFrontier({ prior, observation, newAttemptID }) {
  requireProof(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(newAttemptID || ''));
  requireProof(prior?.release?.service === 'doctorcre-app' && prior.release.environment === 'staging' && Array.isArray(prior.screens));
  requireProof(observation?.context && Array.isArray(observation.added_context_controls));
  requireProof(observation.failed_control_pressed === false && observation.blocked_non_read_requests === 0);
  requireProof(['service', 'environment', 'source_commit', 'carr_source_commit'].every(field =>
    prior.release[field] === observation.release[field]));
  const original = prior.screens.find(screen => screen.target === 'staging-live' && screen.path === '/');
  requireProof(original?.attempt_id && original.attempt_id !== newAttemptID);
  requireProof(!(prior.history || []).some(entry => [original.attempt_id, newAttemptID].includes(entry.screen.attempt_id)));
  const frontier = validateTraversal(original);
  requireProof(!frontier.pending_discovery && frontier.active?.controls);
  requireProof(original.failure?.phase === 'frontier-validation' && original.failure.code === 'control-state-changed');
  const failed = original.controls.at(-1);
  requireProof(failed?.status === 'UNREACHABLE' && !failed.evidence_path && failed.role === 'button' && failed.name === 'Deal outlook');
  const expected = legacyContext(failed), observed = observation.context;
  const expectedURL = new URL(expected.url, 'https://staging.invalid');
  requireProof(expected.owner === '#recordPanel' && expectedURL.pathname === '/deals' && expectedURL.searchParams.has('deal'));
  requireProof(Array.isArray(expected.controls) && Array.isArray(observed.local_controls));
  requireProof(observed.owner === expected.owner && same(observed.workspace_views, expected.views) && same(observed.panels, expected.panels));
  requireProof(same(observed.local_controls.filter(selector => expected.controls.includes(selector)), expected.controls));
  const added = observed.local_controls.filter(selector => !expected.controls.includes(selector));
  requireProof(added.length === 1 && observation.added_context_controls.length === 1);
  const addition = observation.added_context_controls[0];
  requireProof(addition.selector === added[0] && addition.data.length === 1 &&
    addition.data[0].is_timeline_day === true && addition.data[0].detail_focus_is_day === true &&
    /^\d{4}-\d\d-\d\d$/.test(addition.data[0].timeline_day || ''));

  const live = observation.controls;
  requireProof(Array.isArray(live) && new Set(live.map(identity)).size === live.length);
  const matching = row => {
    const matches = live.filter(current => sameAction(row, current));
    requireProof(matches.length === 1);
    requireProof(matches[0].state_url === legacyContext(row).url);
    return matches[0];
  };
  const currentFailed = matching(failed);
  requireProof(identity(currentFailed) !== identity(failed));
  const successorStates = frontier.queue.filter(state => {
    if (state.openers.length !== frontier.active.openers.length + 1 ||
        !same(state.openers.slice(0, -1), frontier.active.openers)) return false;
    const last = state.openers.at(-1);
    return last.name === 'Save next step' && last.role === 'button' &&
      original.controls.some(row => identity(row) === identity(last) && row.status === 'OBSERVED' && row.evidence_path);
  });
  requireProof(successorStates.length === 1);
  const successor = successorStates[0], liveIDs = new Set(live.map(identity));
  requireProof(successor.controls.every(row => liveIDs.has(identity(row))));
  const successorIDs = new Set(successor.controls.map(identity));
  requireProof(successorIDs.has(identity(currentFailed)));
  const retainedActive = [], mappings = [{
    old_identity: identity(failed), successor_identity: identity(currentFailed),
    prior_status: 'UNREACHABLE', successor_status: 'unmeasured',
  }];
  for (const row of frontier.active.controls) {
    if (liveIDs.has(identity(row))) { retainedActive.push(row); continue; }
    const old = legacyContext(row);
    requireProof(old.owner === expected.owner && old.url === expected.url &&
      same(old.controls, expected.controls) && same(old.views, expected.views) && same(old.panels, expected.panels));
    const current = matching(row);
    requireProof(successorIDs.has(identity(current)));
    mappings.push({ old_identity: identity(row), successor_identity: identity(current), prior_status: 'unmeasured', successor_status: 'unmeasured' });
  }

  const checkpoint = structuredClone(prior);
  const home = checkpoint.screens.find(screen => screen.target === 'staging-live' && screen.path === '/');
  home.controls.pop();
  home.failure = null;
  home.attempt_id = newAttemptID;
  const queue = structuredClone(frontier.queue);
  const index = frontier.queue.indexOf(successor);
  const oldOpeners = queue[index].openers;
  queue[index].openers = structuredClone(frontier.active.openers);
  home.traversal = traversalSnapshot({
    queue, destructive: frontier.destructive,
    active: retainedActive.length ? { ...frontier.active, controls: retainedActive } : null,
    pending: null, seen: new Set(frontier.seen.filter(value => canonicalIdentity(value) !== identity(failed))),
  });
  validateTraversal(home);
  const reconciliation = {
    schema: 'recorded-panel-frontier-reconciliation.v1',
    prior_attempt: original.attempt_id, continuation_attempt: newAttemptID,
    preserved_measured_prefix: home.controls.length,
    preserved_failed_observation_key: failed.key,
    previous_remaining: frontier.known_remaining, remaining: home.traversal.known_remaining,
    mappings, unchanged_active: retainedActive.map(identity),
    queued_successor_controls: successor.controls.length,
    removed_replay_opener: identity(oldOpeners.at(-1)),
    retained_read_openers: queue[index].openers.map(identity),
    read_observation_sha256: digest(JSON.stringify(observation)),
    original_state_complete: false, failed_control_executed: false,
  };
  checkpoint.history = [...(checkpoint.history || []), {
    screen: structuredClone(original), findings: sweepFindings([original]), reconciliation,
  }];
  requireProof(same(home.controls, original.controls.slice(0, -1)));
  requireProof(same(checkpoint.stateObligations, prior.stateObligations));
  return { checkpoint, reconciliation };
}
