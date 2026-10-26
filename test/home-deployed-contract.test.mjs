import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';
import { agendaSnapshot, dealSnapshot, readHomeDashboard } from '../js/home-dashboard-model.js';

test('Home reads deal attention and agenda through the deployed CARR contracts', async () => {
  const requests = [];
  const deal = { id: 'synthetic-home-deal', name: 'Synthetic Home deal', owner: 'synthetic-agent',
    phase: 'research', next_step: 'Confirm synthetic step', next_date: '2026-09-30' };
  const supported = {
    'read-home-agenda': { schema_version: 'home-agenda.v1', actor: 'synthetic-agent', deals: [{ ...deal, critical_dates: [], next_actions: [
      { id: 'synthetic-home-task', description: 'Confirm synthetic task', owner: deal.owner, status: 'open', due_on: '2026-09-30' },
    ] }] },
    'get-deal-room': { ...deal, deal_id: deal.id, critical_dates: [], next_actions: [
      { id: 'synthetic-home-task', description: 'Confirm synthetic task', owner: deal.owner, status: 'open', due_on: '2026-09-30' },
    ] },
  };
  const client = createLiveClient({ docContext: false, fetchImpl: async (path, init) => {
    if (path !== '/mcp') return new Response('{}', { status: 503 });
    const request = JSON.parse(init.body);
    const { name, arguments: args } = request.params;
    requests.push({ name, args });
    const available = Object.hasOwn(supported, name);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      ...(available ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(available ? supported[name] : { error: 'unknown_tool', tool: name }) }],
    } }));
  } });

  const result = await readHomeDashboard(client);

  assert.equal(result.reads.board.state, 'read', `Home board unavailable; requested ${requests.map(row => row.name).join(', ')}`);
  assert.equal(result.unauthorized, false);
  assert.deepEqual(dealSnapshot(result.board, 'mine', agendaSnapshot(result.board, result.details, { scope: 'mine', today: '2026-10-01' })).flagged.map(row => row.id), [deal.id]);
  assert.deepEqual(agendaSnapshot(result.board, result.details, { scope: 'mine', today: '2026-10-01' }).entries.map(row => row.key), ['task:synthetic-home-task']);
  assert.equal(result.loading, false);
  assert.equal(requests.filter(row => row.name === 'read-home-agenda').length, 1);
  assert.ok(!requests.some(row => ['deal-room-board', 'get-deal-room'].includes(row.name)));
  assert.deepEqual(requests.find(row => row.name === 'read-home-agenda').args, {});
});
