import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {canonicalFixture} from './fixtures/progress-work.synthetic.mjs';
import fixture from './fixtures/engineering-progress.synthetic.json' with {type:'json'};
import {workProgress,workProgressHtml} from '../js/progress-work-model.js';

test('fixed acceptance scope shows two of five checks and three remaining',()=>{
 const progress=workProgress(fixture,'WR-900');
 assert.equal(progress.state,'available');
 assert.equal(progress.label,'2 of 5 acceptance checks verified');
 assert.equal(progress.remaining,3);
 assert.deepEqual(progress.scope,fixture.scope);
 assert.equal(progress.history[0].total_checks,4);
});


test('unknown denominator keeps its scope revision without a ratio or unsafe history',()=>{
 const read={...fixture,state:'unavailable',reason:'No registered checks for the accepted scope.',total:null,completed:null,scope:{...fixture.scope,revision:3},history:[{revision:'<img src=x onerror=alert(1)>'}]};
 const html=workProgressHtml(read,'WR-900');
 assert.match(html,/Progress unavailable/);assert.match(html,/Scope revision 3/);
 assert.doesNotMatch(html,/<progress|[0-9]+%|<img/);
 assert.deepEqual(workProgress(read,'WR-900').history,[]);
});


for(const [label,change] of [
 ['another Work Request',read=>{read.work_request='WR-901';}],
 ['duplicate retry checks',read=>{read.checks.push({...read.checks[0]});read.total=6;read.completed=3;}],
 ['an inflated completed count',read=>{read.completed=4;}],
 ['an unknown denominator',read=>{read.total=null;}],
]) test(`progress is unavailable for ${label}`,()=>{
 const read=structuredClone(fixture);change(read);
 const progress=workProgress(read,'WR-900');assert.equal(progress.state,'unavailable');
 assert.doesNotMatch(workProgressHtml(read,'WR-900'),/<progress|[0-9]+%/);
});

test('acceptance checks have readable criteria and links to the canonical evidence source',()=>{
 const document=new JSDOM(workProgressHtml(fixture,'WR-900')).window.document;
 const rows=[...document.querySelectorAll('.work-progress-checks li')];
 assert.deepEqual(rows.map(row=>row.querySelector('.work-check-criterion').textContent),['Stable links','Rename','Verified fraction','Scope revision','Unknown scope']);
 for(const row of rows){
  assert.doesNotMatch(row.textContent,/check:/);
  const url=new URL(row.querySelector('a').getAttribute('href'),'http://localhost');
  assert.equal(url.pathname,'/control-room/progress/work');
  assert.equal(url.searchParams.get('work_request'),'WR-900');
  assert.equal(url.hash,'#workCanonicalPassport');
 }
});

test('scope history explains denominator changes without claiming which checks changed',()=>{
 const document=new JSDOM(workProgressHtml(fixture,'WR-900')).window.document;
 const history=document.querySelector('.work-progress details');
 assert.match(history.textContent,/Total increased by 1 check since revision 1/);
 const read=structuredClone(fixture);read.history.push({...read.scope,revision:3,total_checks:3});
 assert.match(new JSDOM(workProgressHtml(read,'WR-900')).window.document.querySelector('details').textContent,/Total decreased by 2 checks since revision 2/);
 read.history.push({...read.scope,revision:4,total_checks:3});
 assert.match(new JSDOM(workProgressHtml(read,'WR-900')).window.document.querySelector('details').textContent,/Total unchanged since revision 3/);
});

test('check criteria use only the canonical passport for the exact accepted scope',()=>{
 const passport=canonicalFixture(),read={...structuredClone(fixture),scope:{plan_ref:passport.accepted_plan_revision.id,...passport.accepted_plan_revision}};
 read.checks[0]={...read.checks[0],slice_ref:'slice:a',check_ref:'check:synthetic'};
 assert.match(workProgressHtml(read,'WR-900',passport),/Fails if missing evidence/);
 read.scope.revision+=1;
 assert.doesNotMatch(workProgressHtml(read,'WR-900',passport),/Fails if missing evidence/);
 assert.doesNotMatch(workProgressHtml(read,'WR-900',{slice_plan:passport.slice_plan}),/Fails if missing evidence/);
});
