import test from 'node:test';
import assert from 'node:assert/strict';
import { requireStagingAuthority, withJourneyFixture } from '../tests/staging/journey-fixture.mjs';

test('authority outage fails explicitly before preparing a fixture', async () => {
  const request = { post: async () => ({ status: () => 200, json: async () => ({ result: { content: [{ type: 'text', text: '{"error":"authority_connection_unavailable"}' }] } }) }) };
  await assert.rejects(requireStagingAuthority(request), /staging authority unavailable/);
});

test('cleanup runs even when the browser assertion fails', async () => {
  const actions = [];
  const produce = async (action, run) => {
    actions.push(action);
    return action === 'prepare' ? { run } : { remaining: 0 };
  };
  await assert.rejects(withJourneyFixture(async () => { throw new Error('browser assertion'); }, produce), /browser assertion/);
  assert.deepEqual(actions, ['prepare', 'cleanup']);
});

test('nonempty cleanup fails the test', async () => {
  await assert.rejects(withJourneyFixture(async () => {}, async action => action === 'prepare' ? {} : { remaining: 1 }), /leftover fixture/);
});

test('authority probe conforms to the MCP schema and cannot issue a share', async () => {
  let payload;
  const request = { post: async (_path, options) => {
    payload = options.data.params.arguments;
    return { status: () => 200, json: async () => ({ result: { content: [{ type: 'text', text: '{"error":"tour_share_scope_invalid"}' }] } }) };
  } };
  await requireStagingAuthority(request);
  assert.match(payload.projection_id, /^[a-f0-9-]{36}$/);
  assert.equal(payload.permission_scopes.length, 1);
  assert.equal(payload.permission_scopes[0], 'invalid-preflight-scope');
});

test('cleanup also runs when fixture preparation loses its response', async () => {
  const actions = [];
  await assert.rejects(withJourneyFixture(async () => {}, async action => {
    actions.push(action);
    if (action === 'prepare') throw new Error('lost response');
    return { remaining: 0 };
  }), /lost response/);
  assert.deepEqual(actions, ['prepare', 'cleanup']);
});
