import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSweepJobOutcome } from '../../scripts/e2e-staging/completion-contract.mjs';

test('accepted bounded sweep and resumable partial partitions remain distinct job outcomes', () => {
  const accepted = { status: 'ACCEPTED_SWEEP', proofStatus: 'ACCEPTED_SWEEP', v1Status: 'PARTIAL', acceptedV1: false, jobStatus: 'SWEEP_ACCEPTED' };
  const partial = { status: 'PARTIAL', proofStatus: 'PARTIAL', jobStatus: 'CONTINUE' };
  assert.equal(assertSweepJobOutcome(accepted), accepted);
  assert.equal(assertSweepJobOutcome(partial), partial);
  assert.equal(accepted.acceptedV1, false, 'bounded sweep proof does not claim V1 acceptance');
  assert.notEqual(partial.proofStatus, 'ACCEPTED_SWEEP');
});

test('unreconciled writes and measured failures stop the job', () => {
  for (const status of ['NEEDS_RECONCILIATION', 'FAILED']) {
    assert.throws(() => assertSweepJobOutcome({ status }), new RegExp(status));
  }
});
