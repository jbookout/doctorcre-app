import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
import { createLiveClient } from '../js/live-client.js';
import { agendaSnapshot, controlSnapshot, dealHref, dealSnapshot, HIDDEN_HOME_WIDGETS, readHomeDashboard, topNewLeads } from '../js/home-dashboard-model.js';

const NOW = Date.parse('2026-10-01T15:00:00Z');
const board = { schema_version: 'home-agenda.v1', actor: 'joe', deals: [
  { id: 'demo-a', name: 'Demo A', owner: 'joe', attention: true, next_step:'Confirm synthetic step', next_date:'2026-09-30', phase: 'Research' },
  { id: 'demo-b', name: 'Demo B', owner: 'dell', attention: true, next_step:'Confirm synthetic step', next_date:'2026-09-30', account_client_id: 'demo-account', phase: 'Legal' },
  { id: 'demo-c', name: 'Demo C', owner: 'joe', attention: true, operating_state: 'parked' },
  { id: 'demo-d', name: 'Demo D', owner: 'joe', attention: true, phase: 'Closed' },
] };
test('Home overdue list matches local board scope; team headline counts retain national accounts', () => {
  const team = dealSnapshot(board, 'team', NOW);
  assert.deepEqual([team.active, team.national, team.inMarket, team.flagged.map(row => row.id)], [2, 1, null, ['demo-a']]);
  const mine = dealSnapshot(board, 'mine', NOW);
  assert.deepEqual([mine.active, mine.national, mine.flagged.map(row => row.id)], [1, 0, ['demo-a']]);
  assert.equal(dealSnapshot({ ...board, actor: null }, 'mine'), null);
  assert.equal(dealSnapshot(null), null);
  assert.equal(dealSnapshot({ deals: board.deals.map(row => ({ ...row, in_market: true })) }).inMarket, 2);
  assert.equal(dealHref('demo/a?x=1'), '/deals?deal=demo%2Fa%3Fx%3D1');
});
test('recent arrivals rank eligible leads with finite scores added in seven days, ties deterministic', () => {
  const lead = (id, score, created_at = '2026-10-01T12:00:00Z', owner = 'joe') => ({ id, score, created_at, owner, stage: 'new' });
  const payload = { leads: [lead('demo-1', 80), { ...lead('demo-2', 99), suppressed: true }, lead('demo-3', 90, undefined, 'dell'), lead('demo-4', 79),
    lead('old', 100, '2026-09-24T14:59:59Z'), lead('unknown', null), lead('bad', NaN), lead('future', 100, '2026-10-02T00:00:00Z')] };
  assert.deepEqual(topNewLeads(payload, { now: NOW }).map(row => row.id), ['demo-3', 'demo-1', 'demo-4']);
  assert.deepEqual(topNewLeads(payload, { now: NOW, scope: 'mine', actor: 'joe' }).map(row => row.id), ['demo-1', 'demo-4']);
  assert.deepEqual(topNewLeads(payload, { now: NOW, scope: 'mine' }), []);
  assert.deepEqual(topNewLeads({ leads: [lead('boundary', 1, '2026-09-24T15:00:00Z')] }, { now: NOW }).map(row => row.id), ['boundary']);
  assert.deepEqual(topNewLeads({ leads: [lead('b', 2), lead('a', 2)] }, { now: NOW }).map(row => row.id), ['a', 'b']);
});
test('Home recent arrivals reuse Leads lifecycle eligibility without claiming to be the whole queue', () => {
  const recent = { score: 99, created_at: '2026-10-01T12:00:00Z', owner: 'joe', stage: 'new' };
  const excluded = ['suppressed', 'merged_into', 'deleted_at', 'client_id', 'linked_client', 'is_client', 'is_past_client', 'is_deal', 'deal_id']
    .map(flag => ({ ...recent, id: flag, [flag]: true }));
  const payload = { leads: [...excluded,
    { ...recent, id: 'converted', stage: 'closed_won' },
    { ...recent, id: 'active-deal', stage: 'active_deal' },
    { ...recent, id: 'archived', stage: 'archived' },
    { ...recent, id: 'dnc', do_not_contact: true },
    { ...recent, id: 'eligible', score: 10 },
    { ...recent, id: 'returned', score: 9, stage: 'nurture_drip', client_id: 'synthetic-client', prospect_client_id: 'synthetic-client', prospect_engagement_status: 'inactive' },
    { ...recent, id: 'older-eligible', score: 100, created_at: '2026-09-01T12:00:00Z' },
  ] };
  assert.deepEqual(topNewLeads(payload, { now: NOW }).map(row => row.id), ['eligible', 'returned']);
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
test('held deal tasks stay out of every Home agenda until the hold date', () => {
  const tasks = [
    { id: 'held', status: 'open', due_on: '2026-09-30', hold_until: '2027-01-01', owner: 'joe' },
    { id: 'released', status: 'open', due_on: '2026-09-30', hold_until: '2026-10-01', owner: 'joe' },
    { id: 'expired', status: 'open', due_on: null, hold_until: '2026-09-30', owner: 'joe' },
    { id: 'post-call', status: 'open', due_on: '2026-10-02', hold_until: null, owner: 'joe' },
  ];
  const details = new Map([['demo-a', { critical_dates: [], next_actions: tasks }]]);
  for (const scope of ['team', 'mine']) {
    const view = agendaSnapshot(board, details, { scope, today: '2026-10-01' });
    assert.deepEqual(view.entries.map(row => row.key), ['task:released', 'task:expired', 'task:post-call']);
    assert.ok(!view.week.flatMap(day => day.entries).some(row => row.key === 'task:held'));
    assert.ok(!view.upcoming.some(row => row.key === 'task:held'));
  }
  assert.equal(details.get('demo-a').next_actions[0].hold_until, '2027-01-01');
  assert.ok(agendaSnapshot(board, details, { today: '2027-01-01' }).entries.some(row => row.key === 'task:held'));
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
test('Home refuses malformed or mixed board and lead reads before publishing success', async t => {
  for (const [name, values] of [
    ['board', [{}, { deals: {} }, { deals: [{ name: 'Missing identity' }] }, { deals: [board.deals[0], null] }, { deals: [board.deals[0], { id: ' ' }] }]],
    ['leads', [{}, { leads: {} }, { leads: [{ score: 90 }] }, { leads: [{ id: 'demo-lead' }, null] }, { leads: [{ id: ' ' }] }]],
  ]) for (const value of values) await t.test(`${name}: ${JSON.stringify(value)}`, async () => {
    const client = await fixtureClient();
    client.getHomeAgenda = async () => name === 'board' ? value : board;
    client.getLeadBoard = async () => name === 'leads' ? value : { leads: [] };
    const publications = [];
    const result = await readHomeDashboard(client, { onUpdate: result => publications.push(result.reads[name].state) });
    assert.equal(result.reads[name].state, 'error');
    assert.equal(result.reads[name].code, 'malformed_response');
    assert.equal(result[name], null);
    assert.ok(!publications.includes('read'), 'malformed values never become successful publications');
    assert.equal(result.loading, false);
    if (name === 'board') assert.equal(result.details.size, 0);
  });
});

test('Home accepts verified empty feeds without treating them as malformed', async () => {
  const client = await fixtureClient();
  client.getHomeAgenda = async () => ({ schema_version: 'home-agenda.v1', actor: 'joe', deals: [] });
  client.getLeadBoard = async () => ({ leads: [] });
  const result = await readHomeDashboard(client);
  assert.equal(result.reads.board.state, 'read');
  assert.equal(result.reads.leads.state, 'read');
  assert.equal(dealSnapshot(result.board).active, 0);
  assert.deepEqual(topNewLeads(result.leads), []);
});

test('PR124 R2 malformed Home boards never publish a successful read or authoritative counts', async () => {
  const client = await fixtureClient();
  const valid = await client.getHomeAgenda();
  let detailReads = 0;
  client.getDeal = async () => { detailReads++; return { critical_dates: [], next_actions: [] }; };
  for (const invalid of [null, {}, { deals: {} }, { deals: [null] }, { deals: [[]] },
    { deals: [{ name: 'Demo missing ID' }] }, { deals: [{ id: '' }] }, { deals: [{ id: '  ' }] },
    { ...valid, deals: [...valid.deals, { name: 'Demo missing ID' }] }]) {
    client.getHomeAgenda = async () => invalid;
    const published = [];
    const result = await readHomeDashboard(client, { onUpdate: result => published.push(result.reads.board.state) });
    assert.equal(result.reads.board.state, 'error', JSON.stringify(invalid));
    assert.equal(result.board, null);
    assert.equal(dealSnapshot(invalid), null);
    assert.equal(agendaSnapshot(invalid, new Map()), null);
    assert.ok(!published.includes('read'));
  }
  assert.equal(detailReads, 0, 'malformed identities cannot start detail reads');
  client.getHomeAgenda = async () => ({ ...valid, deals: [] });
  const empty = await readHomeDashboard(client);
  assert.equal(empty.reads.board.state, 'read');
  assert.equal(dealSnapshot(empty.board).active, 0, 'validated empty boards retain zero counts');
});
test('malformed board identity is unavailable, never a verified empty workload', async t => {
  const fixture = await fixtureClient();
  for (const deals of [[{}], [{ id: '' }], [{ id: '  ' }], [null], [board.deals[0], {}]]) {
    await t.test(JSON.stringify(deals), async () => {
      const payload = { actor: 'joe', deals };
      const live = createLiveClient({ fetchImpl: async () => new Response(JSON.stringify({
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      })) });
      const client = { ...fixture, getHomeAgenda: options => live.getHomeAgenda(options), getLeadBoard: async () => ({ leads: [] }) };
      const result = await readHomeDashboard(client);
      assert.equal(result.board, null);
      assert.equal(result.reads.board.state, 'error');
      assert.equal(result.details.size, 0);
      assert.equal(dealSnapshot(payload), null);
      assert.equal(agendaSnapshot(payload, new Map()), null);
      assert.equal(result.reads.leads.state, 'read', 'independent reads remain available');
    });
  }
  const empty = { schema_version: 'home-agenda.v1', actor: 'joe', deals: [] };
  const result = await readHomeDashboard({ ...fixture, getHomeAgenda: async () => empty, getLeadBoard: async () => ({ leads: [] }) });
  assert.equal(result.reads.board.state, 'read');
  assert.deepEqual(dealSnapshot(result.board), { active: 0, inMarket: 0, national: 0, flagged: [] });
});
test('Home publishes independent ready data with one agenda read and never invents failed data', async () => {
  let boardReads = 0;
  const seen = [];
  const client = { getHomeAgenda: async () => { boardReads++; return board; }, getLeadBoard: async () => ({ leads: [] }),
    getDeal: async () => assert.fail('no eager complete records'),
    incidentBoard: async () => ({ count: 0, incidents: [], by_severity: {}, ready_to_close: 0 }),
    currentWorkItem: async () => { throw Error('Unavailable'); }, currentWorkRequests: async () => null,
    readResourceDashboard: async () => null, scheduleBoard: async () => null };
  const result = await readHomeDashboard(client, { onUpdate: result => seen.push(Boolean(result.board)) });
  assert.equal(boardReads, 1); assert.ok(seen.includes(true));
  assert.deepEqual(agendaSnapshot(result.board, result.details).failed, ['demo-a', 'demo-b']);
  assert.equal(result.control.work, null);
  assert.equal(controlSnapshot(result.control).attention, true);
  client.getHomeAgenda = async () => { const error = Error('Signed out'); error.status = 401; throw error; };
  assert.equal((await readHomeDashboard(client)).unauthorized, true);
  client.getHomeAgenda = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await readHomeDashboard(client, { timeoutMs: 10 })).board, null);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(Object.keys(HIDDEN_HOME_WIDGETS), ['vendors', 'listings', 'capture']);
});

test('Home rejects incompatible agenda versions, missing actors and duplicate deal identities', async () => {
  const client = await fixtureClient();
  const valid = await client.getHomeAgenda();
  for (const invalid of [{ ...valid, schema_version: 'home-agenda.v2' }, { ...valid, actor: null },
    { ...valid, deals: [valid.deals[0], valid.deals[0]] }]) {
    client.getHomeAgenda = async () => invalid;
    const result = await readHomeDashboard(client);
    assert.equal(result.reads.board.state, 'error');
    assert.equal(result.board, null);
    assert.equal(result.details.size, 0);
  }
});


test('Home reads business feeds without reading Control Room queues', async () => {
  const client = await fixtureClient();
  const systemReads = [];
  for (const method of ['incidentBoard', 'currentWorkItem', 'currentWorkRequests', 'readResourceDashboard', 'scheduleBoard']) {
    client[method] = async () => { systemReads.push(method); throw Error('System data unavailable'); };
  }
  const result = await readHomeDashboard(client);
  assert.deepEqual(systemReads, []);
  for (const key of ['board', 'leads', 'invoices', 'relationships']) assert.equal(result.reads[key].state, 'read', key);
  assert.equal(result.unauthorized, false);
});
