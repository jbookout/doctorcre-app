import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
import { createLeadBoardClient } from '../js/leads-client.js';
import { agendaSnapshot, controlSnapshot, readHomeDashboard, topNewLeads } from '../js/home-dashboard-model.js';

const now = Date.parse('2026-10-01T15:00:00Z');
const lead = score => ({ id: `demo-${score}`, name: 'Demo practice', score, created_at: new Date(now).toISOString() });
test('R1 live lead decimals rank numerically while malformed score strings are excluded', async () => {
  const rows = ['98.00', '9.50', '80.25', '', ' ', '98x', '0x62', 'Infinity', '1e2', null].map(lead);
  const client = createLeadBoardClient({ fetchImpl: async () => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ leads: rows }) }] } })) });
  const ranked = topNewLeads(await client.getLeadBoard(), { now });
  assert.deepEqual(ranked.map(row => row.score), [98, 80.25, 9.5]);
});

async function healthyControl() {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const schedule = await client.scheduleBoard(), resources = await client.readResourceDashboard();
  for (const owner of ['control-plane', 'cron']) schedule.jobs.push({ ...schedule.jobs[0], key: `demo-${owner}`, owner });
  return { incidents: { count: 0, incidents: [], by_severity: {}, ready_to_close: 0 },
    work: { ok: true, count: 0, current: [], wip: { limit_system_wide: 2, in_flight: 0 } }, requests: { ok: true, items: [] },
    schedule: { ...schedule, overall_state: 'read', sources: schedule.sources.map(row => ({ ...row, state: 'read', count: 1 })), jobs: schedule.jobs.map(row => ({ ...row, state: 'healthy', freshness: 'fresh' })) },
    resources: { ...resources, providers: resources.providers.map(row => ({ ...row, state: 'ok', observed_at: new Date(now).toISOString() })) } };
}

test('R2 captured, triaged and ready requests with a next human action each require attention', async () => {
  const reads = await healthyControl();
  assert.equal(controlSnapshot(reads).attention, false);
  for (const state of ['captured', 'triaged', 'ready']) {
    reads.requests.items = [{ human_ref: 'WR-DEMO', title: 'Demo request', state, source: { label: 'Demo', freshness: 'current' }, next_human_action: 'Review request' }];
    assert.equal(controlSnapshot(reads).issues, 1, state);
    assert.equal(controlSnapshot(reads).attention, true, state);
  }
});

test('R3 system and executor WIP breaches independently require attention', async () => {
  const reads = await healthyControl();
  for (const breach of [{ over_system_limit: true }, { executors_over_limit: [{ executor: 'demo', in_flight: 3, limit: 2 }] }]) {
    const result = controlSnapshot({ ...reads, work: { ...reads.work, wip: { ...reads.work.wip, ...breach } } });
    assert.equal(result.attention, true);
    assert.match(result.line, /Work.*limit/i);
  }
});

test('R4 failed incidents retain a known blocked work issue and report incomplete evidence', async () => {
  const reads = await healthyControl();
  reads.incidents = null;
  reads.work = { ...reads.work, count: 1, current: [{ human_ref: 'WR-DEMO', title: 'Demo work', state: 'blocked', owner: null, executor: null, blocker: { code: 'demo' }, hours_since_last_change: 1 }] };
  const result = controlSnapshot(reads);
  assert.equal(result?.attention, true);
  assert.equal(result.issues, 1);
  assert.equal(result.complete, false);
  assert.match(result.line, /decision/);
  assert.equal(controlSnapshot({ incidents: null, work: null, requests: null, resources: null, schedule: null })?.attention, true);
  assert.equal(controlSnapshot({}), null);
});

test('R8 timed-out and disposed Home reads abort the live lead transport', async () => {
  const requests = [];
  const leads = createLeadBoardClient({ fetchImpl: (_path, init) => {
    requests.push(init);
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const client = { getBoard: async () => ({ deals: [] }), getLeadBoard: leads.getLeadBoard,
    incidentBoard: async () => null, currentWorkItem: async () => null, currentWorkRequests: async () => null,
    readResourceDashboard: async () => null, scheduleBoard: async () => null };
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
