import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocContext,normalizeDocRead,docAnswer} from '../js/doc-context-model.js';
const old='2026-10-01T10:00:00Z', newer='2026-10-01T11:00:00Z';
const party={id:'sample',name:'Sample',record_version:1,owner_label:'Sample owner',recorded_status:'active',recorded_status_label:'Active client',recorded_stage:'approved',recorded_stage_label:'Approved vendor'};
test('R7 timestamp and numeric-string revisions outrank old activity; equal revision enriches only',()=>{
 for(const [a,b] of [[old,newer],['9','10']]) {
  const c=createDocContext({page:'clients'});
  c.finish(c.begin('businessActivity',[{dataset:'clients',id:'sample'}]),{record:{...party,record_version:a},activities:[{what:'Old activity',when:old}]});
  c.finish(c.begin('businessRecord',[{dataset:'clients',id:'sample'}]),{record:{...party,record_version:b,name:'New facts'}});
  assert.equal(c.snapshot().records[0].title,'New facts');assert.deepEqual(c.snapshot().records[0].activity,[]);
 }
 const c=createDocContext({page:'queue'});
 c.finish(c.begin('roomQueue'),{events:[{task_id:'sample',card:{title:'New',status:'done',updated_at:newer}},{task_id:'sample',card:{title:'Old',status:'running',updated_at:old}}]});
 assert.equal(c.snapshot().records[0].title,'New');
});
test('R9 summary Ideas uses recorded number, label and version',()=>{
 const rows=normalizeDocRead('loopBoard',{loops:[{number:1,label:'Sample idea',owner:'sample',version:1}]});
 assert.equal(rows?.[0].title,'Sample idea');assert.equal(rows?.[0].version,1);
});
test('Leads workspace accepts doctor_name and base_version',()=>{
 const rows=normalizeDocRead('getWorkspace',{leads:[{id:'example-lead',doctor_name:'Sample lead',base_version:2}]});
 assert.equal(rows?.[0].title,'Sample lead');assert.equal(rows?.[0].version,2);
});
test('R11 Search catch-up completed/empty/disambiguation/not-found states preserve a successful find',()=>{
 const c=createDocContext({page:'search'});c.finish(c.begin('find'),{parties:[{ref:'sample',name:'Sample'}]});
 for(const payload of [{state:'completed',match:{kind:'client',target:'sample'},catch_up:{timeline:[]}},{state:'needs_disambiguation',candidates:[],candidate_count:0,candidates_truncated:false,hint:'Choose'},{state:'not_found',candidates:[],retired_matches:0,hint:'None'}]){
  assert.equal(c.finish(c.begin('findAndCatchUp'),payload),true);assert.equal(c.snapshot().ready,true);
 }
 assert.equal(normalizeDocRead('findAndCatchUp',{state:'completed',match:{kind:'client',target:'sample'}}),null);
});
test('R12 directory list/detail/activity preserve recorded labels',()=>{
 for(const dataset of ['clients','vendors']) for(const method of ['businessList','businessRecord','businessActivity']) {
  const payload=method==='businessList'?{rows:[party]}:{record:party,activities:[{what:'New',when:newer},{what:'Old',when:old}]};
  const [row]=normalizeDocRead(method,payload,[{dataset,id:'sample'}]);
  assert.equal(row.fields.find(f=>f.label==='Owner').value,'Sample owner');
  assert.equal(row.fields.find(f=>f.label==='Status').value,dataset==='clients'?'Active client':'Approved vendor');
  if(method==='businessActivity')assert.equal(row.activity[0].text,'New');
 }
});
test('R13 merged activity sorts descending and incomplete conversation cannot claim the latest entry',()=>{
 const c=createDocContext({page:'deals'});
 c.finish(c.begin('getDeal',['sample']),{deal:{id:'sample',name:'Sample'},activities:[{summary:'Old',occurred_at:old}],history:[{description:'New',recorded_at:newer}]});
 assert.equal(docAnswer(c.snapshot(),{recordId:'sample',question:'Recent activity'}).value,'New');
 const chat=createDocContext({page:'chats'});
 const payload={identity:{id:'sample',title:'Sample'},latest_sequence:9,more:true,turns:[{sequence:1,body:'Old',at:old},{sequence:2,body:'New',at:newer}]};
 chat.finish(chat.begin('readDocConversation',[{conversation_id:'sample'}]),payload);
 assert.equal(chat.snapshot().records[0].activity[0].text,'New');
 assert.equal(docAnswer(chat.snapshot(),{recordId:'sample',question:'Recent activity'}).state,'unknown');
 assert.equal(docAnswer(chat.snapshot(),{recordId:'sample',question:'Recent activity'}).value,null);
});
test('filter projections expose only explicitly projected sources and never renew observations',()=>{
 let now=1000;const c=createDocContext({page:'deals',now:()=>now});
 const board={deals:[{id:'sample',name:'Sample',version:1}]};
 c.finish(c.begin('getBoard'),board);
 c.finish(c.begin('getDeal',['sample']),{deal:board.deals[0],activities:[{summary:'Detail only',occurred_at:old}]});
 now=2000;c.filter({query:'none'});
 assert.equal(c.project('getBoard',{deals:[]}),true);
 assert.equal(c.snapshot().ready,true);assert.deepEqual(c.snapshot().records,[]);
 assert.equal(c.snapshot().observedAt,new Date(1000).toISOString());
 c.filter({query:'Sample'});assert.deepEqual(c.snapshot().records,[]);
 assert.equal(c.project('getBoard',board),true);
 assert.deepEqual(c.snapshot().records[0].activity,[]);
 assert.equal(c.snapshot().observedAt,new Date(1000).toISOString());
});
test('filter changes reject both successful and failed prior-query tickets',()=>{
 const c=createDocContext({page:'search'});
 const prior=c.begin('find',[{query:'old'}]);
 c.filter({query:'new'});
 assert.equal(c.finish(prior,{parties:[{ref:'old',name:'Old query'}]}),false);
 assert.deepEqual(c.snapshot().records,[]);assert.equal(c.snapshot().ready,false);
 c.finish(c.begin('find',[{query:'new'}]),{parties:[{ref:'new',name:'New query'}]});
 c.fail(prior,{status:503});
 assert.equal(c.snapshot().ready,true);assert.deepEqual(c.snapshot().records.map(r=>r.id),['new']);
});
test('projecting one source does not restore another or turn a failed source into a successful read',()=>{
 const c=createDocContext({page:'home'});
 c.finish(c.begin('getBoard'),{deals:[{id:'sample',name:'Sample'}]});
 c.fail(c.begin('getLeadBoard'),{status:503});
 c.filter({scope:'mine'});
 assert.equal(c.project('getBoard',{deals:[]}),true);
 assert.equal(c.project('getLeadBoard',{leads:[]}),false);
 assert.deepEqual(c.snapshot().records,[]);
 c.fail(c.begin('getBoard'),{status:503});c.filter({scope:'all'});
 assert.equal(c.project('getBoard',{deals:[]}),false);assert.equal(c.snapshot().ready,false);
});
test('R17 deleted mounting interface has no callers or fallback',async()=>{
 const {readdir}=await import('node:fs/promises');
 for(const file of await readdir(new URL('../js/',import.meta.url)))if(file.endsWith('.js')){
  const source=await readFile(new URL('../js/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/mountDocDock/,file);
 }
 const source=await readFile(new URL('../js/business-workspace.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/doc\?\.openHistory|doc\?\.open/);
 assert.match(source,/\/doc-chats/);
});
test('R1/R5/R14 cached projection cannot recover failure or renew its observed time',()=>{
 let now=1000;const c=createDocContext({page:'deals',now:()=>now});
 c.finish(c.begin('getBoard'),{deals:[{id:'sample',name:'Sample'}]});const at=c.snapshot().observedAt;
 now=2000;c.filter({query:'none'});assert.equal(c.project('getBoard',{deals:[]}),true);assert.equal(c.snapshot().observedAt,at);
 const ticket=c.begin('getBoard');c.fail(ticket);c.filter({query:''});
 assert.equal(c.project('getBoard',{deals:[{id:'sample',name:'Sample'}]}),false);assert.equal(c.snapshot().ready,false);
});
test('R3 retired task drawer is removed from the retained Progress consumer',async()=>{
 const html=await readFile(new URL('../progress-work.html',import.meta.url),'utf8');const js=await readFile(new URL('../js/queue.js',import.meta.url),'utf8');
 assert.doesNotMatch(html,/queueDrawer/);assert.doesNotMatch(js,/queueDrawer|showModal/);
});
