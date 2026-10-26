import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';

for (const [name, arguments_] of [
  ['set-next-step', {text:''}],
  ['add-critical-date', {kind:'notice',due_on:'2026-10-12',source:''}],
  ['update-deal', {base_version:1,fields:{outcome:'invalid'}}],
  ['patch-deal-field', {field:'phase',value:'legal',base_event_id:null}],
  ['add-deal-note', {text:'Synthetic note'}],
  ['claim-lead', {lead:'L-1',base_version:1}],
  ['update-lead', {lead:'L-1',base_version:1,fields:{stage:'qualified'}}],
]) test(`PR182 QA explicitly refuses unsupported ${name} without changing state`, async () => {
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
  assert.deepEqual(result,{isError:true,payload:{error:'fixture_operation_unavailable'}});
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

test('QA Home agenda reads the signed-in namespace through the current contract', async () => {
  const {dispatch} = await createQaServer();
  const seed = await dispatch(new Request('http://localhost/api/test/seed', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({namespace:'home-agenda',viewer:'dell',reset:true}),
  }));
  const {cookie} = await seed.json();
  const response = await dispatch(new Request('http://localhost/mcp', {
    method:'POST', headers:{cookie:`${cookie.name}=${cookie.value}`,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read-home-agenda',arguments:{}}}),
  }));
  const {result} = await response.json();
  assert.notEqual(result.isError, true);
  const agenda = JSON.parse(result.content[0].text);
  assert.equal(agenda.schema_version, 'home-agenda.v1');
  assert.equal(agenda.actor, 'dell');
  assert.equal(agenda.deals.length, 16);
  assert.equal(agenda.deals[0].id, 'qa-deal-1');
  assert.deepEqual(agenda.deals[0].critical_dates, []);
  assert.equal(agenda.deals[0].next_actions[0].id, 'action-qa-deal-1');
  assert.equal(agenda.deals[0].next_actions[0].hold_until, null);
  assert.equal(agenda.deals[0].thread, undefined);
});

for (const viewer of ['joe', 'dell']) test(`QA authenticated session identifies synthetic ${viewer}`, async () => {
  const { dispatch } = await createQaServer();
  const origin = 'http://localhost';
  assert.equal((await dispatch(new Request(`${origin}/api/system-work/session`))).status, 401);
  const response = await dispatch(new Request(`${origin}/api/test/seed`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: `session-${viewer}`, viewer }) }));
  const { cookie } = await response.json();
  const session = await dispatch(new Request(`${origin}/api/system-work/session`, {
    headers: { cookie: `${cookie.name}=${cookie.value}` } }));
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { actor: { slug: viewer } });

});

test('QA Home agenda reads the signed-in namespace through the current contract', async () => {
  const {dispatch} = await createQaServer();
  const seed = await dispatch(new Request('http://localhost/api/test/seed', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({namespace:'home-agenda',viewer:'dell',reset:true}),
  }));
  const {cookie} = await seed.json();
  const response = await dispatch(new Request('http://localhost/mcp', {
    method:'POST', headers:{cookie:`${cookie.name}=${cookie.value}`,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read-home-agenda',arguments:{}}}),
  }));
  const {result} = await response.json();
  assert.notEqual(result.isError, true);
  const agenda = JSON.parse(result.content[0].text);
  assert.equal(agenda.schema_version, 'home-agenda.v1');
  assert.equal(agenda.actor, 'dell');
  assert.equal(agenda.deals.length, 16);
  assert.equal(agenda.deals[0].id, 'qa-deal-1');
  assert.deepEqual(agenda.deals[0].critical_dates, []);
  assert.equal(agenda.deals[0].next_actions[0].id, 'action-qa-deal-1');
  assert.equal(agenda.deals[0].next_actions[0].hold_until, null);
  assert.equal(agenda.deals[0].thread, undefined);
});
