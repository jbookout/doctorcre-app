import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveClient} from '../js/live-client.js';
import {groupSystemWork,recentLive,systemPipeline,triageWork} from '../js/system-work-board-model.js';
const row=(id,completed=false)=>({id,source:'public.loop_item',kind:'loop',title:`Synthetic ${id}`,state:completed?'done':'open',completed,
 opened_at:'2026-08-01T12:00:00Z',last_activity_at:`2026-09-${String(id+1).padStart(2,'0')}T12:00:00Z`,age:61,version:'1',
 available_triage_actions:completed?[]:[{action:'cancel',verb:'close-loop',args:{loop_id:String(id),resolution:'dropped'},fields:[{name:'outcome',label:'Why cancel?',required:true}],versioned:true}]});
const envelope=items=>({schema:'unfinished-work.v1',items,coverage:[]});
test('grouped sources preserve oldest-first incoming order; Live caps at ten',()=>{
 const items=Array.from({length:12},(_,i)=>row(i,true));
 assert.equal(groupSystemWork(items).length,1);assert.equal(recentLive(items).length,10);assert.equal(recentLive(items)[0].id,11);
 assert.equal(systemPipeline([],items).stages.find(s=>s.id==='live').tasks.length,10);
});
test('triage confirms and uses the fresh source version and correct verb',async()=>{
 const calls=[];const client={unfinishedWork:async args=>{calls.push(['read',args]);return envelope([{...row(1),version:'8'}]);},triageSystemWork:async(verb,args)=>{calls.push([verb,args]);return {ok:true};}};
 const r=await triageWork(client,row(1),'cancel',{outcome:'Synthetic stale concept'},{confirm:async()=>{calls.push(['confirm']);return true;},idempotencyKey:'synthetic-key'});
 assert.equal(r.result.ok,true);assert.deepEqual(calls.map(c=>c[0]),['read','confirm','close-loop']);
 assert.equal(calls[2][1].base_version,8);assert.equal(calls[2][1].resolution,'dropped');assert.equal(calls[2][1].loop_id,'1');
});
test('cancelled confirmation and changed availability never write',async()=>{
 let writes=0;const client={unfinishedWork:async()=>envelope([row(1)]),triageSystemWork:async()=>writes++};
 await triageWork(client,row(1),'cancel',{outcome:'Synthetic reason'},{confirm:()=>false,idempotencyKey:'synthetic-key'});assert.equal(writes,0);
 client.unfinishedWork=async()=>envelope([]);
 await assert.rejects(()=>triageWork(client,row(1),'cancel',{},{}),/no longer available/);assert.equal(writes,0);
});
test('live client pins source calls and retains explicit keys/versions',async()=>{
 const requests=[];const client=createLiveClient({fetchImpl:async(_p,init)=>{requests.push(JSON.parse(init.body).params);return new Response(JSON.stringify({result:{content:[{text:'{"ok":true}'}]}}));}});
 await client.unfinishedWork({live_library:true,text:'Synthetic older'});
 await client.triageSystemWork('close-loop',{base_version:8,idempotency_key:'synthetic-key',loop_id:'1',outcome:'Synthetic reason'});
 assert.equal(requests[0].name,'unfinished-work');assert.equal(requests[1].arguments.base_version,8);
 await assert.rejects(()=>client.triageSystemWork('unknown',{}),/Unsupported/);
});

test('retrieval approval binds the newly read proposal version map',async()=>{
 const item={...row(1),kind:'retrieval_proposal',source:'public.retrieval_proposal',version:'7',available_triage_actions:[{action:'progress',verb:'approve-retrieval-proposals',args:{proposal_ids:[1]},fields:[{name:'golden_suite_digest',label:'Verified suite',required:true}],versioned:true}]};
 const client={unfinishedWork:async()=>envelope([item]),triageSystemWork:async(_v,args)=>args};
 const result=await triageWork(client,item,'progress',{golden_suite_digest:'sha256:'+'1'.repeat(64)},{confirm:()=>true,idempotencyKey:'synthetic-key'});
 assert.deepEqual(result.result.base_versions,{'1':7});assert.equal(result.result.base_version,undefined);
});
test('investigation cancellation converts bounded confidence before source invocation',async()=>{
 const item={...row(1),kind:'investigation',available_triage_actions:[{action:'cancel',verb:'close-investigation',args:{run_id:'synthetic-run',status:'abandoned'},fields:[{name:'confidence',label:'Confidence',type:'number',min:0,max:1,required:true}],versioned:false}]};
 const client={unfinishedWork:async()=>envelope([item]),triageSystemWork:async(_v,args)=>args};
 await assert.rejects(()=>triageWork(client,item,'cancel',{confidence:'2'},{confirm:()=>true,idempotencyKey:'synthetic-key'}),/offered range/);
 const result=await triageWork(client,item,'cancel',{confidence:'0.5'},{confirm:()=>true,idempotencyKey:'synthetic-key'});assert.equal(result.result.confidence,0.5);
});
