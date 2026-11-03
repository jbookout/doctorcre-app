import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { readFile } from 'node:fs/promises';
test('fixture contract replays one canonical turn and refuses changed arguments', async () => {
 const seedUrl=`data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json',import.meta.url))).toString('base64')}`;
 const client=await createFixtureClient({seedUrl,selfActor:'joe'});
 const request={conversation_id:'0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01',idempotency_key:'22222222-2222-4222-8222-222222222222',body:'Synthetic ask'};
 const first=await client.submitDocRequest(request,'joe');assert.deepEqual(await client.submitDocRequest(request,'joe'),first);
 const read=await client.readDocConversation({conversation_id:request.conversation_id});
 assert.equal(read.turns.filter(turn=>turn.msg_id===request.idempotency_key).length,1);
 await assert.rejects(client.submitDocRequest({...request,body:'Changed'},'joe'),/idempotency_key_reused/);
 assert.equal((await client.submitDocRequest(request,'dell')).status,'refused');
});
test('ask adapter binds every replay to the original actor and fresh CSRF, preserving request key', async () => {
  let actor='joe', fail=true;
  const calls=[];
  const client=createLiveClient({fetchImpl:async (path,init) => {
    if(path==='/auth/session') return Response.json({actor:{slug:actor},csrf_token:'synthetic'});
    const call=JSON.parse(init.body); calls.push({...call.params,csrf:init.headers['x-carr-csrf']});
    if(fail) throw Error('lost receipt');
    return Response.json({result:{content:[{text:JSON.stringify({ok:true})}]}});
  }});
  const request={conversation_id:'11111111-1111-4111-8111-111111111111',idempotency_key:'22222222-2222-4222-8222-222222222222',body:'Synthetic ask'};
  assert.deepEqual(await client.askSession(),{actor:'joe'});
  await assert.rejects(client.submitDocRequest(request,'joe'));
  actor='dell'; await assert.rejects(client.submitDocRequest(request,'joe'),/Session changed/); assert.equal(calls.length,1);
  actor='joe';fail=false;await client.submitDocRequest(request,'joe');
  assert.deepEqual(calls[0],calls[1]); assert.deepEqual(calls[0],{name:'submit-doc-request',arguments:request,csrf:'synthetic'});
});
