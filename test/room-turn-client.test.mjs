import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomTurnClient } from '../js/room-turn-client.js';

test('S2 room timeout across minute boundaries replays the original request exactly once', async () => {
  const calls=[],receipts=new Map();let keys=0,commits=0,lost=true,now=59_999;
  const client=createRoomTurnClient({newKey:()=>`request-${++keys}`,session:async()=> 'synthetic-session-a',fetchImpl:async(_path,init)=>{
    const body=JSON.parse(init.body);calls.push({body,csrf:init.headers['x-carr-csrf'],now});
    if(!receipts.has(body.idempotency_key)){commits++;receipts.set(body.idempotency_key,{ok:true,seq:commits});}
    if(lost){lost=false;throw new Error('committed response lost');}
    return Response.json(receipts.get(body.idempotency_key));
  }});
  await assert.rejects(client.send('composer',{body:'Original command'}),/lost/);
  now=120_001;
  await assert.rejects(client.send('composer',{body:'Different command'}),/earlier|unresolved|unconfirmed/i);
  assert.equal(calls.length,1);
  const result=await client.send('composer',{body:'Original command'});
  assert.deepEqual(calls[1].body,calls[0].body);assert.equal(result.seq,1);assert.equal(commits,1);assert.equal(keys,1);
  await client.send('composer',{body:'Original command'});
  assert.equal(commits,2,'a reviewed independent repeat has a new identity');
});

test('S2 room unknown failure with HTTP 503 retains key while a 400 refusal permits correction',async()=>{
 let fail=503,keys=0;const calls=[];
 const client=createRoomTurnClient({newKey:()=>`request-${++keys}`,session:async()=> 'synthetic-session-a',fetchImpl:async(_path,init)=>{
  calls.push(JSON.parse(init.body));return fail?Response.json({error:fail===400?'body_required':'wire_unavailable'},{status:fail}):Response.json({ok:true,seq:1});
 }});
 await assert.rejects(client.send('queue',{body:'Queue command'}),error=>error.status===503);
 assert.ok(client.pending('queue'));
 fail=0;await client.send('queue',{body:'Queue command'});assert.deepEqual(calls[1],calls[0]);
 fail=400;await assert.rejects(client.send('queue',{body:'Bad command'}));assert.equal(client.pending('queue'),null);
 fail=0;await client.send('queue',{body:'Corrected command'});assert.notEqual(calls[3].idempotency_key,calls[2].idempotency_key);
});

test('S2 room cannot replay a retained operation under a different session',async()=>{
 let binding='synthetic-session-a',sends=0;
 const client=createRoomTurnClient({session:async()=>binding,fetchImpl:async()=>{sends++;throw new Error('lost');}});
 await assert.rejects(client.send('composer',{body:'Original command'}));
 binding='synthetic-session-b';await assert.rejects(client.send('composer',{body:'Original command'}),/session/i);
 assert.equal(sends,1);
});

test('S2 a real room deadline after commit keeps the UUID for the receipt retry',async()=>{
 const calls=[],receipts=new Map();let first=true;
 const client=createRoomTurnClient({timeoutMs:5,session:async()=> 'synthetic-session-a',fetchImpl:async(_path,init)=>{
  const body=JSON.parse(init.body);calls.push(body);
  if(!receipts.has(body.idempotency_key))receipts.set(body.idempotency_key,{ok:true,seq:1});
  if(first){first=false;return new Promise(()=>{});}return Response.json(receipts.get(body.idempotency_key));
 }});
 await assert.rejects(client.send('composer',{body:'Original turn'}),/timed out/i);
 await client.send('composer',{body:'Original turn'});
 assert.deepEqual(calls[1],calls[0]);assert.equal(receipts.size,1);
});
