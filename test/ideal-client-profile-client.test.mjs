import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadBoardClient } from '../js/leads-client.js';
test('historical fit uses the authenticated Leads transport with exact optional filters', async () => {
  let request;
  const payload = { schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [] };
  const client = createLeadBoardClient({ docContext: false, fetchImpl: async (_, init) => {
    request = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  } });
  assert.deepEqual(await client.getIdealClientProfile({ city: 'Demo City', state: 'TX', vertical: 'Dental' }), payload);
  assert.equal(request.params.name, 'ideal-client-profile');
  assert.deepEqual(request.params.arguments, { city: 'Demo City', state: 'TX', vertical: 'Dental' });
});
