import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {jobLinks,governanceTasks,withGovernance,automationMonth} from '../js/control-room-workspace-model.js';
import {connectionView,meteredSpend} from '../js/connections-model.js';
import {createFixtureClient} from '../js/fixture-client.js';
import {createLiveClient} from '../js/live-client.js';
const stamp='2026-10-02T12:00:00Z';
const fixture=async()=>createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json',import.meta.url))).toString('base64')}`});
test('job cards retain exact Work Request and PR; absence never creates a reference',()=>{
 assert.deepEqual(jobLinks({kind:'work_request',id:'work_request:WR-000901',pr:17}),{workRequest:'WR-000901',prLabel:'PR #17',prUrl:null});
 assert.equal(jobLinks({title:'mentions WR-123 and PR 17',related:null}).workRequest,null);
 assert.equal(jobLinks({work_request:'WR-123',pr_url:'javascript:alert(1)'}).prUrl,null);
 const url='https://github.com/example/demo/pull/17';assert.equal(jobLinks({related:[{kind:'work_request',id:'WR-123'}],pr:url}).prUrl,url);
 assert.equal(jobLinks({human_ref:'WR-123'}).prLabel,null);
});
test('all governance lanes become review cards with original entries and exact deduplication',async()=>{
 const queue=await (await fixture()).governanceQueue(),tasks=governanceTasks(queue);
 assert.equal(tasks.length,queue.counts.total);assert.ok(tasks.every(t=>t.governance.entry&&t.stage==='review'));
 const board={stages:[{id:'review',tasks:[]},{id:'build',tasks:[]}]};
 const merged=withGovernance(board,tasks);assert.equal(merged.stages[0].tasks.length,queue.counts.total);
 assert.equal(withGovernance(merged,tasks).stages[0].tasks.length,queue.counts.total);
 assert.deepEqual(governanceTasks({ok:true}),[]);
});
test('calendar uses next due dates in the selected month; unscheduled jobs stay visible',async()=>{
 const schedule=await (await fixture()).scheduleBoard();
 const dated={...schedule.jobs[0],next_due_at:'2026-10-02T12:00:00Z'},undated={...schedule.jobs[0],key:'undated',next_due_at:null,next_due_basis:null};
 const jobs=schedule.jobs.map((job,index)=>index===0?dated:index===1?{...undated,owner:job.owner}:job);
 const calendar=automationMonth({...schedule,jobs},2026,9);
 assert.equal(calendar.days.length,31);assert.equal(calendar.days[1].jobs[0],dated);assert.ok(calendar.undated.some(job=>job.key==='undated'));
 assert.equal(automationMonth({...schedule,jobs},2026,10).days.flatMap(d=>d.jobs).length,0);
 assert.equal(automationMonth(null,2026,9).jobs,null);
});
test('connection status, currency spend and device online state require explicit observations',()=>{
 const payload={ok:true,schema:'doctorcre-connections.v1',generated_at:stamp,providers:[{id:'claude',status:'connected',checked_at:stamp,manage_url:'/control-room?tab=connections',spend:{amount:0,currency:'USD',kind:'charge',period:'October',as_of:stamp}},{id:'codex',configured:true,spend:{amount:99,currency:'USD'}}],devices:{state:'read',observed_at:stamp,items:[{id:'one',name:'Demo device',connected:false},{id:'two',connected:true}]}};
 const result=connectionView(payload);assert.equal(result.providers.length,10);assert.equal(result.providers[0].status,'connected');assert.equal(result.providers[0].manage_url,payload.providers[0].manage_url);
 assert.equal(result.providers[1].status,'unknown');assert.equal(result.providers[1].spend,null);assert.match(meteredSpend(result.providers[0].spend),/\$0\.00/);
 assert.deepEqual(result.devices.map(d=>d.status),['offline','connected']);assert.equal(connectionView(null).devices,null);
 payload.providers.push(payload.providers[0]);assert.equal(connectionView(payload).providers[0].status,'unknown');
 payload.providers=[{id:'claude',status:'connected',checked_at:'invalid',manage_url:'javascript:alert(1)'}];assert.equal(connectionView(payload).providers[0].manage_url,null);assert.equal(connectionView(payload).providers[0].status,'unknown');
});
test('live Connections uses the pinned read-only MCP contract',async()=>{
 const connections={ok:true,schema:'doctorcre-connections.v1',providers:[]};
 const calls=[];const client=createLiveClient({fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({ok:true,connections})}]}}));}});
 assert.deepEqual(await client.readConnections(),connections);assert.equal(calls[0].params.name,'read-resource-dashboard');assert.deepEqual(calls[0].params.arguments,{});
 const contract=JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json',import.meta.url)));assert.ok(contract.mcp_operations.includes('read-resource-dashboard'));
});
