import test from 'node:test';
import assert from 'node:assert/strict';
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
