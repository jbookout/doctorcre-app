import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('S2 verified session reads always reach the network and never replay a cached principal',async()=>{
 const handlers=new Map(),puts=[];let offline=false;
 const cached=Response.json({actor:{slug:'synthetic-prior-partner'},csrf_token:'synthetic-prior-session'});
 const context=vm.createContext({URL,Response,self:{location:{origin:'https://example.test'},addEventListener:(name,handler)=>handlers.set(name,handler)},caches:{open:async()=>({put:async(...args)=>puts.push(args)}),match:async()=>cached},fetch:async()=>{
  if(offline)throw new Error('network unavailable');return Response.json({actor:{slug:'synthetic-current-partner'},csrf_token:'synthetic-current-session'},{headers:{'cache-control':'no-store'}});
 }});
 vm.runInContext(await readFile(new URL('../public-shell/sw.js',import.meta.url),'utf8'),context);
 const read=async()=>{let answer;handlers.get('fetch')({request:new Request('https://example.test/auth/session'),respondWith:value=>{answer=value;}});return answer;};
 const current=await read();assert.equal((await current.json()).actor.slug,'synthetic-current-partner');assert.equal(puts.length,0);
 offline=true;const unavailable=await read();assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).error,'offline');assert.equal(puts.length,0);
});
