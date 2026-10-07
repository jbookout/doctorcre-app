import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { continuityCases } from '../scripts/browser-proof-contract.mjs';

const runner = await import('../scripts/full-main.mjs').catch(() => null);
async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'app-full-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test')); await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'package.json'), JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.mjs'}}));
  await writeFile(join(root, 'test/seeded.test.mjs'), body);
  await writeFile(join(root, '.gitignore'), '.e2e/\n');
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init');git('add','.gitignore','package.json','test/seeded.test.mjs');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','fixture');
  return {root,git};
}
const clean="import test from 'node:test'; test('synthetic full-suite case',()=>{});\n";
const commit = git => {
  git('add','.');
  git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','synthetic control');
};
test('TAP header and totals require matching plans and numbered results', async t => {
  const totals = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0';
  for (const body of ['', '1..1', 'ok 1 - synthetic', 'ok 1 - synthetic\n1..2', 'ok 2 - synthetic\n1..1', 'ok 1 - synthetic\n1..1\n1..1', 'not ok 1 - synthetic\n1..1', 'ok 1 - synthetic\n    ok 1 - unfinished child\n1..1', "not ok 1 - suite\n  ---\n  type: 'suite'\n  ...\nok 2 - synthetic\n1..2"]) {
    const output = `TAP version 13\n${body}\n${totals}`;
    const {root,git} = await fixture(t,clean);
    await writeFile(join(root,'scripts/report.cjs'),`console.log(${JSON.stringify(output)});`);
    await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node scripts/report.cjs'}}));
    commit(git);
    assert.equal((await runner.runFullMain({root,suite:'app',timeoutMs:5000})).status,'unknown',body);
  }
});
test('declared screenshots and native failure attachments are generated outputs', async t => {
  const {root}=await fixture(t,clean);
  for (const path of ['out/test-artifacts/w10/activity-390.png','.e2e/artifacts/chromium/synthetic/default/attempt-0/failure/screen.txt']) {
    await mkdir(join(root,path,'..'),{recursive:true});
    await writeFile(join(root,path),'synthetic generated output');
  }
  assert.equal((await runner.runFullMain({root,suite:'app',timeoutMs:5000})).status,'passed');
});
test('complete nested TAP with suites, skipped and todo results survives long output', async t => {
  const {root}=await fixture(t,`import {test,describe,it} from 'node:test';
    test('outer',async t=>{await t.test('inner',()=>{console.log('x'.repeat(70000));});await t.test('skipped',{skip:true},()=>{});});
    describe('suite',()=>{it('one',()=>{});it('todo',{todo:true},()=>{});});`);
  const receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  assert.equal(receipt.status,'passed');
  assert.deepEqual(receipt.counts,{tests:5,passed:3,failed:0,cancelled:0,skipped:1,todo:1});
});
test('ignored runtime imports and changed tracked screenshot inputs cannot borrow HEAD', async t => {
  for (const directory of ['out','dist','.e2e','out/test-artifacts']) await t.test(directory, async t => {
    const {root,git}=await fixture(t,`import test from 'node:test'; import {works} from '../${directory}/runtime.mjs'; test('synthetic',()=>{if(!works) throw Error('failed');});`);
    await writeFile(join(root,'.gitignore'),'.e2e/\nout/\ndist/\n'); commit(git);
    await mkdir(join(root,directory),{recursive:true}); await writeFile(join(root,directory,'runtime.mjs'),'export const works=true;');
    assert.equal((await runner.runFullMain({root,suite:'app',timeoutMs:5000})).reason,'source_changed');
  });
  const other=await fixture(t,clean);
  await mkdir(join(other.root,'test-artifacts/w7'),{recursive:true});
  const baseline=join(other.root,'test-artifacts/w7/before-390.png');
  await writeFile(baseline,'synthetic baseline'); commit(other.git);
  await writeFile(baseline,'changed input');
  assert.equal((await runner.runFullMain({root:other.root,suite:'app',timeoutMs:5000})).reason,'source_changed');
});
test('deadline terminates a SIGTERM-resistant descendant before returning', async t => {
  const {root,git}=await fixture(t,clean);
  const descendant=`require('fs').writeFileSync('.e2e/logs/descendant.log',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`;
  await writeFile(join(root,'scripts/parent.cjs'),`require('fs').mkdirSync('.e2e/logs',{recursive:true}); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); setInterval(()=>{},100);`);
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node scripts/parent.cjs'}})); commit(git);
  let pid;
  t.after(()=>{if(pid) try {process.kill(pid,'SIGKILL');} catch {}});
  // The deadline includes npm startup and both Node processes installing handlers.
  const receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  pid=Number(await readFile(join(root,'.e2e/logs/descendant.log'),'utf8'));
  assert.equal(receipt.reason,'deadline');
  // Allow the OS to reap an orphan after the group has been killed.
  await delay(100);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('scheduled paths execute full suites without changing PR or main-push gates',async()=>{
  for(const [file,suite] of [['ci.yml','app'],['e2e.yml','app-e2e']]){
    const workflow=await readFile(new URL(`../.github/workflows/${file}`,import.meta.url),'utf8');
    assert.match(workflow,/schedule:\n    - cron:/);assert.match(workflow,/workflow_dispatch:/);
    assert.match(workflow,new RegExp(`node scripts/full-main.mjs ${suite}\\b`));
    assert.match(workflow,new RegExp(`name: full-main-${suite}-receipt`));
    assert.match(workflow,new RegExp(`path: .*full-main-${suite}/receipt\\.json`));
    assert.doesNotMatch(workflow,/continue-on-error:/);
  }
});
test('canonical full-suite clean control and seeded failure publish bound counts, never raw errors',async t=>{
  assert.ok(runner,'full-main runner must exist');
  const {root,git}=await fixture(t,clean);
  let receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  assert.equal(receipt.status,'passed');assert.equal(receipt.counts.tests,1);assert.equal(receipt.counts.passed,1);
  assert.equal(receipt.source.sha,git('rev-parse','HEAD').toString().trim());assert.equal(receipt.fileCount,1);
  assert.equal(receipt.gateAuthority,false);assert.equal(receipt.mode,'shadow');
  assert.match(receipt.inventoryDigest,/^[a-f0-9]{64}$/);
  await writeFile(join(root,'test/seeded.test.mjs'),"import test from 'node:test'; test('SyntheticPrivateClient canary',()=>{throw Error('synthetic-secret-canary');});test('unconditional-green',()=>{});\n");
  git('add','test/seeded.test.mjs');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','seed failure');
  receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  assert.equal(receipt.status,'failed');assert.equal(receipt.counts.failed,1);assert.equal(receipt.failures[0]?.file,'test/seeded.test.mjs');
  assert.doesNotMatch(JSON.stringify(receipt),/SyntheticPrivateClient|synthetic-secret-canary/);
  const options=process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS='"--test_name_pattern=unconditional-green"';
    assert.notEqual((await runner.runFullMain({root,suite:'app',timeoutMs:5000})).status,'passed','filtered tests cannot certify a full suite');
  } finally {
    if(options===undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=options;
  }
});
test('empty exit-zero, nonzero, partial, exception, and deadline never certify a full suite',async t=>{
  assert.ok(runner,'full-main runner must exist');
  for(const [name,command,expected] of [['empty','node -e ""','unknown'],['refused','node -e "process.exit(75)"','failed'],['missing_ack',`node -e "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0')"`,'unknown'],['partial','node -e "console.log(\'# tests 1\')"','unknown'],['exception','node -e "throw Error(\'synthetic-secret-canary\')"','failed'],['deadline','node -e "setTimeout(()=>{},10000)"','failed']]){
    const {root,git}=await fixture(t,clean);
    await writeFile(join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:command}}));git('add','package.json');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m',name);
    const receipt=await runner.runFullMain({root,suite:'app',timeoutMs:name==='deadline'?200:5000});
    assert.equal(receipt.status,expected,name);assert.notEqual(receipt.status,'passed');
    assert.doesNotMatch(JSON.stringify(receipt),/synthetic-secret-canary/);
  }
});
test('execution cannot mutate source and still claim the initial tree passed',async t=>{
  assert.ok(runner,'full-main runner must exist');
  const {root,git}=await fixture(t,clean);
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:`node -e "require('fs').appendFileSync('test/seeded.test.mjs','// synthetic mutation')" && node --test test/*.test.mjs`}}));
  git('add','package.json');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','source mutation fixture');
  const receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  assert.equal(receipt.status,'failed');assert.equal(receipt.reason,'source_changed');assert.equal(receipt.counts?.passed,1);
});
test('untracked executable test inputs cannot borrow the selected source SHA',async t=>{
  const {root}=await fixture(t,clean);
  await writeFile(join(root,'test/untracked.test.mjs'),clean);
  const receipt=await runner.runFullMain({root,suite:'app',timeoutMs:5000});
  assert.equal(receipt.status,'failed');assert.equal(receipt.reason,'source_changed');assert.equal(receipt.counts,null);
  const other=await fixture(t,clean);
  await mkdir(join(other.root,'src'));
  await writeFile(join(other.root,'src/untracked.mjs'),'export const synthetic = true;');
  assert.notEqual((await runner.runFullMain({root:other.root,suite:'app',timeoutMs:5000})).status,'passed','untracked runtime code cannot borrow main source');
});
async function browserFixture(t, change = () => {}) {
  const f = await fixture(t,clean);
  const entries = ['first','second'].map(title=>({file:`tests/journeys/${title}.e2e.ts`,title}));
  const binding={repo:'jbookout/doctorcre-app',sourceCommit:'SOURCE',runId:'synthetic-native-run',
    workflowRunId:process.env.GITHUB_RUN_ID||'local',attempt:Number(process.env.GITHUB_RUN_ATTEMPT||1)};
  const proof = {
    native:{run:{id:'synthetic-native-run',vcs:{commit:'SOURCE',dirty:false},status:'passed',exitCode:0,
      results:entries.map(({file,title})=>({file,testId:`${file}::${encodeURIComponent(title)}`,selected:true,status:'passed',attempts:[{}]}))}},
    coverage:{binding:{...binding},
      rows:[...entries.map(({title})=>title),...continuityCases.map(({id})=>id)].map(id=>({id,status:'passed',attempts:1})),
      qualification:{broken:'failed',repaired:'passed'}},
    packet:{schema:'browser-product-proof.v1',binding:{...binding}},
  };
  change(proof);
  await mkdir(join(f.root,'tests/journeys'),{recursive:true});
  for (const {file} of entries) await writeFile(join(f.root,file),'// synthetic entry');
  await writeFile(join(f.root,'tests/journeys/required-coverage.json'),JSON.stringify({schema:'browser-journey-coverage.v1',tests:entries}));
  const script=`import {mkdir,writeFile} from 'node:fs/promises'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto'; import test from 'node:test';
    const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const proof=JSON.parse(${JSON.stringify(JSON.stringify(proof))}.replaceAll('SOURCE',source));
    await mkdir('.e2e/proof',{recursive:true});
    const coverage=JSON.stringify(proof.coverage);
    proof.packet.coverage={ref:'coverage.json',digest:createHash('sha256').update(coverage).digest('hex')};
    await writeFile('.e2e/report.json',JSON.stringify(proof.native));
    await writeFile('.e2e/proof/coverage.json',coverage);
    await writeFile('.e2e/proof/packet.json',JSON.stringify(proof.packet));
    test('synthetic continuity',()=>{});
    process.on('beforeExit',()=>console.log('# Candidate browser proof written to .e2e/proof/packet.json'));`;
  await writeFile(join(f.root,'scripts/browser-product-proof.mjs'),script);
  commit(f.git);
  return f;
}
test('browser fixtures honor hosted invocation bindings on reruns',()=>{
  const env={...process.env,GITHUB_RUN_ID:'37381471882',GITHUB_RUN_ATTEMPT:'2'};
  delete env.NODE_TEST_CONTEXT;
  const reporters=/(?:^|\s|["'])--test-reporter=tap(?:\s|["']|$)/.test((env.NODE_OPTIONS||'').replaceAll('_','-'))?[]:['--test-reporter=tap'];
  const result=spawnSync(process.execPath,['--test',...reporters,'--test-name-pattern=e2e acknowledgement|e2e does not reuse',fileURLToPath(import.meta.url)],{
    env,
    encoding:'utf8',timeout:30000,
  });
  assert.equal(result.status,0,result.error?.message||`${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/^# pass 2$/m);
});
test('e2e acknowledgement must bind complete manifest coverage to this invocation',async t=>{
  const {root}=await browserFixture(t);
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'passed');
  for (const [name,change] of [
    ['missing native entry',p=>p.native.run.results.pop()],
    ['missing journey',p=>p.coverage.rows.shift()],
    ['missing continuity',p=>p.coverage.rows.pop()],
    ['failed qualification',p=>p.coverage.qualification.repaired='failed'],
    ['wrong native run',p=>p.native.run.id='other-run'],
    ['wrong packet run',p=>p.packet.binding.runId='other-run'],
    ['wrong coverage run',p=>p.coverage.binding.runId='other-run'],
    ['wrong attempt',p=>{p.packet.binding.attempt++;p.coverage.binding.attempt++;}],
    ['wrong workflow run',p=>{p.packet.binding.workflowRunId+='-other';p.coverage.binding.workflowRunId+='-other';}],
    ['failed native entry',p=>p.native.run.results[0].status='failed'],
    ['retried native entry',p=>p.native.run.results[0].attempts.push({})],
    ['wrong source',p=>p.native.run.vcs.commit='a'.repeat(40)],
  ]) {
    const f=await browserFixture(t,change);
    assert.equal((await runner.runFullMain({root:f.root,suite:'app-e2e',timeoutMs:5000})).status,'unknown',name);
  }
});
test('e2e does not reuse a prior packet after an empty rerun',async t=>{
  const {root,git}=await browserFixture(t);
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'passed');
  await writeFile(join(root,'scripts/browser-product-proof.mjs'),''); commit(git);
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'unknown');
});
