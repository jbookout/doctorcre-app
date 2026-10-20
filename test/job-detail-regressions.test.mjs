import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import progressFixture from './fixtures/engineering-progress.synthetic.json' with {type:'json'};
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


test('PR132 #2: expanded source and linked WR preserve substantive fields and escape them',async()=>{
 const linked={ok:true,human_ref:'WR-9',acceptance_criteria:['Demo acceptance'],incident_evidence:{receipt:'Demo incident receipt'},projection_state:'transport-only'};
 const {detail,body}=setup({workRequestCard:async()=>linked});
 const full='Demo long summary '+ 'x'.repeat(260)+' SUMMARY END';
 detail.open({id:'demo',work_request_ref:'WR-9',summary:full,evidence:'<img src=x onerror=alert(1)>',stage_history:[{stage:'review',note:'Demo stage history'}],projection_state:'transport-only'});await tick();
 for(const text of [full,'<img src=x onerror=alert(1)>','Demo stage history','Demo acceptance','Demo incident receipt'])assert.ok(body.querySelector('pre').textContent.includes(text),text);
 assert.equal(body.querySelector('img'),null);assert.doesNotMatch(body.querySelector('pre').textContent,/transport-only/);
});
test('PR132 #3: retained unknown selections remain unavailable on open',()=>{
 const {detail,body}=setup();detail.open({id:'governance:demo',source_state:'unknown',status:'proposed'});
 assert.match(body.textContent,/Source unavailable.*Last-known/);assert.doesNotMatch(body.querySelector('.job-summary').textContent,/proposed/);
});
test('PR132 #6: replaced calendar trigger returns focus to its owner and originating container',()=>{
 const {document,detail}=setup();
 const calendar=document.createElement('div');calendar.id='automationCalendar';calendar.innerHTML='<button data-automation="same" data-owner="one">One</button><button data-automation="same" data-owner="two">Two</button>';
 const agenda=calendar.cloneNode(true);agenda.id='automationAgenda';document.body.prepend(calendar,agenda);
 calendar.lastElementChild.focus();detail.open({id:'automation:two:same'});
 calendar.innerHTML=calendar.innerHTML;agenda.innerHTML=agenda.innerHTML;document.getElementById('jobClose').click();
 assert.equal(document.activeElement,calendar.lastElementChild);
});


test('PR card exposes exact work lineage and keeps links through a rename',()=>{
 const {detail,body}=setup();
 const task={id:'app-pr-73',task_id:'app-pr-73',title:'Synthetic linked card',repo:'jbookout/doctorcre-app',pr:73,
  work_request_ref:'WR-900',plan_ref:'plan:synthetic-v2',slice_ref:'slice:seven',task_ref:'task:linked-card',job_ref:'job:synthetic-build'};
 detail.open(task);
 const refs=['WR-900','plan:synthetic-v2','slice:seven','task:linked-card','job:synthetic-build'];
 const links=()=>[...body.querySelectorAll('.work-lineage a')];
 assert.equal(links().length,1);
 const requestUrl=new URL(links()[0].href);
 assert.equal(requestUrl.searchParams.get('work_request'),'WR-900');
 assert.equal(requestUrl.searchParams.has('task'),false);
 for(const ref of refs)assert.ok(body.querySelector('.work-lineage').textContent.includes(ref));
 const before=links().map(link=>link.href);
 detail.update([{...task,title:'Renamed without changing the work'}]);
 assert.deepEqual(links().map(link=>link.href),before);
 detail.open({id:'unbound',task_id:'unbound',title:'WR-900 plan:synthetic-v2',slice:'Slice seven'});
 assert.equal(body.querySelectorAll('.work-lineage a').length,1);
 assert.equal(body.querySelectorAll('.work-lineage [data-missing]').length,4);
});


test('lineage refuses display-only automation and incident IDs and canonicalizes governance',()=>{
 const {detail,body}=setup();
 for(const task of [{id:'automation:joe:nightly'},{id:'INC-DEMO'}]) {
  detail.open(task);assert.equal(body.querySelectorAll('.work-lineage a').length,0);
 }
 detail.open({id:'governance:pending:demo',kind:'governance_item',governance:{ref:'demo',entry:{statement:'Synthetic'}}});
 const link=body.querySelector('.work-lineage a');
 assert.equal(new URL(link.href).searchParams.get('task'),'governance_item:demo');
});


test('PR detail explains verified checks, remaining work and scope history',async()=>{
 const {detail,body}=setup({workRequestCard:async()=>({ok:true,human_ref:'WR-900'}),engineeringProgress:async()=>structuredClone(progressFixture)});
 detail.open({id:'pr-73',pr:73,work_request_ref:'WR-900'});await tick();
 const progress=body.querySelector('.work-progress');assert.ok(progress);
 assert.equal(body.firstElementChild,progress,'Acceptance progress leads the dialog, directly below its title');
 assert.match(progress.textContent,/2 of 5 acceptance checks verified/);assert.match(progress.textContent,/3 remaining/);
 assert.match(progress.textContent,/Scope revision 2/);assert.match(progress.textContent,/Revision 1.*4 acceptance checks/);
 assert.equal(progress.querySelector('progress').value,2);
});

test('PR activity uses the board key while preserving the canonical task ID as data',()=>{
 const {detail,body}=setup();
 detail.open({id:'app-pr-73',task_id:'task:canonical-900',repo:'jbookout/doctorcre-app',pr:73,title:'Synthetic distinct identities'});
 const activity=body.querySelector('[data-job-control="activity"]');
 assert.equal(new URL(activity.href).searchParams.get('task'),'app-pr-73');
 assert.match(body.querySelector('pre').textContent,/task id: task:canonical-900/);
});

test('dangling ancestor references remain readable without self-links',()=>{
 const {detail,body}=setup();
 detail.open({id:'app-pr-73',task_id:'task:canonical-900',repo:'jbookout/doctorcre-app',pr:73,
  work_request_ref:'WR-900',plan_ref:'plan:missing',slice_ref:'slice:missing',job_ref:'job:missing',
  related:[{kind:'plan',id:'plan:also-missing'}]});
 for(const ref of ['plan:missing','plan:also-missing','slice:missing','task:canonical-900','job:missing']) {
  const row=[...body.querySelectorAll('.work-lineage dd > *')].find(node=>node.textContent===ref);
  assert.ok(row,`${ref} remains visible`);
  assert.equal(row.tagName,'SPAN',`${ref} has no resolved destination`);
 }
 const wr=body.querySelector('.work-lineage a');
 const url=new URL(wr.href);
 assert.equal(url.searchParams.get('work_request'),'WR-900');
 assert.equal(url.searchParams.has('task'),false,'WR navigation reads the request independently of this card');
});

test('attention detail keeps blocker, progress and unknown model facts above the fold',()=>{
 const {detail,body}=setup();
 detail.open({id:'demo-failed',title:'Demo failed export',status:'failed',executor:'cx-app',blocked_reason:'Demo source unavailable',last_progress:'Demo validation complete'});
 const summary=body.querySelector('.job-summary');
 for(const value of ['Demo source unavailable','Demo validation complete','cx-app','Model','Effort','unknown'])assert.ok(summary.textContent.includes(value),value);
 detail.update([{id:'other',title:'Demo other work'}],{source:'agents'});
 assert.match(body.textContent,/Demo validation complete/);
});
