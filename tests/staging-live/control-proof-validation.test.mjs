import test from 'node:test';
import assert from 'node:assert/strict';
import { validControlObservations, validControlProof } from '../../scripts/e2e-staging/control-proofs.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };

test('every catalog identity has a complete observable effect proof', () => {
  const identities = new Set();
  for (const proof of catalog.controls) {
    assert.match(proof.identity, /^control-state\.v1:[a-f0-9]{64}$/);
    assert.ok(!identities.has(proof.identity)); identities.add(proof.identity);
    assert.ok(validControlProof(proof), proof.review.policy);
  }
});
test('missing, unchanged and malformed DOM effects are unproved', () => {
  for (const observations of [undefined, [], [{}],
    [{ selector: '#dialog', attribute: 'open', transitions: [{ from: null, to: null }] }],
    [{ selector: '#dialog', attribute: '$presence', transitions: [{ from: null, to: true }] }],
    [{ selector: '#dialog', attribute: 'open', transitions: [{ from: null, to: '', optional: true }] }]])
    assert.equal(validControlObservations(observations), false);
});
test('API observations require a named same-origin operation and its declared permission effect', () => {
  const request = { path: '/mcp', method: 'POST', operation: 'morning-brief' };
  const proof = { effects: [{ operation: 'morning-brief', arguments: {} }], observations: [{ request }] };
  assert.equal(validControlProof(proof), true);
  assert.equal(validControlProof({ ...proof, effects: [] }), false);
  for (const change of [{ path: 'https://other.invalid/mcp' }, { method: 'GET' }, { operation: '' }, { optional: true }])
    assert.equal(validControlProof({ ...proof, observations: [{ request: { ...request, ...change } }] }), false);
});
