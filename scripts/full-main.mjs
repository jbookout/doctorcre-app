// Development-time shadow evidence; never an admission or release authority.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const commands={app:['npm','test'],'app-e2e':[process.execPath,'scripts/browser-product-proof.mjs']};
function tapCounts(output,acknowledged) {
  if(!acknowledged) return null;
  const fields={tests:'tests',passed:'pass',failed:'fail',cancelled:'cancelled',skipped:'skipped',todo:'todo'};
  const counts={};
  for(const [name,label] of Object.entries(fields)) {
    const matches=[...output.matchAll(new RegExp(`^# ${label} (\\d+)$`,'gm'))];
    if(!matches.length) return null;
    counts[name]=Number(matches.at(-1)[1]);
  }
  if(!Object.values(counts).every(Number.isSafeInteger)||counts.tests<=0||counts.tests!==counts.passed+counts.failed+counts.cancelled+counts.skipped+counts.todo) return null;
  return counts;
}
async function execute(command,root,timeoutMs,allowedFailures) {
  return new Promise(resolveRun=>{
    let sawTapHeader=false,tail='',lineBuffer='',timedOut=false,spawnFailed=false,killTimer;
    const failures=new Map();
    const options=process.env.NODE_OPTIONS||'';
    if(/(?:^|\s|")--test-(?:name-pattern|skip-pattern|only|shard|rerun-failures)(?:=|\s|"|$)/.test(options))
      return resolveRun({code:1,selectionFiltered:true,tail:'',sawTapHeader:false,failures:[]});
    const reporter=/(?:^|\s|")--test-reporter=tap(?:\s|"|$)/.test(options)?options:`${options} --test-reporter=tap`.trim();
    const env={...process.env,CI:'1',E2E_TELEMETRY_DISABLED:'1',NODE_OPTIONS:reporter};
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(command[0],command.slice(1),{cwd:root,detached:true,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{
      tail=(tail+bytes.toString()).slice(-65536);
      lineBuffer+=bytes.toString();
      const lines=lineBuffer.split('\n');lineBuffer=lines.pop().slice(-4096);
      for(const line of lines) {
        if(line==='TAP version 13') sawTapHeader=true;
        const match=line.match(/^\s+location:.*?(test\/[a-z0-9_-]+\.test\.mjs):(\d+):(\d+)/i);
        if(match&&allowedFailures.has(match[1])&&failures.size<50) failures.set(match[1]+':'+match[2],{file:match[1],line:Number(match[2]),column:Number(match[3])});
      }
    });
    // Consume errors without storing or forwarding client identifiers or secrets.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{spawnFailed=true;});
    const kill=signal=>{try{process.kill(-child.pid,signal);}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);},timeoutMs);
    child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolveRun({code,signal,timedOut,spawnFailed,tail,sawTapHeader,failures:[...failures.values()]});});
  });
}
async function e2eCounts(root,source,output,acknowledged) {
  const native=JSON.parse(await readFile(join(root,'.e2e/report.json'),'utf8'));
  const packet=JSON.parse(await readFile(join(root,'.e2e/proof/packet.json'),'utf8'));
  const coverageBytes=await readFile(join(root,'.e2e/proof/coverage.json'));
  const coverage=JSON.parse(coverageBytes);
  if(native.run?.vcs?.commit!==source.sha||native.run.vcs.dirty!==false||native.run.status!=='passed'||native.run.exitCode!==0||packet.schema!=='browser-product-proof.v1'||packet.coverage?.ref!=='coverage.json'||packet.coverage.digest!==digest(coverageBytes)||packet.binding?.sourceCommit!==source.sha||coverage.binding?.sourceCommit!==source.sha) return null;
  const selected=native.run.results.filter(row=>row.selected);
  if(!selected.length||selected.some(row=>row.status!=='passed'||row.attempts?.length!==1)||!coverage.rows?.length||coverage.rows.some(row=>row.status!=='passed'||row.attempts!==1)) return null;
  const continuity=tapCounts(output,acknowledged);
  if(!continuity||continuity.failed||continuity.cancelled) return null;
  return {...continuity,tests:continuity.tests+selected.length,passed:continuity.passed+selected.length};
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
  // Browser screenshots are declared test outputs, even when older versions
  // remain tracked. All other tracked paths and the selected commit must stay fixed.
  const sourceDirty=()=>git('diff','--name-only','HEAD').split('\n').some(path=>path&&!path.startsWith('test-artifacts/'));
  const untrackedInputs=()=>git('ls-files','--others','--exclude-standard','--','test','tests/journeys');
  const cleanSource=trackedInventory&&!untrackedInputs()&&!sourceDirty();
  const result=cleanSource?await execute(commands[suite],root,timeoutMs,new Set(suite==='app'?paths:['test/browser-product-proof.test.mjs'])):{code:null,sourceChanged:true,tail:''};
  result.sourceChanged=!cleanSource||Boolean(untrackedInputs())||sourceDirty()||git('rev-parse','HEAD')!==source.sha||await inventory()!==inventoryDigest;
  let counts=null;
  try{counts=suite==='app'?tapCounts(result.tail,result.sawTapHeader):await e2eCounts(root,source,result.tail,result.sawTapHeader);}catch{}
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
