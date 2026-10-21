import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { PHASES } from '../js/client.js';

test('signed-in live creation persists the selected owner and attributed initial note across partner reads', async () => {
  const {dispatch} = await createQaServer();
  const origin = 'http://localhost';
  const clientFor = async (viewer,namespace='shared-deals') => {
    const response = await dispatch(new Request(`${origin}/api/test/seed`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace,viewer})}));
    const {cookie} = await response.json();
    return createLiveClient({selfActor:viewer,fetchImpl:(path,init={}) => dispatch(new Request(new URL(path,origin),{...init,headers:{...init.headers,cookie:`${cookie.name}=${cookie.value}`}}))});
  };
  const joe = await clientFor('joe');
  const request = {name:'Demo Shared Deal',client:'C-demo',phase:'Research',owner:'dell',notes:'Demo initial note',idempotency_key:'shared-create'};
  const created = await joe.createDeal(request);
  assert.equal(created.status,'ok');
  const board = await joe.getBoard();
  assert.equal(board.deals.length,17);
  const seeded = board.deals.find(deal => deal.id === 'qa-deal-1');
  assert.equal(seeded.prospect_engagement_status,'active');
  assert.equal(seeded.client_version,1);
  assert.deepEqual(seeded.phase_started_on,{});
  const dell = await clientFor('dell');
  const detail = await dell.getDeal(created.deal_id);
  assert.equal(detail.deal.owner,'dell');
  assert.equal(detail.deal.phase,'Research');
  assert.equal(detail.thread.length,1);
  assert.equal(detail.thread[0].text,'Demo initial note');
  assert.equal(detail.thread[0].actor,'joe');
  assert.ok(Number.isFinite(Date.parse(detail.thread[0].recorded_at)));
  const isolated = await clientFor('joe','isolated-deals');
  assert.equal((await isolated.getBoard()).deals.length,16);
  assert.ok(!(await isolated.getBoard()).deals.some(deal => deal.id === created.deal_id));
});

test('fixture creation validates phases before mutation and preserves every known phase and default', async () => {
  const client = await createFixtureClient({seedUrl:`data:application/json,${encodeURIComponent(JSON.stringify({deals:[]}))}`});
  const request = {name:'Demo Fixture Phase',phase:'not-a-phase',idempotency_key:'fixture-phase'};
  await assert.rejects(client.createDeal(request), error => error.payload?.error === 'unknown_phase');
  assert.deepEqual((await client.getBoard()).deals,[]);
  assert.deepEqual((await client.getChanges(null)).events,[]);
  const corrected = await client.createDeal({...request,phase:'Research'});
  assert.equal(corrected.deal.id,'d-new-1');
  for (const phase of PHASES) {
    const created = await client.createDeal({name:`Demo ${phase}`,phase,idempotency_key:`fixture-${phase}`});
    assert.equal((await client.getDeal(created.deal.id)).deal.phase,phase);
  }
  for (const phase of [undefined,null,'']) {
    const created = await client.createDeal({name:'Demo Default',phase,idempotency_key:`default-${phase}`});
    assert.equal(created.deal.phase,'On Deck');
  }
});

test('QA rejects an unknown creation phase without writes and permits a corrected-key retry', async () => {
  const {dispatch} = await createQaServer();
  const origin = 'http://localhost';
  const clientFor = async viewer => {
    const response = await dispatch(new Request(`${origin}/api/test/seed`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'phase-validation',viewer})}));
    const {cookie} = await response.json();
    const fetchImpl = (path,init={}) => dispatch(new Request(new URL(path,origin),{...init,headers:{...init.headers,cookie:`${cookie.name}=${cookie.value}`}}));
    return {client:createLiveClient({selfActor:viewer,fetchImpl}),fetchImpl};
  };
  const {client:joe,fetchImpl} = await clientFor('joe');
  const before = (await joe.getBoard()).deals;
  const request = {name:'Demo Phase Retry',phase:'not-a-phase',idempotency_key:'phase-retry'};
  await assert.rejects(joe.createDeal(request), error => error.payload?.error === 'unknown_phase' && error.creationRefused === true);
  assert.deepEqual((await joe.getBoard()).deals,before);
  assert.deepEqual((await (await fetchImpl('/pipeline/changes')).json()).events,[]);
  const corrected = {...request,phase:'Research'};
  const created = await joe.createDeal(corrected);
  assert.equal(created.deal_id,'d-new-1','a refused phase consumes no deal or event identity');
  const {client:reloaded} = await clientFor('joe');
  assert.equal((await reloaded.createDeal(corrected)).deal_id,created.deal_id);
  const defaulted = await joe.createDeal({name:'Demo Default Phase',idempotency_key:'phase-default'});
  const {client:dell} = await clientFor('dell');
  assert.equal((await dell.getDeal(created.deal_id)).deal.phase,'Research');
  assert.equal((await dell.getDeal(defaulted.deal_id)).deal.phase,'On Deck');
  assert.equal((await dell.getBoard()).deals.length,before.length+2);
});

