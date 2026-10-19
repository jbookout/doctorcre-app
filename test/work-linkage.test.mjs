import test from 'node:test';
import assert from 'node:assert/strict';
import { workLineageHtml } from '../js/progress-work-model.js';

test('unloaded linkage is unavailable even when a legacy census flag says unlinked', () => {
  const html = workLineageHtml({ id: 'demo-task', related: [], unlinked: true }, 'demo-project');
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /Not linked/);
});
import {workDependencies,workDependenciesHtml} from '../js/progress-work-model.js';
const subject={board_id:'demo-project',task_id:'dependent',version:7};
const task=(references=[])=>({id:'dependent',version:7,linkage:{schema:'work-linkage.v1',state:'complete',subject,references,reason:null}});
test('only a complete source-bound empty observation says no recorded linkage',()=>{
 assert.equal(workDependencies(task(),'demo-project').state,'unlinked');
 assert.match(workDependenciesHtml(task(),'demo-project'),/No recorded linkage on this fully observed work record/);
 assert.equal(workDependencies({id:'dependent',unlinked:true},'demo-project').state,'unavailable');
});
const reference=(overrides={})=>({relation:'blocked_by',ref:'blocker',title:'Recorded blocker',state:'resolved',target:{board_id:'demo-project',task_id:'blocker'},...overrides});
test('recorded blockers navigate exact target keys while dangling/self ancestors remain readable',()=>{
 const value=task([reference(),reference(),reference({ref:'missing',title:'Missing ancestor',state:'unresolved',target:null}),reference({ref:'dependent',target:{board_id:'demo-project',task_id:'dependent'}})]);
 const model=workDependencies(value,'demo-project');
 assert.equal(model.state,'unresolved');assert.equal(model.references.length,3);
 const html=workDependenciesHtml(value,'demo-project');
 assert.match(html,/Blocked by/);assert.match(html,/Recorded blocker/);
 assert.match(html,/href="\/control-room\/progress\/work\?board=demo-project&amp;task=blocker"/);
 assert.doesNotMatch(html,/href="[^"]*task=dependent/);assert.match(html,/Missing ancestor/);
});
test('invalid source bindings, malformed reference targets and contradictory empty reads fail closed',()=>{
 for(const change of [
  value=>{value.linkage.schema='unknown';},value=>{value.linkage.subject={...subject,version:8};},
  value=>{value.linkage.subject={...subject,task_id:'other'};},value=>{value.linkage.subject={...subject,board_id:'other'};},
  value=>{value.linkage.references=[reference({target:{url:'javascript:alert(1)'}})];},
  value=>{value.linkage.references=[reference({state:'invented'})];},value=>{value.linkage.references=[null];},
  value=>{value.linkage.references=[];value.work_request='WR-900';},
  value=>{value.linkage.references=[];value.pr=22;value.repo='jbookout/carr-system';},
  value=>{value.linkage.references=[];value.parent_task_id='parent';},
 ]) {
  const value=task([reference()]);value.linkage.subject={...subject};change(value);
  assert.equal(workDependencies(value,'demo-project').state,'unavailable');
  assert.doesNotMatch(workDependenciesHtml(value,'demo-project'),/href=/);
 }
});
test('unsupported raw associations cannot be contradicted by an empty observation',()=>{
 for(const extra of [{depends_on:['other']},{dependency_refs:['other']},{blocked_by:'other'},{held:{blocker:{task_id:'other'}}}])
  assert.equal(workDependencies({...task(),...extra},'demo-project').state,'unavailable');
});
test('cross-board blocker targets cannot impersonate a same-board dependency',()=>{
 const value=task([reference({target:{board_id:'other-project',task_id:'blocker'}})]);
 assert.equal(workDependencies(value,'demo-project').state,'unavailable');
});
test('one unavailable target preserves other independently resolved links and WR navigation has no selected task',()=>{
 const value=task([reference(),reference({relation:'work_request',ref:'WR-900',title:'Known WR',target:{work_request:'WR-900'}}),
 reference({relation:'work_request',ref:'WR-901',title:'Unreadable WR',state:'unavailable',target:null})]);
 const model=workDependencies(value,'demo-project'),html=workDependenciesHtml(value,'demo-project');
 assert.equal(model.state,'unavailable');assert.equal(model.references.filter(ref=>ref.href).length,2);
 assert.match(html,/board=demo-project&amp;work_request=WR-900/);
 assert.doesNotMatch(html,/href="[^"]*WR-901|href="[^"]*task=dependent/);
 assert.equal(workDependencies(value,'demo-project',{linked:false}).references.length,0);
});
import {JSDOM} from 'jsdom';
import {mountJobDetail} from '../js/job-detail.js';
import {boardView} from '../js/progress-board-model.js';
function popup(client={}) {
 const dom=new JSDOM('<button id="trigger">Open</button><dialog id="jobDialog"><h2 id="jobTitle"></h2><div id="jobBody"></div><button id="jobClose">Close</button></dialog>',{url:'http://localhost/control-room/progress?board=demo-project'});
 const document=dom.window.document,dialog=document.getElementById('jobDialog');
 dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new dom.window.Event('close'));};
 return {document,detail:mountJobDetail({client,document}),body:document.getElementById('jobBody')};
}
test('public board view binds the observation to the snapshot key and publication version',()=>{
 const raw=task([reference()]);raw.id='wrong-id';raw.task_id='domain:other';
 const view=boardView({ok:true,snapshot:{board_id:'demo-project',version:7,updated_at:'2026-10-01T12:00:00Z',
 snapshot_json:{schema:'carr-progress-board.v2',project:'demo-project',tasks:{dependent:raw}}},questions:[]});
 const value=view.stages.flatMap(stage=>stage.tasks)[0];
 assert.equal(workDependencies(value,'demo-project').state,'linked');
 assert.equal(value.linkage_source.task_id,'dependent');
 const changed=boardView({ok:true,snapshot:{board_id:'demo-project',version:8,updated_at:'2026-10-01T12:00:00Z',
 snapshot_json:{schema:'carr-progress-board.v2',project:'demo-project',tasks:{dependent:raw}}},questions:[]}).stages.flatMap(stage=>stage.tasks)[0];
 assert.equal(workDependencies(changed,'demo-project').state,'unavailable');
});
test('popup source loss removes dependency links and a late WR response cannot restore them',async()=>{
 let resolve;
 const {detail,body}=popup({workRequestCard:()=>new Promise(r=>resolve=r),engineeringProgress:async()=>null});
 const value={...task([reference()]),work_request:'WR-900',title:'Dependent',summary:'Original retained detail'};
 detail.open(value);
 assert.ok(body.querySelector('.work-dependencies a'));
 body.querySelector('details').open=true;
 detail.update([],{state:'unknown'});
 assert.equal(body.querySelector('.work-dependencies').dataset.linkageState,'unavailable');
 assert.equal(body.querySelector('.work-dependencies a'),null);
 resolve({ok:true,human_ref:'WR-900',desired_outcome:'Late outcome'});
 await new Promise(r=>setImmediate(r));
 assert.equal(body.querySelector('.work-dependencies a'),null);
 assert.equal(body.querySelector('details').open,true);
 assert.match(body.querySelector('pre').textContent,/Original retained detail/);
 detail.update([],{state:'read'});
 assert.equal(body.querySelector('.work-dependencies a'),null);
 detail.clear();assert.equal(body.children.length,0);
});
test('publisher omission marker prevents fabricated empty linkage completeness',()=>{
 assert.equal(workDependencies({...task(),linkage_metadata_unavailable:true},'demo-project').state,'unavailable');
});
