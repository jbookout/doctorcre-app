import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runner = await import('../scripts/full-main.mjs').catch(() => null);
async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'app-full-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test')); await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'package.json'), JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.mjs'}}));
  await writeFile(join(root, 'test/seeded.test.mjs'), body);
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init');git('add','package.json','test/seeded.test.mjs');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','fixture');
  return {root,git};
}
const clean="import test from 'node:test'; test('synthetic full-suite case',()=>{});\n";
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
    process.env.NODE_OPTIONS='"--test-name-pattern=unconditional-green"';
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
});
test('e2e acknowledgement must bind the native runner and complete packet to this source',async t=>{
  assert.ok(runner,'full-main runner must exist');
  const {root,git}=await fixture(t,clean);
  const script=`import {mkdir,writeFile} from 'node:fs/promises'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto'; const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); await mkdir('.e2e/proof',{recursive:true}); const coverage=JSON.stringify({binding:{sourceCommit:source},rows:[{id:'synthetic',status:'passed',attempts:1}]}); await writeFile('.e2e/report.json',JSON.stringify({run:{vcs:{commit:source,dirty:false},status:'passed',exitCode:0,results:[{selected:true,status:'passed',attempts:[{}]}]}})); await writeFile('.e2e/proof/packet.json',JSON.stringify({schema:'browser-product-proof.v1',binding:{sourceCommit:source},coverage:{ref:'coverage.json',digest:createHash('sha256').update(coverage).digest('hex')}})); await writeFile('.e2e/proof/coverage.json',coverage); console.log('TAP version 13\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0');`;
  await mkdir(join(root,'tests/journeys'),{recursive:true}); await writeFile(join(root,'tests/journeys/synthetic.e2e.ts'),'// synthetic native entry');
  const commit=()=>{git('add','scripts/browser-product-proof.mjs','tests/journeys/synthetic.e2e.ts');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','proof fixture');};
  await writeFile(join(root,'scripts/browser-product-proof.mjs'),script);
  commit();
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'passed');
  await writeFile(join(root,'scripts/browser-product-proof.mjs'),''); commit();
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'unknown','old acknowledgement is removed before rerun');
  await writeFile(join(root,'scripts/browser-product-proof.mjs'),script.replace(/status:'passed'/g,"status:'failed'")); commit();
  assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'unknown');
  for(const broken of [
    script.replace('results:[{selected:true', 'results:[{selected:false'),
    script.replace('attempts:[{}]', 'attempts:[{},{}]'),
    script.replace('vcs:{commit:source', "vcs:{commit:'a'.repeat(40)"),
    script.replace("digest:createHash('sha256').update(coverage).digest('hex')", "digest:'a'.repeat(64)"),
    script.replace('# pass 1', '# pass 0'),
  ]) {
    await writeFile(join(root,'scripts/browser-product-proof.mjs'),broken);commit();
    assert.equal((await runner.runFullMain({root,suite:'app-e2e',timeoutMs:5000})).status,'unknown');
  }
});
