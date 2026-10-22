import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFixtureClient} from '../js/fixture-client.js';
import {createLiveClient} from '../js/live-client.js';
import {agendaSnapshot, readHomeDashboard} from '../js/home-dashboard-model.js';

const fixture = async () => createFixtureClient({seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`});

test('bounded Home agenda preserves legacy fixture membership for team and mine without opening records', async () => {
  const client = await fixture();
  const board = await client.getBoard();
  const details = new Map(await Promise.all(board.deals.map(async d => [d.id, await client.getDeal(d.id)])));
  client.getDeal = async () => assert.fail('Home must not open complete records');
  const result = await readHomeDashboard(client);
  assert.equal(result.reads.board.state, 'read');
  for (const scope of ['team', 'mine']) assert.deepEqual(
    agendaSnapshot(result.board, result.details, {scope, today: '2026-10-01'}),
    agendaSnapshot(board, details, {scope, today: '2026-10-01'}));
});

test('Home uses the agenda contract on initial load and refresh and keeps full detail explicit', async () => {
  const fixtureClient = await fixture();
  const payload = await fixtureClient.getHomeAgenda();
  const calls = [];
  const live = createLiveClient({fetchImpl: async (_url, options) => {
    const rpc = JSON.parse(options.body); calls.push(rpc.params.name);
    return new Response(JSON.stringify({result:{content:[{type:'text',text:JSON.stringify(payload)}]}}));
  }});
  const client = {...fixtureClient, getHomeAgenda: options => live.getHomeAgenda(options), getDeal: () => assert.fail('eager detail')};
  for (let i = 0; i < 2; i++) assert.equal((await readHomeDashboard(client)).reads.board.state, 'read');
  assert.deepEqual(calls, ['read-home-agenda', 'read-home-agenda']);
  assert.equal((await fixtureClient.getDeal(payload.deals[0].id)).deal.id, payload.deals[0].id);
});

test('agenda holds resume on their date and preserve owner, parked, closed, national and undated rules', () => {
  const deals = [
    {id:'local',owner:'joe',name:'Demo Local'},
    {id:'national',owner:'joe',name:'Demo National',workspace_kind:'national_account',account_client_id:'demo-account'},
    {id:'parked',owner:'joe',operating_state:'parked'},
    {id:'closed',owner:'joe',phase:'Closed'},
    {id:'outcome',owner:'joe',outcome:'lost'},
    {id:'invoice',owner:'joe',invoiced_on:'2026-09-01'},
    {id:'other',owner:'dell'},
  ];
  const tasks = [
    {id:'held',status:'open',owner:'joe',hold_until:'2026-10-02'},
    {id:'resumed',status:'open',owner:'joe',hold_until:'2026-10-01'},
    {id:'past',status:'open',owner:'joe',hold_until:'2026-09-30'},
    {id:'done',status:'done',owner:'joe'},
    {id:'other-owner',status:'open',owner:'dell'},
  ];
  const details = new Map(deals.map(d => [d.id,{critical_dates:[{id:`date-${d.id}`,due_on:'2026-10-03',status:'open'},{id:`bad-${d.id}`,due_on:'bad'}],next_actions:tasks.map(t=>({...t,id:`${d.id}-${t.id}`}))}]));
  const mine = agendaSnapshot({actor:'joe',deals}, details, {scope:'mine',today:'2026-10-01'});
  assert.deepEqual(mine.entries.map(e=>e.key).sort(), ['date-local','date-national','task:local-past','task:local-resumed','task:national-past','task:national-resumed'].sort());
  assert.equal(mine.undated.length,2);
});

test('Home agenda remains available to Doc through the same authorized read', async () => {
  const {createDocContext} = await import('../js/doc-context-model.js');
  const context = createDocContext({page:'home'});
  const payload = await (await fixture()).getHomeAgenda();
  assert.equal(context.finish(context.begin('getHomeAgenda'), payload), true);
  assert.equal(context.snapshot().records.some(row => row.id === payload.deals[0].id), true);
});
