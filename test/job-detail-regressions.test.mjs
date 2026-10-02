import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountJobDetail} from '../js/job-detail.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(client={}){
 const dom=new JSDOM('<button id="trigger">Job</button><dialog id="jobDialog"><h2 id="jobTitle"></h2><div id="jobBody"></div><button id="jobClose">Close</button></dialog>',{url:'http://localhost/control-room'});
 const document=dom.window.document,dialog=document.getElementById('jobDialog');
 dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new dom.window.Event('close'));};
 globalThis.location=dom.window.location;
 document.getElementById('trigger').focus();
 return {document,detail:mountJobDetail({client,document}),body:document.getElementById('jobBody')};
}
test('finding 1: Details preserves schedule, structured proposal, rule and incident facts',()=>{
 const {detail,body}=setup();
 const rows=[
  {id:'job',name:'Demo job',schedule:'0 6 * * *',next_due_at:'2026-10-03T06:00:00Z',freshness:'stale',last_run:{at:'2026-10-02T06:00:00Z',state:'failed',receipt_ref:'demo-receipt'}},
  {id:'proposal',governance:{entry:{payload:{phrase:'Demo structured phrase'},proposal_type:'phrase',proposer_actor_id:'dell'}}},
  {id:'rule',governance:{entry:{statement:'Demo rule',enforcement_class:'demo_hook',binding_moment:'before delivery'}}},
  {id:'incident',title:'Demo incident',owner_actor:'dell',impact:'Demo impact',recommended_next_action:'Demo next action',blockers:['Demo dependency']},
 ];
 for(const [i,row] of rows.entries()){
  detail.open(row);const text=body.textContent;
  for(const value of [['0 6 * * *','2026-10-03','stale','failed','demo-receipt'],['Demo structured phrase','phrase','dell'],['Demo rule','demo_hook','before delivery'],['dell','Demo impact','Demo next action','Demo dependency']][i])assert.ok(text.includes(value),value);
 }
});
test('finding 2: linked WR enriches without replacing the selected governance original',async()=>{
 const {detail,body}=setup({workRequestCard:async()=>({ok:true,human_ref:'WR-1',desired_outcome:'Demo WR outcome'})});
 detail.open({id:'governance:rule:demo',work_request:'WR-1',governance:{entry:{statement:'Demo original statement',human_quote:'Demo original quote'}}});await tick();
 for(const text of ['Demo original statement','Demo original quote','Demo WR outcome'])assert.ok(body.textContent.includes(text),text);
});
test('finding 3: same ID with a new binding rejects the old successful read',async()=>{
 let resolve;const {detail,body}=setup({workRequestCard:({work_request})=>work_request==='WR-1'?new Promise(r=>resolve=r):Promise.resolve({ok:true,human_ref:'WR-2',desired_outcome:'Demo second outcome'})});
 detail.open({id:'stable',title:'First',work_request:'WR-1'});
 detail.update([{id:'stable',title:'Second',work_request:'WR-2'}]);
 resolve({ok:true,human_ref:'WR-1',desired_outcome:'Demo obsolete outcome'});await tick();
 assert.doesNotMatch(body.textContent,/Demo obsolete outcome/);assert.match(body.textContent,/WR-2/);
 await detail.refresh();assert.match(body.textContent,/Demo second outcome/);
});
test('finding 6: source removal and unavailability are labeled, unrelated refreshes preserve selection',()=>{
 const {detail,body}=setup();detail.open({id:'incident',state:'investigating',impact:'Demo impact'},{source:'incidents'});
 detail.update([],{source:'schedule'});assert.match(body.textContent,/investigating/);
 detail.update([{id:'incident',state:'monitoring',impact:'Demo changed impact'}],{source:'incidents'});assert.match(body.textContent,/monitoring/);assert.match(body.textContent,/Demo changed impact/);
 detail.update([],{source:'incidents'});assert.match(body.textContent,/no longer|removed/i);assert.doesNotMatch(body.querySelector('.job-summary').textContent,/monitoring/);
 detail.update([],{source:'incidents',state:'unknown'});assert.match(body.textContent,/source.*unavailable/i);
});
test('finding 8: changed popup links retain focus and close resolves current trigger',()=>{
 const {document,detail,body}=setup();const task={id:'work_request:WR-1',kind:'work_request',work_request:'WR-1',pr:1};
 const trigger=document.getElementById('trigger');trigger.dataset.taskId=task.id;trigger.focus();detail.open(task);
 body.querySelector('details').open=true;body.querySelector('details a').focus();detail.update([{...task,pr:2}]);
 assert.equal(document.activeElement,body.querySelector('details a'));
 const replacement=trigger.cloneNode(true);trigger.replaceWith(replacement);document.getElementById('jobClose').click();assert.equal(document.activeElement,replacement);
});
test('finding 12: activity destinations use supported source/WR identities only',()=>{
 const {detail,body}=setup();
 for(const row of [{id:'automation:demo:key',key:'key'},{id:'INC-DEMO',ref:'INC-DEMO'}]){detail.open(row);assert.equal(body.querySelector('details a'),null);}
 detail.open({id:'governance:pending_rule_approvals:demo-ref',kind:'governance_item',governance:{ref:'demo-ref',entry:{statement:'Demo'}}});
 assert.equal(new URL(body.querySelector('details a').href).searchParams.get('task'),'governance_item:demo-ref');
 detail.open({id:'automation:demo:key',work_request:'WR-1'});const url=new URL(body.querySelector('details a').href);assert.equal(url.searchParams.get('task'),null);assert.equal(url.searchParams.get('work_request'),'WR-1');
});
