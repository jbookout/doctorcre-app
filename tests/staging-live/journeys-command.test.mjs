import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSelectedActionProofs, missingSelectedActionProofs, parseJourneySelection } from '../../scripts/e2e-staging/selected-journeys.mjs';
import { parseJourneyArgs } from '../../scripts/e2e-staging/journeys.mjs';

test('selected staging entrypoint defaults to W4/W9 and accepts explicit supported subset', () => {
  assert.deepEqual(parseJourneyArgs([]), ['W4', 'W9']);
  assert.deepEqual(parseJourneyArgs(['--journeys', 'W9']), ['W9']);
  assert.deepEqual(parseJourneySelection('W4,W9'), ['W4', 'W9']);
});

test('selected results require matching current source, run, fixture, and action receipts', () => {
  const sourcePair = { source_commit: 'a'.repeat(40), carr_source_commit: 'b'.repeat(40) };
  const runId = 'run-12345678', fixtureRun = '12345678-1234-4234-8234-123456789abc';
  const rows = ['eight-columns', 'drag-cancel', 'drag-confirm', 'independent-phase-readback'].map(action => ({
    id: 'W4', case: 'local-deals', action, state: 'observed', source_pair: sourcePair, run_id: runId, fixture_run: fixtureRun,
  }));
  assert.deepEqual(missingSelectedActionProofs(['W4'], rows, { sourcePair, runId, fixtureRun }), []);
  assert.deepEqual(missingSelectedActionProofs(['W4'], rows.slice(0, 3), { sourcePair, runId, fixtureRun }),
    ['W4:local-deals:independent-phase-readback']);
  assert.equal(missingSelectedActionProofs(['W4'], rows, { sourcePair, runId: 'other-run', fixtureRun }).length, 4);
});

test('selected proof update retains unrelated validated observations and replaces selected identities once', () => {
  const prior = [
    { id: 'W14', case: 'referrals', action: 'referrals', state: 'observed' },
    { id: 'W4', case: 'local-deals', action: 'drag-cancel', state: 'observed', ui_sha256: 'old' },
  ];
  const current = [{ id: 'W4', case: 'local-deals', action: 'drag-cancel', state: 'observed', ui_sha256: 'new' }];
  assert.deepEqual(mergeSelectedActionProofs(prior, current, ['W4']), [prior[0], current[0]]);
  assert.throws(() => mergeSelectedActionProofs([], [...current, ...current], ['W4']),
    /selected-journey-proof-conflict/);
});

test('selected staging entrypoint refuses unknown, duplicate, empty, and malformed selections', () => {
  for (const value of ['', 'W15', 'W4,W4', 'W4, W9', 'W9,W4,W15'])
    assert.throws(() => parseJourneySelection(value), /selected-journey-selection-invalid/);
  for (const args of [['--journeys'], ['W4'], ['--journeys', 'W4', '--journeys', 'W9']])
    assert.throws(() => parseJourneyArgs(args), /Usage:/);
});
