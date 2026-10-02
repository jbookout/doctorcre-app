import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
import { createLiveClient } from '../js/live-client.js';
import { agendaSnapshot, controlSnapshot, dealHref, dealSnapshot, HIDDEN_HOME_WIDGETS, readHomeDashboard, topNewLeads } from '../js/home-dashboard-model.js';

const NOW = Date.parse('2026-10-01T15:00:00Z');
const board = { actor: 'joe', deals: [
  { id: 'demo-a', name: 'Demo A', owner: 'joe', attention: true, phase: 'Research' },
  { id: 'demo-b', name: 'Demo B', owner: 'dell', attention: true, account_client_id: 'demo-account', phase: 'Legal' },
  { id: 'demo-c', name: 'Demo C', owner: 'joe', attention: true, operating_state: 'parked' },
  { id: 'demo-d', name: 'Demo D', owner: 'joe', attention: true, phase: 'Closed' },
] };
test('Home flags and all headline counts use the same active owner-scoped set; unknown market membership stays unknown', () => {
  const team = dealSnapshot(board);
  assert.deepEqual([team.active, team.national, team.inMarket, team.flagged.map(row => row.id)], [2, 1, null, ['demo-a', 'demo-b']]);
  const mine = dealSnapshot(board, 'mine');
  assert.deepEqual([mine.active, mine.national, mine.flagged.map(row => row.id)], [1, 0, ['demo-a']]);
  assert.equal(dealSnapshot({ ...board, actor: null }, 'mine'), null);
  assert.equal(dealSnapshot(null), null);
  assert.equal(dealSnapshot({ deals: board.deals.map(row => ({ ...row, in_market: true })) }).inMarket, 2);
  assert.equal(dealHref('demo/a?x=1'), '/deals?deal=demo%2Fa%3Fx%3D1');
});
test('top leads is exactly the highest three finite scores added in seven days, includes low/suppressed rows, ties deterministic', () => {
  const lead = (id, score, created_at = '2026-10-01T12:00:00Z', owner = 'joe') => ({ id, score, created_at, owner });
  const payload = { leads: [lead('demo-1', 80), { ...lead('demo-2', 99), suppressed: true }, lead('demo-3', 90, undefined, 'dell'), lead('demo-4', 79),
    lead('old', 100, '2026-09-24T14:59:59Z'), lead('unknown', null), lead('bad', NaN), lead('future', 100, '2026-10-02T00:00:00Z')] };
  assert.deepEqual(topNewLeads(payload, { now: NOW }).map(row => row.id), ['demo-2', 'demo-3', 'demo-1']);
  assert.deepEqual(topNewLeads(payload, { now: NOW, scope: 'mine', actor: 'joe' }).map(row => row.id), ['demo-2', 'demo-1', 'demo-4']);
  assert.deepEqual(topNewLeads(payload, { now: NOW, scope: 'mine' }), []);
  assert.deepEqual(topNewLeads({ leads: [lead('boundary', 1, '2026-09-24T15:00:00Z')] }, { now: NOW }).map(row => row.id), ['boundary']);
  assert.deepEqual(topNewLeads({ leads: [lead('b', 2), lead('a', 2)] }, { now: NOW }).map(row => row.id), ['a', 'b']);
});
test('agenda preserves open dates and tasks, owner scope, future dates, invalid dates and failed details stay distinct', () => {
  const details = new Map([['demo-a', { critical_dates: [{ id: 'date', due_on: '2026-10-03', kind: 'tour', status: 'open' }, { due_on: '2026-10-05', status: 'done' }, { due_on: 'invalid' }], next_actions: [
    { id: 'task', description: 'Demo task', due_on: '2026-10-01', owner: 'joe', status: 'open' },
    { id: 'other', due_on: '2026-10-02', owner: 'dell', status: 'open' },
    { id: 'completed', due_on: '2026-10-03', status: 'done' },
    { id: 'future', due_on: '2027-02-01', status: 'open', owner: 'joe' },
  ] }]]);
  const all = agendaSnapshot(board, details, { today: '2026-10-01' });
  assert.equal(all.entries.length, 4);
  assert.equal(all.week.length, 7);
  assert.equal(all.week[0].entries[0].type, 'task');
  assert.deepEqual(all.failed, ['demo-b']);
  assert.equal(all.undated.length, 1);
  assert.equal(all.upcoming.at(-1).day, '2027-02-01');
  const mine = agendaSnapshot(board, details, { scope: 'mine', today: '2026-10-01' });
  assert.equal(mine.entries.length, 3);
  assert.deepEqual(mine.failed, []);
  assert.equal(agendaSnapshot(null, details), null);
});
test('control room cannot report No issues with incomplete/absent evidence; positive issues remain visible', async () => {
  const client = await fixtureClient();
  const reads = { incidents: await client.incidentBoard(), work: await client.currentWorkItem(), requests: await client.currentWorkRequests(), resources: await client.readResourceDashboard(), schedule: await client.scheduleBoard() };
  assert.equal(controlSnapshot(reads).attention, true);
  reads.incidents = { count: 0, incidents: [], by_severity: {}, ready_to_close: 0 };
  reads.work = { ok: true, count: 0, current: [], wip: { limit_system_wide: 1, in_flight: 0 } };
  reads.requests = { ok: true, items: [] };
  assert.equal(controlSnapshot({ ...reads, resources: null }).attention, true);
  assert.equal(controlSnapshot({ ...reads, incidents: null }).complete, false);
  for (const owner of ['control-plane', 'cron']) reads.schedule.jobs.push({ ...reads.schedule.jobs[0], key: `demo-${owner}`, owner });
  reads.schedule = { ...reads.schedule, overall_state: 'read', sources: reads.schedule.sources.map(row => ({ ...row, state: 'read', count: 1 })), jobs: reads.schedule.jobs.map(job => ({ ...job, freshness: 'fresh', state: 'healthy' })) };
  reads.resources = { ...reads.resources, providers: reads.resources.providers.map(row => ({ ...row, state: 'ok', observed_at: '2026-10-01T15:00:00Z' })) };
  assert.equal(controlSnapshot(reads).attention, false);
  reads.schedule.jobs[0].state = 'unknown';
  assert.equal(controlSnapshot(reads).attention, true);
});
async function fixtureClient() {
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
}
test('malformed board identity is unavailable, never a verified empty workload', async t => {
  const fixture = await fixtureClient();
  for (const deals of [[{}], [{ id: '' }], [{ id: '  ' }], [null], [board.deals[0], {}]]) {
    await t.test(JSON.stringify(deals), async () => {
      const payload = { actor: 'joe', deals };
      const live = createLiveClient({ fetchImpl: async () => new Response(JSON.stringify({
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      })) });
      const client = { ...fixture, getBoard: options => live.getBoard(options), getLeadBoard: async () => ({ leads: [] }) };
      const result = await readHomeDashboard(client);
      assert.equal(result.board, null);
      assert.equal(result.reads.board.state, 'error');
      assert.equal(result.details.size, 0);
      assert.equal(dealSnapshot(payload), null);
      assert.equal(agendaSnapshot(payload, new Map()), null);
      assert.equal(result.reads.leads.state, 'read', 'independent reads remain available');
    });
  }
  const empty = { actor: 'joe', deals: [] };
  const result = await readHomeDashboard({ ...fixture, getBoard: async () => empty, getLeadBoard: async () => ({ leads: [] }) });
  assert.equal(result.reads.board.state, 'read');
  assert.deepEqual(dealSnapshot(result.board), { active: 0, inMarket: 0, national: 0, flagged: [] });
});
test('Home publishes independent ready data, shares one board, bounds detail concurrency and never invents failed data', async () => {
  let boardReads = 0, inFlight = 0, peak = 0;
  const seen = [];
  const client = { getBoard: async () => { boardReads++; return board; }, getLeadBoard: async () => ({ leads: [] }),
    getDeal: async id => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 2)); inFlight--; if (id === 'demo-b') throw Error('Unavailable'); return { critical_dates: [], next_actions: [] }; },
    incidentBoard: async () => ({ count: 0, incidents: [], by_severity: {}, ready_to_close: 0 }),
    currentWorkItem: async () => { throw Error('Unavailable'); }, currentWorkRequests: async () => null,
    readResourceDashboard: async () => null, scheduleBoard: async () => null };
  const result = await readHomeDashboard(client, { onUpdate: result => seen.push(Boolean(result.board)) });
  assert.equal(boardReads, 1); assert.ok(peak <= 4); assert.ok(seen.includes(true));
  assert.equal(result.details.get('demo-b'), null); assert.equal(result.control.work, null);
  assert.equal(controlSnapshot(result.control).attention, true);
  client.getBoard = async () => { const error = Error('Signed out'); error.status = 401; throw error; };
  assert.equal((await readHomeDashboard(client)).unauthorized, true);
  client.getBoard = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await readHomeDashboard(client, { timeoutMs: 10 })).board, null);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(Object.keys(HIDDEN_HOME_WIDGETS), ['pastClients', 'vendors', 'listings', 'capture']);
});
