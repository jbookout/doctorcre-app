import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBoundary } from '../js/private-session.js';
const session = actor => ({actor:{slug:actor},csrf_token:`synthetic-${actor}`});
const defer = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
for(const change of ['switch-user','renew-session']) test(`F01: ${change} clears the view and refuses an old editor's mutation before sending`,async()=>{
 let identity=session('joe'),visible=['Joe private title'],sent=0;
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:async(path)=>{
   if(path==='/auth/session')return Response.json(identity);
   sent++;return Response.json({private:'Joe content'});
 }});
 await boundary.fetch('/api/private');assert.equal(sent,1);
 identity=change==='switch-user'?session('dell'):{...session('joe'),csrf_token:'synthetic-renewed'};
 await assert.rejects(boundary.fetch('/mcp',{method:'POST',body:'old editor intent'}),{code:'authentication_required'});
 assert.deepEqual(visible,[]);assert.equal(sent,1);
});
test('F01: a newer denial aborts pending reads, and a transport ignoring abort cannot return its old private payload',async()=>{
 let visible=['Joe private title'],pending=defer(),signal;
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:async(path,init)=>{
   if(path==='/auth/session')return Response.json(session('joe'));
   if(path==='/denied')return new Response('{}',{status:403});
   signal=init.signal;return pending.promise;
 }});
 const old=boundary.fetch('/old');
 await new Promise(r=>setTimeout(r,0));
 await assert.rejects(boundary.fetch('/denied'),{code:'authentication_required'});
 assert.equal(signal.aborted,true);assert.deepEqual(visible,[]);
 pending.resolve(Response.json({private:'Joe late content'}));
 await assert.rejects(old,{code:'authentication_required'});
});
test('F01: cookie change during a read cannot paint the new actor under the old view',async()=>{
 let identity=session('joe'),visible=['Joe private title'];
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:async path=>{
   if(path==='/auth/session')return Response.json(identity);
   identity=session('dell');return Response.json({private:'Dell content'});
 }});
 await assert.rejects(boundary.fetch('/api/private'),{code:'authentication_required'});
 assert.deepEqual(visible,[]);
});
test('F01: a same-session network outage does not revoke the view or misclassify it as sign-out',async()=>{
 let invalidated=false;
 const boundary=createSessionBoundary({invalidate(){invalidated=true;},fetchImpl:async path=>{
   if(path==='/auth/session')return Response.json(session('joe'));
   throw Error('offline');
 }});
 await assert.rejects(boundary.fetch('/api/private'),/offline/);
 assert.equal(invalidated,false);
});
for(const code of ['forbidden','AUTHORIZATION_REFUSED','AUTHENTICATION_REQUIRED']) test(`F01: explicit MCP ${code} revokes every view even with HTTP 200`,async()=>{
 let invalidated=false;
 const boundary=createSessionBoundary({invalidate(){invalidated=true;},fetchImpl:async path=>path==='/auth/session'?Response.json(session('joe')):Response.json({result:{isError:true,content:[{type:'text',text:JSON.stringify({error:code})}]}})});
 await assert.rejects(boundary.fetch('/mcp'),{code:'authentication_required'});assert.equal(invalidated,true);
});
test('public Status may start signed out, but loses the whole authenticated view after a verified session is denied',async()=>{
 let signedIn=false,invalidated=false;
 const boundary=createSessionBoundary({anonymousDiagnostics:true,invalidate(){invalidated=true;},fetchImpl:async()=>signedIn?Response.json(session('joe')):new Response('{}',{status:401})});
 await assert.rejects(boundary.verify(),{code:'authentication_required'});assert.equal(invalidated,false);
 signedIn=true;await boundary.verify();signedIn=false;
 await assert.rejects(boundary.verify(),{code:'authentication_required'});assert.equal(invalidated,true);
});

test('F01: Model Room mutation stays bound to the session verified before the cookie switches', async () => {
 const { createLiveClient } = await import('../js/live-client.js');
 const { composerRequest } = await import('../js/model-room-model.js');
 let identity = session('joe');
 const effects = [];
 const boundary = createSessionBoundary({ invalidate() {}, fetchImpl: async (path, init) => {
   if (path === '/auth/session') return Response.json(identity);
   identity = session('dell');
   if (new Headers(init.headers).has('x-carr-csrf') && new Headers(init.headers).get('x-carr-csrf') !== identity.csrf_token) return Response.json({error:'forbidden'}, {status:403});
   effects.push(identity.actor.slug);
   return Response.json({result:{content:[{type:'text',text:JSON.stringify({ok:true})}]}});
 }});
 const client = createLiveClient({fetchImpl:(...args) => boundary.fetch(...args)});
 await assert.rejects(client.addRoomTurn(composerRequest({text:'Synthetic editor intent'})));
 assert.deepEqual(effects, []);
 assert.equal(boundary.revoked, true);
});

test('F01: a completed private read cannot join an identity check started before its response', async () => {
 const oldRead = defer(), staleIdentity = defer(), started = defer();
 let identity = session('joe'), checks = 0;
 const boundary = createSessionBoundary({invalidate() {}, fetchImpl: async path => {
   if (path === '/auth/session') {
     checks++;
     if (checks === 2) { started.resolve(); return staleIdentity.promise; }
     return Response.json(identity);
   }
   return oldRead.promise;
 }});
 const first = assert.rejects(boundary.fetch('/private-title'), {code:'authentication_required'});
 await new Promise(resolve => setTimeout(resolve, 0));
 const overlapping = boundary.verify();
 await started.promise;
 identity = session('dell');
 oldRead.resolve(Response.json({title:'Synthetic private title'}));
 await new Promise(resolve => setTimeout(resolve, 0));
 staleIdentity.resolve(Response.json(session('joe')));
 await overlapping.catch(() => {});
 await first;
 assert.equal(boundary.revoked, true);
});

test('F01: a retained operation cannot replace its original session token with the current one', async () => {
 let sent = 0;
 const boundary = createSessionBoundary({invalidate() {}, fetchImpl:async path => {
   if (path === '/auth/session') return Response.json(session('dell'));
   sent++; return Response.json({ok:true});
 }});
 await assert.rejects(boundary.fetch('/mcp', {method:'POST', headers:{'x-carr-csrf':'synthetic-joe'}}), {code:'authentication_required'});
 assert.equal(sent, 0);
});
