import assert from 'node:assert/strict';
import test from 'node:test';
import { completionContract, explorationCoverage } from '../../scripts/e2e-staging/completion-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const targets = [{ name: 'desktop', surface: 'app' }, { name: 'phone', surface: 'app' }];
const routedScreens = Array.from({ length: 30 }, (_, index) => ({ name: `Workspace ${index}`, path: `/workspace${index}`, surface: 'app' }));
const goalRows = () => targets.flatMap(target => routedScreens.flatMap(screen =>
  (target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux']).map(agent => ({
    target: target.name, screen: screen.name, path: screen.path, agent, status: 'finished', steps: 8,
    evidence: `/staging/output/evidence/explore/${target.name}-${screen.path.replaceAll('/', '_')}-${agent}`,
  }))));
const setup = () => ({
  schema: 'doctorcre-staging-records.v1', release, complete: true, eligibleLead: true, needs_restore: [],
  records: Object.fromEntries(['party', 'client', 'deal', 'invoice', 'lead_party', 'lead', 'conversation', 'tour'].map((name, index) => [
    name, name === 'invoice' ? { deal_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }
      : { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` },
  ])),
});
const verdict = overrides => ({
  failed: false, completed: true, pendingScreens: [], failedScreens: [], failedStateObligations: [],
  pendingStateObligations: [], newDeadControls: [], skippedControls: 0, skippedStateObligations: 0,
  expectedExplorations: 90, completedExplorations: 90, pendingExplorations: [], failedExplorations: [],
  skippedExplorations: [], explorationsSourceBound: true,
  ...overrides,
});
const classify = (value = {}, options = {}) => completionContract({
  verdict: verdict(value), release: options.release || release,
  fixtureWriteScopeComplete: options.fixtureWriteScopeComplete ?? true,
  setup: Object.hasOwn(options, 'setup') ? options.setup : setup(),
});

test('all 90 source-bound explorations and fixture prerequisites are required for bounded sweep acceptance', () => {
  assert.equal(classify().status, 'ACCEPTED_SWEEP');
  assert.equal(classify().v1Status, 'PARTIAL', 'no journey proof catalog is asserted by this bounded sweep');
  assert.equal(classify().acceptedV1, false);
  assert.equal(classify().jobStatus, 'SWEEP_ACCEPTED');
});

test('complete screens and states with missing exploration goals remain partial', () => {
  const result = classify({ expectedExplorations: 90, completedExplorations: 89,
    pendingExplorations: [{ target: 'phone', screen: 'Workspace 29', path: '/workspace29', agent: 'phone-reviewer', status: 'MISSING' }] });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.jobStatus, 'CONTINUE');
  assert.equal(result.acceptedV1, false);
  assert.equal(result.pendingExplorations.length, 1);
  assert.equal(classify({ completedExplorations: 89 }).status, 'PARTIAL', 'an inconsistent count cannot omit pending goals');
  assert.equal(classify({ expectedExplorations: 89, completedExplorations: 89 }).status, 'PARTIAL', 'a reduced denominator cannot lower the 90-goal contract');
});

test('scheduler-derived exploration coverage requires every planned target, path, agent, status, steps and evidence', () => {
  const rows = goalRows();
  assert.equal(rows.length, 90);
  const complete = explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release });
  assert.equal(complete.completedExplorations, 90);
  assert.equal(complete.pendingExplorations.length, 0);
  rows.pop();
  const missing = explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release });
  assert.equal(missing.completedExplorations, 89);
  assert.equal(missing.pendingExplorations.length, 1);
  rows.push({ ...goalRows().at(-1), status: 'finished', steps: 0 });
  assert.equal(explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release }).completedExplorations, 89);
});

test('needs_restore, closed deal and ineligible lead prevent acceptance despite setup complete', () => {
  for (const needs_restore of [
    [{ record: 'deal', reason: 'closed', id: 'private-id' }],
    [{ record: 'lead', reason: 'ui_ineligible', id: 'private-id' }],
  ]) {
    const result = classify({}, { setup: { ...setup(), needs_restore } });
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.fixturePrerequisitesComplete, false);
    assert.deepEqual(result.missingFixturePrerequisites, [`restore-required-${needs_restore.length}`]);
    assert.doesNotMatch(JSON.stringify(result), /private-id/);
  }
  assert.equal(classify({}, { setup: { ...setup(), eligibleLead: false } }).status, 'PARTIAL');
});

test('missing or source-unbound exploration evidence cannot be accepted', () => {
  assert.equal(classify({ completedExplorations: 0, pendingExplorations: [{ status: 'MISSING' }],
    explorationsSourceBound: false }).status, 'PARTIAL');
  assert.equal(classify({ failedExplorations: [{ status: 'ERROR' }] }).status, 'FAILED');
  assert.equal(classify({}, { setup: undefined }).status, 'PARTIAL');
  assert.equal(classify({}, { setup: { ...setup(), release: { ...release, source_commit: 'b'.repeat(40) } } }).status, 'FAILED');
});

test('safe unfinished progress stays resumable and red checks remain failures', () => {
  const partial = classify({ completed: false, failed: true, pendingScreens: ['desktop|/next'] });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.jobStatus, 'CONTINUE');
  assert.equal(partial.accepted, false);
  assert.equal(classify({ failedScreens: ['desktop|/'] }).status, 'FAILED');
  assert.equal(classify({ failedStateObligations: ['state/calendar/write'] }).status, 'FAILED');
  assert.equal(classify({ newDeadControls: ['control-key'] }).status, 'FAILED');
  assert.equal(classify({}, { release: { ...release, source_commit: 'invalid' } }).status, 'FAILED');
});

test('unreconciled fixture browser writes stop the job', () => {
  const result = classify({ completed: false }, { fixtureWriteScopeComplete: false });
  assert.equal(result.status, 'NEEDS_RECONCILIATION');
  assert.equal(result.jobStatus, 'BLOCKED');
  assert.equal(result.resumable, false);
});
