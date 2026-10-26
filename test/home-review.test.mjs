import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadBoardClient } from '../js/leads-client.js';
import { agendaSnapshot, readHomeDashboard, topNewLeads } from '../js/home-dashboard-model.js';

const now = Date.parse('2026-10-01T15:00:00Z');
const lead = score => ({ id: `demo-${score}`, name: 'Demo practice', stage: 'new', score, created_at: new Date(now).toISOString() });
test('R1 live lead decimals rank numerically while malformed score strings are excluded', async () => {
  const rows = ['98.00', '9.50', '80.25', '', ' ', '98x', '0x62', 'Infinity', '1e2', null].map(lead);
  const client = createLeadBoardClient({ fetchImpl: async () => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ leads: rows }) }] } })) });
  const ranked = topNewLeads(await client.getLeadBoard(), { now });
  assert.deepEqual(ranked.map(row => row.score), [98, 80.25, 9.5]);
});

test('R8 timed-out and disposed Home reads abort the live lead transport', async () => {
  const requests = [];
  const leads = createLeadBoardClient({ fetchImpl: (_path, init) => {
    requests.push(init);
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const client = { getHomeAgenda: async () => ({ schema_version: 'home-agenda.v1', actor: 'joe', deals: [] }), getLeadBoard: leads.getLeadBoard };
  for (let i = 0; i < 3; i++) await readHomeDashboard(client, { timeoutMs: 5 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(init => init.signal?.aborted));
  const controller = new AbortController();
  const pending = readHomeDashboard(client, { signal: controller.signal });
  controller.abort(); await pending;
  assert.equal(requests.at(-1).signal.aborted, true);
});

test('R12 malformed optional rows do not throw or remove valid independent agenda entries', () => {
  const board = { actor: 'joe', deals: [{ id: 'demo', name: 'Demo deal' }] };
  const details = new Map([['demo', { critical_dates: [null, 1, { id: 'demo-date', due_on: '2026-10-02', status: 'open' }],
    next_actions: [null, 1, {}, { id: 'demo-task', description: 'Demo task', status: 'open', due_on: '2026-10-01' }] }]]);
  const agenda = agendaSnapshot(board, details, { today: '2026-10-01' });
  assert.deepEqual(agenda.entries.map(row => row.key), ['task:demo-task', 'demo-date']);
  assert.deepEqual(agenda.failed, ['demo']);
});
