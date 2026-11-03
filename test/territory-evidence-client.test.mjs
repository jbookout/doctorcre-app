import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadBoardClient } from '../js/leads-client.js';
const board = { schema_version: 'territory-state-board.v1', coverage: 'recorded_geographies_only', submarkets: [] };
test('territory filters reach authenticated MCP exactly', async () => {
  let request;
  const client = createLeadBoardClient({ docContext: false, fetchImpl: async (_, init) => {
    request = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(board) }] } });
  } });
  assert.deepEqual(await client.getTerritoryStateBoard({ city: 'Demo City', state: 'TX', vertical: 'Dental' }), board);
  assert.equal(request.params.name, 'territory-state-board');
  assert.deepEqual(request.params.arguments, { city: 'Demo City', state: 'TX', vertical: 'Dental' });
});