for (const [name, arguments_, error] of [
  ['new-deal', {name:''}, 'empty name'],
  ['set-next-step', {text:''}, 'empty next step'],
  ['add-critical-date', {kind:'notice',due_on:'2026-10-12',source:''}, 'critical date source required'],
  ['update-deal', {base_version:1,fields:{outcome:'invalid'}}, 'deal_outcome_check'],
  ['patch-deal-field', {field:'phase',value:'invalid',base_event_id:null}, 'bad phase invalid'],
  ['add-deal-note', {text:''}, 'empty note'],
  ['set-lead', {new_lead:'dell'}, 'missing_base_version'],
  ['set-lead', {new_lead:'dell',base_version:99}, 'version_conflict'],
  ['set-lead', {new_lead:'invalid',base_version:1}, 'unknown_actor'],
  ['claim-lead', {lead:'L-1',base_version:1}, 'fixture_operation_unavailable'],
  ['update-lead', {lead:'L-1',base_version:1,fields:{stage:'qualified'}}, 'fixture_operation_unavailable'],
]) test(`QA refuses invalid or unsupported ${name} (${error}) without changing state`, async () => {
  const {dispatch} = await createQaServer();
  const origin = 'http://localhost';
  const seeded = await dispatch(new Request(`${origin}/api/test/seed`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'refusal',reset:true})}));
  const {cookie} = await seeded.json();
  const call = async (name,args={}) => {
    const response = await dispatch(new Request(`${origin}/mcp`,{method:'POST',headers:{cookie:`${cookie.name}=${cookie.value}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
    const {result} = await response.json();
    return {isError:result.isError===true,payload:JSON.parse(result.content[0].text)};
  };
  const before = await call('get-deal-room',{deal:'qa-deal-1'});
  const leads = await call('lead-board');
  const result = await call(name,{deal:'qa-deal-1',idempotency_key:'synthetic-refusal',...arguments_});
  assert.equal(result.isError,true);
  assert.equal(result.payload.error,error);
  assert.deepEqual(await call('get-deal-room',{deal:'qa-deal-1'}),before);
  assert.deepEqual((await call('lead-board')).payload.leads,leads.payload.leads);
  const changes = await dispatch(new Request(`${origin}/pipeline/changes`,{headers:{cookie:`${cookie.name}=${cookie.value}`}}));
  assert.deepEqual((await changes.json()).events,[]);
});

test('QA seed provides a populated namespace-isolated synthetic shared tour', async () => {
  const { dispatch } = await createQaServer();
  const origin = 'http://localhost';
  const seed = async namespace => {
    const response = await dispatch(new Request(`${origin}/api/test/seed`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({namespace, reset:true}) }));
    return response.json();
  };
  const first = await seed('shared-tour');
  const headers = { cookie:`${first.cookie.name}=${first.cookie.value}` };
  const read = path => dispatch(new Request(`${origin}/api/share/${path}`, {headers}));
  const reportResponse = await read('report');
  assert.equal(reportResponse.status, 200);
  const {data:report} = await reportResponse.json();
  assert.equal(report.stops.length, 2);
  const {data:map} = await (await read('map')).json();
  assert.deepEqual(map.points.map(point => point.property_ref), report.stops.map(stop => stop.property_ref));
  const {data:feedback} = await (await read('feedback')).json();
  assert.deepEqual(feedback.permission_scopes, ['shortlist','comment']);
  assert.ok(feedback.items[0].comments[0].comment);
  assert.equal((await dispatch(new Request(`${origin}/api/share/report`))).status, 401);
  await seed('another-tour');
  assert.deepEqual((await (await read('report')).json()).data, report);
});
