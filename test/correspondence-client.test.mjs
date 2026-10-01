import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { identity, unavailable } from './fixtures/correspondence.mjs';

test('both read verbs use same-origin MCP and send exact server arguments', async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init }); return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify(unavailable) }] } }));
  } });
  await client.correspondenceReadiness({}); await client.readCorrespondenceThread(identity);
  assert.deepEqual(calls.map(call => JSON.parse(call.init.body).params), [
    { name: 'correspondence-readiness', arguments: {} }, { name: 'read-correspondence-thread', arguments: identity }]);
  assert.ok(calls.every(call => call.path === '/mcp' && call.init.credentials === 'same-origin'));
  await assert.rejects(() => client.readCorrespondenceThread({ ...identity, deal: 'demo' }));
  assert.equal(calls.length, 2);
});

test('fixture adapter also implements both read verbs and honestly returns unavailable', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const result = await client.readCorrespondenceThread(identity);
  assert.equal(result.decision, 'unavailable'); assert.deepEqual(result.receipts, []);
  assert.equal((await client.correspondenceReadiness({})).mailbox_reads_possible, false);
});

test('versioned interface pins the two read schemas exactly; no correspondence write is added', async () => {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json', import.meta.url), 'utf8'));
  assert.ok(contract.mcp_operations.includes('correspondence-readiness'));
  assert.ok(contract.mcp_operations.includes('read-correspondence-thread'));
  assert.deepEqual(contract.mcp_read_contracts['correspondence-readiness'].inputSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.deepEqual(contract.mcp_read_contracts['read-correspondence-thread'].inputSchema,
    { type: 'object', additionalProperties: false, properties: { source_system: { type: 'string' }, native_id: { type: 'string' },
      native_id_epoch: { type: 'integer', minimum: 0 } }, required: ['source_system', 'native_id', 'native_id_epoch'] });
  assert.equal(contract.mcp_operations.some(name => /^(send|reply|draft|record-correspondence|revoke-correspondence)/.test(name)), false);
});
