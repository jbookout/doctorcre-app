import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const runnerUrl=new URL('../scripts/run-child.mjs',import.meta.url);
const {runChild}=await import(runnerUrl);

async function waitFor(path) {
  for(let attempt=0;attempt<100;attempt++) {
    const value=await readFile(path,'utf8').catch(()=>null);
    if(value!==null) return value;
    await delay(25);
  }
  throw Error(`timed out waiting for ${path}`);
}

test('SIGTERM reaches the active child and waits for its graceful cleanup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'app-run-child-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const childPath=join(root,'child.cjs');
  const harnessPath=join(root,'harness.mjs');
  await writeFile(childPath,`require('fs').writeFileSync('ready.log','ready'); process.on('SIGTERM',()=>setTimeout(()=>{require('fs').writeFileSync('closed.log','closed');process.exit(0);},500)); setInterval(()=>{},100);`);
  await writeFile(harnessPath,`import {runChild} from ${JSON.stringify(runnerUrl.href)}; try {await runChild(process.execPath,[${JSON.stringify(childPath)}],{cwd:${JSON.stringify(root)},stdio:'ignore'});} catch {}`);
  const harness=spawn(process.execPath,[harnessPath],{cwd:root,stdio:'ignore'});
  t.after(()=>{try{harness.kill('SIGKILL');}catch{}});
  await waitFor(join(root,'ready.log'));
  harness.kill('SIGTERM');
  const closed=new Promise((resolve,reject)=>{
    harness.once('error',reject);
    harness.once('close',(code,signal)=>resolve({code,signal}));
  });
  const result=await Promise.race([closed,delay(5000,undefined,{ref:false}).then(()=>{throw Error('leader did not exit after child cleanup');})]);
  assert.deepEqual(result,{code:0,signal:null});
  assert.equal(await readFile(join(root,'closed.log'),'utf8'),'closed');
});

test('timeout force-kills a child that ignores SIGTERM within a bounded grace',async t=>{
  const root=await mkdtemp(join(tmpdir(),'app-run-child-timeout-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const childPath=join(root,'child.cjs');
  const pidPath=join(root,'pid.log');
  await writeFile(childPath,`require('fs').writeFileSync('pid.log',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`);
  const started=Date.now();
  const pending=runChild(process.execPath,[childPath],{cwd:root,stdio:'ignore',timeout:1000});
  const pid=Number(await waitFor(pidPath));
  try {
    await assert.rejects(
      Promise.race([pending,delay(3500,undefined,{ref:false}).then(()=>{throw Error('SIGTERM-resistant child survived the timeout bound');})]),
      error=>error.signal==='SIGKILL',
    );
    assert.ok(Date.now()-started<3500,'forced termination must stay inside the timeout bound');
  } finally {
    try{process.kill(pid,'SIGKILL');}catch{}
    await pending.catch(()=>{});
  }
});
