import assert from 'node:assert/strict';
import test from 'node:test';
import coverage from '../../contracts/e2e-staging-v1-qualification.v1.json' with { type: 'json' };
import { qualifyV1Journeys, V1_QUALIFICATION_SHA256 } from '../../scripts/e2e-staging/v1-qualification.mjs';

const sourcePair = { source_commit: 'a'.repeat(40), carr_source_commit: coverage.producer.source_commit };
const runId = 'synthetic-v1-qualification';
const fixtureRun = '11111111-1111-4111-8111-111111111111';
const digest = 'b'.repeat(64);
const proof = (id, caseId, action) => ({ id, case: caseId, action, state: 'observed', source_pair: sourcePair,
  run_id: runId, fixture_run: fixtureRun, actor: 'joe', contract_sha256: V1_QUALIFICATION_SHA256,
  ui_sha256: digest, readback_sha256: digest });
const complete = () => coverage.requirements.flatMap(row => row.actions.map(action => proof(row.id, row.case, action)));
const companions = () => coverage.companion_ids.map(id => ({ id, enabled: false, state: 'disabled-observed',
  source_pair: sourcePair, run_id: runId, fixture_run: fixtureRun, actor: 'joe',
  contract_sha256: V1_QUALIFICATION_SHA256, ui_sha256: digest, readback_sha256: digest }));
const evaluate = (observations, overrides = {}) => qualifyV1Journeys({
  sourcePair, runId, fixtureRun, observations, writeCoverage: true,
  retainedEvidenceVerified: true, sweepAccepted: true, companion: companions(), ...overrides,
});

test('V1 requires every test-body action, with no ID-only or partial journey credit', () => {
  assert.equal(coverage.requirements.length, 10);
  assert.equal(evaluate([]).full_v1_qualified, false);
  const observations = complete();
  assert.equal(evaluate(observations).full_v1_qualified, true);
  for (const action of observations) {
    const missing = evaluate(observations.filter(row => row !== action));
    assert.equal(missing.full_v1_qualified, false, `${action.id}/${action.action}`);
    assert.ok(missing.pending.some(row => row.id === action.id && row.case === action.case && row.action === action.action));
  }
});

test('source, run, fixture, digest, duplication and reconciliation are closed boundaries', () => {
  const observations = complete();
  for (const replacement of [
    { source_pair: { ...sourcePair, source_commit: 'c'.repeat(40) } },
    { run_id: 'other-run' }, { fixture_run: '22222222-2222-4222-8222-222222222222' },
    { state: 'pending' }, { ui_sha256: 'not-a-digest' }, { readback_sha256: null },
    { actor: 'other' }, { contract_sha256: 'c'.repeat(64) },
  ]) {
    const altered = [...observations]; altered[0] = { ...altered[0], ...replacement };
    assert.equal(evaluate(altered).full_v1_qualified, false);
  }
  assert.equal(evaluate([...observations, observations[0]]).full_v1_qualified, false);
  for (const condition of [{ writeCoverage: false }, { retainedEvidenceVerified: false },
    { sweepAccepted: false }, { companion: [{ ...companions()[0], enabled: true, state: 'pending' }, companions()[1]] }])
    assert.equal(evaluate(observations, condition).full_v1_qualified, false);
});

test('future route acceptance cannot replace the implemented W6 draft behavior', () => {
  const observations = complete().filter(row => !(row.id === 'W6' && row.action === 'draft-reload'));
  observations.push(proof('W6', 'tours-drafts', 'accept-route'));
  assert.equal(evaluate(observations).full_v1_qualified, false);
});
