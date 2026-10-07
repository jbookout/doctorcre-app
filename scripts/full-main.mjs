// Development-time shadow evidence; never an admission or release authority.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBrowserCompletion } from './browser-proof-contract.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const commands={app:['npm','test'],'app-e2e':[process.execPath,'scripts/browser-product-proof.mjs']};
// Node's TAP totals are accepted only after every numbered result and plan
// agrees, including nested tests and suite diagnostics. No test text is retained.
function tapCompletion() {
  let header=false, invalid=false, yamlIndent=null, pending=null;
  const frames=[{indent:0,results:0,plan:null,ended:false}];
  const observed={tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0};
  const totals={};
  const labels={tests:'tests',pass:'passed',fail:'failed',cancelled:'cancelled',skipped:'skipped',todo:'todo'};
  const finishResult=()=>{
    if(!pending) return;
    if(pending.suite&&(pending.status==='failed'||pending.status==='cancelled')) invalid=true;
    if(!pending.suite) { observed.tests++; observed[pending.status]++; }
    pending=null;
  };
  const validFrame=frame=>frame.plan!==null&&frame.plan===frame.results;
  return {
    line(line) {
      if(line==='TAP version 13') { if(header) invalid=true; header=true; return; }
      if(!header) return; // npm's command preamble precedes TAP.
      const indent=line.length-line.trimStart().length;
      const text=line.trim();
      if(yamlIndent!==null) {
        if(text==='...'&&indent===yamlIndent) yamlIndent=null;
        if(pending&&indent===yamlIndent) {
          if(text==="type: 'suite'") pending.suite=true;
          if(text==="failureType: 'cancelledByParent'") pending.status='cancelled';
        }
        return;
      }
      if(text==='---'&&pending) {yamlIndent=indent;return;}
      if(/^Bail out!/.test(text)) {invalid=true;return;}
      const total=line.match(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
      if(total) {
        finishResult();
        const name=labels[total[1]];
        if(name in totals) invalid=true;
        totals[name]=Number(total[2]);
        return;
      }
      const result=text.match(/^(not ok|ok) (\d+)(?:\s|$)/);
      const plan=text.match(/^1\.\.(\d+)(?:\s+#.*)?$/);
      if(!result&&!plan) {
        if(text&&!text.startsWith('#')) invalid=true;
        return;
      }
      finishResult();
      while(frames.at(-1).indent>indent) {if(!validFrame(frames.pop())) invalid=true;}
      if(frames.at(-1).indent<indent) {
        if(indent!==frames.at(-1).indent+4) invalid=true;
        frames.push({indent,results:0,plan:null,ended:false});
      }
      const frame=frames.at(-1);
      if(plan) {
        if(frame.plan!==null) invalid=true;
        frame.plan=Number(plan[1]);
        frame.ended=frame.results>0;
      } else {
        if(frame.ended||Number(result[2])!==++frame.results) invalid=true;
        const directive=text.match(/\s# (SKIP|TODO)\b/i)?.[1].toUpperCase();
        pending={suite:false,status:directive==='SKIP'?'skipped':directive==='TODO'?'todo':result[1]==='ok'?'passed':'failed'};
      }
    },
    counts() {
      finishResult();
      if(!header||invalid||yamlIndent!==null||!frames.every(validFrame)||frames[0].plan<=0) return null;
      if(!Object.keys(observed).every(name=>Number.isSafeInteger(totals[name])&&totals[name]===observed[name])||totals.tests<=0) return null;
      return totals;
    },
  };
}
async function execute(command,root,timeoutMs,allowedFailures) {
  return new Promise(resolveRun=>{
    let lineBuffer='',timedOut=false,spawnFailed=false;
    const tap=tapCompletion();
    let cleanup=Promise.resolve();
    const failures=new Map();
    const options=process.env.NODE_OPTIONS||'';
    const normalized=options.replaceAll('_','-');
    if(/(?:^|\s|["'])--test-(?:name-pattern|skip-pattern|only|shard|rerun-failures)(?:=|\s|["']|$)/.test(normalized))
      return resolveRun({code:1,selectionFiltered:true,counts:null,failures:[]});
    const reporter=/(?:^|\s|["'])--test-reporter=tap(?:\s|["']|$)/.test(normalized)?options:`${options} --test-reporter=tap`.trim();
    const env={...process.env,CI:'1',E2E_TELEMETRY_DISABLED:'1',NODE_OPTIONS:reporter};
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(command[0],command.slice(1),{cwd:root,detached:true,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{
      lineBuffer+=bytes.toString();
      const lines=lineBuffer.split('\n');lineBuffer=lines.pop();
      if(lineBuffer.length>65536) {tap.line('Bail out! oversized output line');lineBuffer='';}
      for(const line of lines) {
        tap.line(line);
        const match=line.match(/^\s+location:.*?(test\/[a-z0-9_-]+\.test\.mjs):(\d+):(\d+)/i);
        if(match&&allowedFailures.has(match[1])&&failures.size<50) failures.set(match[1]+':'+match[2],{file:match[1],line:Number(match[2]),column:Number(match[3])});
      }
    });
    // Consume errors without storing or forwarding client identifiers or secrets.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{spawnFailed=true;});
    const kill=signal=>{try{process.kill(-child.pid,signal);}catch{}};
    const timer=setTimeout(()=>{
      timedOut=true;
      kill('SIGTERM');
      // The group outlives its leader. Always finish escalation before returning.
      cleanup=new Promise(done=>setTimeout(()=>{kill('SIGKILL');done();},1000));
    },timeoutMs);
    child.on('close',async(code,signal)=>{
      clearTimeout(timer);
      await cleanup;
      if(lineBuffer) tap.line(lineBuffer);
      resolveRun({code,signal,timedOut,spawnFailed,counts:tap.counts(),failures:[...failures.values()]});
    });
  });
}
async function e2eCounts(root,source,counts) {
  const native=JSON.parse(await readFile(join(root,'.e2e/report.json'),'utf8'));
  const packet=JSON.parse(await readFile(join(root,'.e2e/proof/packet.json'),'utf8'));
  const coverageBytes=await readFile(join(root,'.e2e/proof/coverage.json'));
  const coverage=JSON.parse(coverageBytes);
  const {tests:entries}=JSON.parse(await readFile(join(root,'tests/journeys/required-coverage.json')));
  if(packet.coverage?.ref!=='coverage.json'||packet.coverage.digest!==digest(coverageBytes)) return null;
  const nativeCount=validateBrowserCompletion({native,packet,coverage,entries,sourceCommit:source.sha,
    workflowRunId:process.env.GITHUB_RUN_ID||'local',attempt:Number(process.env.GITHUB_RUN_ATTEMPT||1)});
  if(!counts||counts.failed||counts.cancelled) return null;
  return {...counts,tests:counts.tests+nativeCount,passed:counts.passed+nativeCount};
}
export async function runFullMain({root,suite,timeoutMs=suite==='app'?900000:540000}) {
  if(!commands[suite]||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>1200000) throw Error('invalid full-main invocation');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
  const source={sha:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};
  const paths=suite==='app'?(await readdir(join(root,'test'))).filter(name=>name.endsWith('.test.mjs')).map(name=>`test/${name}`).sort():['scripts/browser-product-proof.mjs',...(await readdir(join(root,'tests/journeys')).catch(()=>[])).filter(name=>name.endsWith('.e2e.ts')).map(name=>`tests/journeys/${name}`).sort()];
  const inventory=async()=>digest(JSON.stringify(await Promise.all(paths.map(async path=>[path,digest(await readFile(join(root,path)))]))));
  const inventoryDigest=await inventory();
  const tracked=git('ls-files','--',suite==='app'?'test':'tests/journeys').split('\n').filter(path=>suite==='app'?path.endsWith('.test.mjs'):path.endsWith('.e2e.ts')).sort();
  const declared=suite==='app'?paths:paths.slice(1);
  const trackedInventory=JSON.stringify(tracked)===JSON.stringify(declared);
  const fileCount=suite==='app'?paths.length:paths.length-1;
  const startedAt=new Date().toISOString();
  if(suite==='app-e2e') {
    for(const file of ['.e2e/report.json','.e2e/proof/packet.json','.e2e/proof/coverage.json']) await rm(join(root,file),{force:true});
  }
  // Tracked baselines are inputs. Only named output locations are exempt from
  // untracked checks; an ignored runtime module elsewhere still fails closed.
  const sourceDirty=()=>Boolean(git('diff','--name-only','HEAD'));
  const generatedOutput=path=>/^out\/test-artifacts\/.*\.png$/.test(path)||
    /^\.e2e\/artifacts\/[^/]+\/[^/]+\/[^/]+\/attempt-\d+\/(?:failure\/screen\.txt|screenshots\/[^/]+\.png|trace\/trace\.zip|video\/video\.webm)$/.test(path)||
    /^\.e2e\/(?:report\.json|junit\.xml|logs\/[^/]+\.log|full-main-[a-z-]+\/receipt\.json|proof\/(?:binding|build|coverage|packet|expected-template|native-report|qualification|written|readback|continuity-\d+-(?:reduce|no-preference))\.json|proof\/(?:build\.tar|video\.webm|trace\.zip|checkpoint\.png)|proof\/raw\/[^/]+\.webm)$/.test(path);
  const sourceInputsMatch=async()=>{
    const derived=new Map();
    const trackedPaths=new Set(git('ls-files','-z').split('\0'));
    if(trackedPaths.has('scripts/slices.mjs')) {
      const {sliceOutputs}=await import('./slices.mjs');
      const names=[...trackedPaths].filter(path=>/^js\/slices\/[^/]+\.js$/.test(path)).map(path=>path.split('/').at(-1).slice(0,-3)).sort();
      const {outputs}=await sliceOutputs(names,path=>execFileSync('git',['show',`${source.sha}:${path}`],{cwd:root,maxBuffer:32*1024*1024}));
      for(const [path,bytes] of outputs) derived.set(path,bytes);
    }
    const archive=await readFile(join(root,'dist/doctorcre-app.tar')).catch(()=>null);
    if(archive&&trackedPaths.has('scripts/artifact.mjs')) {
      const {verifyCommittedSource}=await import('./artifact.mjs');
      const built=await verifyCommittedSource(root,archive);
      derived.set('dist/doctorcre-app.tar',built.archive);
      derived.set('dist/doctorcre-app.manifest.json',built.manifestContent);
      derived.set('dist/doctorcre-app.tar.sha256',Buffer.from(`${built.archiveSha256}  doctorcre-app.tar\n`));
      for(const [path,bytes] of built.files) {
        derived.set(`dist/site/${path}`,bytes);
        derived.set(`.e2e/proof-build/${path}`,bytes);
      }
      derived.set('.e2e/proof-build/artifact-manifest.json',built.manifestContent);
    }
    for(const path of git('ls-files','--others','-z','--','.',':!:node_modules').split('\0').filter(Boolean)) {
      if(generatedOutput(path)) continue;
      if(!derived.has(path)||!(await readFile(join(root,path))).equals(derived.get(path))) return false;
    }
    return true;
  };
  const cleanSource=trackedInventory&&!sourceDirty()&&await sourceInputsMatch().catch(()=>false);
  const result=cleanSource?await execute(commands[suite],root,timeoutMs,new Set(suite==='app'?paths:['test/browser-product-proof.test.mjs'])):{code:null,sourceChanged:true,counts:null};
  result.sourceChanged=!cleanSource||sourceDirty()||git('rev-parse','HEAD')!==source.sha||await inventory()!==inventoryDigest||!await sourceInputsMatch().catch(()=>false);
  let counts=null;
  try{counts=suite==='app'?result.counts:await e2eCounts(root,source,result.counts);}catch{}
  if(fileCount===0) counts=null;
  const failed=result.sourceChanged||result.code!==0||result.timedOut||result.spawnFailed||Boolean(counts&&(counts.failed||counts.cancelled));
  const reason=result.sourceChanged?'source_changed':result.selectionFiltered?'filtered_selection':result.timedOut?'deadline':result.spawnFailed?'spawn_failed':result.code!==0?'suite_nonzero':!counts?'missing_completion':failed?'failed_counts':'complete';
  return {schema:'full-main-receipt.v1',repository:'jbookout/doctorcre-app',suite,mode:'shadow',gateAuthority:false,source,workflow:{runId:process.env.GITHUB_RUN_ID||'local',attempt:Number(process.env.GITHUB_RUN_ATTEMPT||1)},event:process.env.GITHUB_EVENT_NAME||'manual',startedAt,completedAt:new Date().toISOString(),timestampProvenance:'runner wall clock; hosted run timestamps independently authenticated by monitor',cadenceSeconds:86400,deadlineSeconds:timeoutMs/1000,command:suite==='app'?commands.app:['node','scripts/browser-product-proof.mjs'],fileCount,inventoryDigest,environment:{node:process.versions.node,platform:process.platform,arch:process.arch},status:failed?'failed':counts?'passed':'unknown',counts,failures:result.failures??[],reason};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    const suite=process.argv[2];
    const root=fileURLToPath(new URL('../',import.meta.url));
    if(!commands[suite]) throw Error('invalid suite');
    const output=join(root,'.e2e',`full-main-${suite}`,'receipt.json');
    await mkdir(join(root,'.e2e',`full-main-${suite}`),{recursive:true});
    await rm(output,{force:true});
    const receipt=await runFullMain({root,suite});
    await writeFile(output,JSON.stringify(receipt,null,2)+'\n');
    console.log(`Full main ${suite}: ${receipt.status}; ${receipt.counts?.tests??0} acknowledged tests; ${receipt.reason}`);
    process.exitCode=receipt.status==='passed'?0:1;
  }catch{console.error('Full main receipt unavailable: invocation or source binding failed');process.exitCode=1;}
}
