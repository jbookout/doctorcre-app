import assert from 'node:assert/strict';
import test from 'node:test';
import { completionContract, explorationCoverage } from '../../scripts/e2e-staging/completion-contract.mjs';
import { screens as canonicalScreens, targets as canonicalTargets } from '../../scripts/e2e-staging/screens.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { createExplorationSchedule } from '../../scripts/e2e-staging/explore.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import qualification from '../../contracts/e2e-staging-v1-qualification.v1.json' with { type: 'json' };
import { V1_QUALIFICATION_SHA256 } from '../../scripts/e2e-staging/v1-qualification.mjs';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const targets = canonicalTargets;
const routedScreens = await canonicalScreens();
const plannedExplorationCount = targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface)
  .map(() => target.name.endsWith('phone') ? 1 : 2)).reduce((sum, count) => sum + count, 0);
const goalRows = () => targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface).flatMap(screen =>
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
  expectedExplorations: plannedExplorationCount, completedExplorations: plannedExplorationCount, pendingExplorations: [], failedExplorations: [],
  skippedExplorations: [], explorationsSourceBound: true,
  ...overrides,
});
const classify = (value = {}, options = {}) => completionContract({
  verdict: verdict(value), release: options.release || release,
  fixtureWriteScopeComplete: options.fixtureWriteScopeComplete ?? true,
  setup: Object.hasOwn(options, 'setup') ? options.setup : setup(),
  targets, routedScreens,
  runId: 'synthetic-run',
  retainedEvidence: Object.hasOwn(options, 'retainedEvidence') ? options.retainedEvidence : {
    schema: 'doctorcre-staging-retained-evidence.v1', verified: true,
    source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    run_id: 'synthetic-run', referencedFiles: 93,
  },
  businessProof: options.businessProof,
  journeyEvidence: options.journeyEvidence,
});

const journeyEvidence = () => ({
  schema: 'doctorcre-staging-journey-observations.v1',
  source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
  run_id: 'synthetic-run', fixture_run: '11111111-1111-4111-8111-111111111111',
  observations: qualification.requirements.flatMap(row => row.actions.map(action => ({
    id: row.id, case: row.case, action, state: 'observed',
    source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    run_id: 'synthetic-run', fixture_run: '11111111-1111-4111-8111-111111111111',
    actor: 'joe', contract_sha256: V1_QUALIFICATION_SHA256,
    ui_sha256: 'a'.repeat(64), readback_sha256: 'b'.repeat(64),
  }))),
  companions: qualification.companion_ids.map(id => ({ id, enabled: false, state: 'disabled-observed',
    source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    run_id: 'synthetic-run', fixture_run: '11111111-1111-4111-8111-111111111111',
    actor: 'joe', contract_sha256: V1_QUALIFICATION_SHA256,
    ui_sha256: 'c'.repeat(64), readback_sha256: 'd'.repeat(64) })),
});

test('synthetic full action matrix qualifies only with retained sweep, fixture and source bindings', () => {
  const evidence = journeyEvidence();
  const accepted = classify({}, { journeyEvidence: evidence });
  assert.equal(accepted.status, 'ACCEPTED_SWEEP');
  assert.equal(accepted.v1Status, 'ACCEPTED_V1');
  assert.equal(accepted.acceptedV1, true);
  assert.equal(accepted.jobStatus, 'V1_ACCEPTED');
  for (const changed of [
    { observations: evidence.observations.slice(1) },
    { observations: [...evidence.observations, evidence.observations[0]] },
    { companions: evidence.companions.slice(1) },
    { source_pair: { ...evidence.source_pair, source_commit: 'b'.repeat(40) } },
    { run_id: 'foreign-run' },
  ]) assert.equal(classify({}, { journeyEvidence: { ...evidence, ...changed } }).acceptedV1, false);
  assert.equal(classify({}, { journeyEvidence: evidence, fixtureWriteScopeComplete: false }).acceptedV1, false);
  assert.equal(classify({ skippedControls: 1 }, { journeyEvidence: evidence }).acceptedV1, false);
  assert.equal(classify({}, { journeyEvidence: evidence, retainedEvidence: { verified: false } }).acceptedV1, false);
});

test('completed counts without source-bound retained evidence stay partial and never credit V1', () => {
  for (const retainedEvidence of [undefined, { verified: false },
    { schema: 'doctorcre-staging-retained-evidence.v1', verified: true,
      source_pair: { source_commit: 'b'.repeat(40), carr_source_commit: release.carr_source_commit }, referencedFiles: 93 }]) {
    const result = classify({}, { retainedEvidence });
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.retainedEvidenceVerified, false);
    assert.equal(result.acceptedV1, false);
  }
  const bounded = classify({}, { businessProof: { schema: 'staging-business-journey-result.v1',
    release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    completed: ['W4', 'W9', 'W15'], unqualified_journeys: ['W6', 'Outlook draft', 'Call Mode'], full_v1_qualified: false } });
  assert.equal(bounded.businessProofSourceBound, true);
  assert.equal(bounded.acceptedV1, false);
});

test('canonical scheduler plan requires all source-bound explorations and fixture prerequisites for bounded sweep acceptance', () => {
  assert.equal(routedScreens.length, 31);
  assert.equal(plannedExplorationCount, 93);
  assert.equal(createExplorationSchedule({ targets, routedScreens }).planned.length, 93);
  const run = createSweepRun({ targets, routedScreens });
  assert.equal(run.snapshot().expectedScreens, 62);
  assert.equal(run.snapshot().expectedStates, 62);
  assert.equal(run.snapshot().expectedExplorations, 93);
  assert.equal(classify().status, 'ACCEPTED_SWEEP');
  assert.equal(classify().v1Status, 'PARTIAL', 'no journey proof catalog is asserted by this bounded sweep');
  assert.equal(classify().acceptedV1, false);
  assert.equal(classify().jobStatus, 'SWEEP_ACCEPTED');
});

test('complete screens and states with one missing actual scheduler goal remain partial', () => {
  const missingGoal = goalRows().at(-1);
  const result = classify({ expectedExplorations: 93, completedExplorations: 92,
    pendingExplorations: [{ ...missingGoal, status: 'MISSING' }] });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.jobStatus, 'CONTINUE');
  assert.equal(result.acceptedV1, false);
  assert.equal(result.pendingExplorations.length, 1);
  assert.equal(classify({ completedExplorations: 89 }).status, 'PARTIAL', 'an inconsistent count cannot omit pending goals');
  assert.equal(classify({ expectedExplorations: 90, completedExplorations: 90 }).status, 'PARTIAL', 'a reduced denominator cannot lower the canonical 93-goal plan');
});

test('scheduler-derived exploration coverage requires every planned target, path, agent, status, steps and evidence', () => {
  const rows = goalRows();
  assert.equal(rows.length, 93);
  const complete = explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release });
  assert.equal(complete.completedExplorations, 93);
  assert.equal(complete.pendingExplorations.length, 0);
  rows.pop();
  const missing = explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release });
  assert.equal(missing.completedExplorations, 92);
  assert.equal(missing.pendingExplorations.length, 1);
  rows.push({ ...goalRows().at(-1), status: 'finished', steps: 0 });
  assert.equal(explorationCoverage({ targets, routedScreens, explorations: rows,
    explorationRelease: release, release }).completedExplorations, 92);
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
