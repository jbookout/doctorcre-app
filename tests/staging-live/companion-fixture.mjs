import assert from 'node:assert/strict';

// Synthetic transport for served-app tests. The real guard must observe this
// failure through its forward callback, rather than receive an unavailable reply.
export function refuseFixtureCompanionConnection(request) {
  const url = new URL(request.url());
  if (url.origin !== 'http://127.0.0.1:4682') return;
  assert.equal(request.method(), 'GET');
  assert.equal(url.href, 'http://127.0.0.1:4682/api/state');
  throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4682'), { code: 'ECONNREFUSED' });
}

export function assertCompanionUnavailable(plan) {
  assert.ok(plan.companion_attempts?.length > 0, 'the app forwarded a companion status request');
  assert.equal(plan.companion_journey, undefined);
  for (const row of plan.companion_attempts) {
    assert.equal(row.operation, 'state');
    assert.equal(row.state, 'unavailable');
    assert.deepEqual(row.observation, { enabled: false, outcome: 'connection-refused', forwarded: true });
  }
}
