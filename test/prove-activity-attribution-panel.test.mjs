import test from 'node:test';
import assert from 'node:assert/strict';
import {prove} from '../scripts/prove-activity-attribution-panel.mjs';
const expected='a'.repeat(40),descendant='b'.repeat(40);
function setup(overrides={}){
 let alive=0,closed=0;
 const browser={newPage:async()=>({}),close:async()=>{alive=0;closed++;}};
 const engine={launch:async()=>{alive++;return browser;}};
 return {options:{origin:'http://localhost',expectedCommit:expected,timeoutMs:1000,engine,readRelease:async()=>({source_commit:expected}),observe:async()=>({assertions:['synthetic natural observation']}),...overrides},alive:()=>alive,closed:()=>closed};
}
for(const relation of ['equal','descendant','older','unrelated','unknown'])test(`proof requires ${relation} release containment`,async()=>{
 const s=setup({readRelease:async()=>({source_commit:relation==='equal'?expected:descendant}),contains:async(a,b)=>{assert.equal(a,expected);if(!['equal','descendant'].includes(relation))throw Error('No ancestry evidence');}});
 const result=await prove(s.options);assert.equal(result.exitCode,['equal','descendant'].includes(relation)?0:78);assert.equal(s.alive(),0);
});
test('containing release assertion failure exits 1 and closes acquired browser',async()=>{
 const s=setup({contains:async()=>{},observe:async()=>{throw Error('synthetic incorrect credit');}});const result=await prove(s.options);assert.equal(result.exitCode,1);assert.equal(s.alive(),0);
});
test('missing session and missing subject are insufficient evidence',async()=>{
 for(const reason of ['No session','No activity']){
  const s=setup({contains:async()=>{},observe:async()=>{throw Object.assign(Error(reason),{exitCode:78});}});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
 }
});
test('release change refuses a previously containing proof',async()=>{
 let calls=0;const s=setup({contains:async()=>{},readRelease:async()=>({source_commit:++calls===1?expected:descendant})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
});
test('stalled evaluation exits 78 with no surviving acquired browser',async()=>{
 const s=setup({contains:async()=>{},timeoutMs:25,observe:()=>new Promise(()=>{})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);assert.ok(s.closed()>=1);
});
test('late launch exits 78 and closes the late acquired browser',async()=>{
 let alive=0,release;
 const pending=new Promise(resolve=>release=resolve);
 const s=setup({contains:async()=>{},timeoutMs:25,engine:{launch:()=>pending}});
 const result=await prove(s.options);assert.equal(result.exitCode,78);
 alive++;release({close:async()=>alive--});
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(alive,0);
});
test('release read shares the total deadline',async()=>{
 const s=setup({timeoutMs:25,readRelease:()=>new Promise(()=>{})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
});
test('actual stalled browser evaluation is closed at the total deadline',async()=>{
 const {chromium}=await import('../scripts/proof-browser.mjs');let acquired;
 const s=setup({timeoutMs:3000,contains:async()=>{},engine:{launch:async options=>acquired=await chromium.launch(options)},observe:page=>page.evaluate(()=>new Promise(()=>{}))});
 assert.equal((await prove(s.options)).exitCode,78);assert.ok(acquired);assert.equal(acquired.isConnected(),false);
});
test('actual late browser acquisition closes after deadline without leaving its process alive',async()=>{
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const acquired=await chromium.launch();let resolve;
 const pending=new Promise(r=>resolve=r);
 try{
  const s=setup({timeoutMs:25,contains:async()=>{},engine:{launch:()=>pending}});
  assert.equal((await prove(s.options)).exitCode,78);
  const closed=new Promise(r=>acquired.once('disconnected',r));resolve(acquired);await closed;
  assert.equal(acquired.isConnected(),false);
 }finally{await acquired.close();}
});
