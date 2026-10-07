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
