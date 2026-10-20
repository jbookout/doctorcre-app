import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {passportProjectionDigest} from '../js/job-passport.js';
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

test('selecting a check exposes its own receipt rather than a generic Passport destination',()=>{
 const passport=canonicalFixture(),read=structuredClone(fixture);
 read.scope={plan_ref:passport.accepted_plan_revision.id,...passport.accepted_plan_revision};
 read.checks[0]={...read.checks[0],slice_ref:'slice:a',check_ref:'check:synthetic'};
 const document=new JSDOM(workProgressHtml(read,'WR-900',passport)).window.document;
 const rows=[...document.querySelectorAll('.work-progress-checks > li')];
 assert.equal(rows.length,5);
 assert.equal(rows[0].querySelector('button').getAttribute('aria-expanded'),'true');
 const evidence=document.querySelector('[data-check-evidence]:not([hidden])');
 assert.match(evidence.textContent,/Synthetic/);
 assert.match(evidence.textContent,/actor:codex/);
 assert.match(evidence.textContent,/Passed/);
 assert.match(evidence.textContent,/2026/);
 assert.match(evidence.textContent,/evidence:receipt/);
 assert.match(evidence.textContent,/Independent verification time.*Not recorded/);
 assert.equal(document.querySelectorAll('.work-progress-checks > li > a').length,0);
 assert.ok(evidence.querySelector('details pre'),'Raw receipt stays behind a secondary disclosure');
});

test('scope history explains denominator changes without claiming which checks changed',()=>{
 const document=new JSDOM(workProgressHtml(fixture,'WR-900')).window.document;
 const history=document.querySelector('.work-scope-history');
 assert.match(history.textContent,/Total increased by 1 check since revision 1/);
 const read=structuredClone(fixture);read.history.push({...read.scope,revision:3,total_checks:3});
 assert.match(new JSDOM(workProgressHtml(read,'WR-900')).window.document.querySelector('.work-scope-history').textContent,/Total decreased by 2 checks since revision 2/);
 read.history.push({...read.scope,revision:4,total_checks:3});
 assert.match(new JSDOM(workProgressHtml(read,'WR-900')).window.document.querySelector('.work-scope-history').textContent,/Total unchanged since revision 3/);
});

test('check criteria use only the canonical passport for the exact accepted scope',()=>{
 const passport=canonicalFixture(),read={...structuredClone(fixture),scope:{plan_ref:passport.accepted_plan_revision.id,...passport.accepted_plan_revision}};
 read.checks[0]={...read.checks[0],slice_ref:'slice:a',check_ref:'check:synthetic'};
 assert.match(workProgressHtml(read,'WR-900',passport),/Fails if missing evidence/);
 read.scope.revision+=1;
 assert.doesNotMatch(workProgressHtml(read,'WR-900',passport),/Fails if missing evidence/);
 assert.doesNotMatch(workProgressHtml(read,'WR-900',{slice_plan:passport.slice_plan}),/Fails if missing evidence/);
});

test('an unparseable recorded claim time stays unavailable without hiding the receipt',()=>{
 const passport=canonicalFixture(),read=structuredClone(fixture);
 passport.receipts[0].executor_claim.claimed_at='unknown';
 passport.current_receipts=structuredClone(passport.receipts);
 passport.projection_digest=passportProjectionDigest(passport);
 read.scope={plan_ref:passport.accepted_plan_revision.id,...passport.accepted_plan_revision};
 read.checks[0]={...read.checks[0],slice_ref:'slice:a',check_ref:'check:synthetic'};
 const document=new JSDOM(workProgressHtml(read,'WR-900',passport)).window.document;
 const panel=document.querySelector('[data-check-evidence]:not([hidden])');
 assert.match(panel.textContent,/Passed/);
 assert.match(panel.textContent,/Claim recordedNot recorded/);
});
