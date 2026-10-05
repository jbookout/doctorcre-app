// Deterministic product evidence. No model, personal session or production target.
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from './artifact.mjs';
import { journeyFiles, continuityCases, requiredNativeEntries } from './browser-proof-contract.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=join(root,'.e2e/proof');
const buildRoot=join(root,'.e2e/proof-build');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const run=(args,env={})=>execFileSync(process.execPath,args,{cwd:root,env:{...process.env,CI:'1',E2E_TELEMETRY_DISABLED:'1',...env},stdio:'inherit',timeout:480_000});
async function filesDigest(paths) {
  return sha(JSON.stringify(await Promise.all(paths.sort().map(async path=>[path,sha(await readFile(join(root,path)))]))));
}
let phase='source';
const journeys=journeyFiles.map(file=>file.split('/').at(-1).replace(/\.e2e\.ts$/, ''));
const continuity=continuityCases.map(({id})=>id);

try {
  if(git('status','--porcelain','--untracked-files=no')) throw Error('product proof requires committed source');
  await rm(output,{recursive:true,force:true});
  await rm(buildRoot,{recursive:true,force:true});
  await mkdir(output,{recursive:true});
  await mkdir(buildRoot,{recursive:true});
  const sourceCommit=git('rev-parse','HEAD');
  phase='build';
  const built=await buildArtifact({root,outDir:join(root,'dist'),commit:sourceCommit});
  run(['scripts/build-artifact.mjs','verify']);
  // Build is generated here, verified before extraction, and contains only files.
  execFileSync('tar',['-xf',join(root,'dist/doctorcre-app.tar'),'-C',buildRoot],{cwd:root,timeout:30_000});
  const servedBuild={sourceCommit,manifestDigest:sha(await readFile(join(root,'dist/doctorcre-app.manifest.json')))};
  const runtime={e2e:JSON.parse(await readFile(join(root,'node_modules/e2e/package.json'))).version,web:JSON.parse(await readFile(join(root,'node_modules/@e2e-dev/web/package.json'))).version,playwright:JSON.parse(await readFile(join(root,'node_modules/playwright/package.json'))).version,node:process.versions.node,browser:'chromium'};
  const requiredNativeTests=requiredNativeEntries.map(row=>`${row.file}::${encodeURIComponent(row.title)}`);
  const buildConfigDigest=await filesDigest(['tests/journeys/required-coverage.json','e2e.config.ts','package-lock.json','scripts/serve.mjs','scripts/work-inventory-fixture.mjs','scripts/browser-product-proof.mjs','scripts/browser-proof-contract.mjs','test/browser-harness.mjs','test/browser-product-proof.test.mjs','tests/journeys/test.mjs','tests/journeys/browser-continuity.mjs',...journeyFiles]);
  const fixtureDigest=await filesDigest(['data/board-seed.json','tests/journeys/browser-continuity.mjs']);
  // Run from this invocation's extracted archive. Old reports cannot satisfy it.
  phase='native-journeys';
  run(['node_modules/e2e/dist/cli/bin.js','run','tests/journeys','--reporter','list,junit'],{BROWSER_PROOF_ROOT:buildRoot,BROWSER_PROOF_BINDING:JSON.stringify(servedBuild)});
  const native=JSON.parse(await readFile(join(root,'.e2e/report.json')));
  if(native.run?.vcs?.commit!==sourceCommit || native.run.vcs.dirty!==false || native.run.exitCode!==0 || native.run.status!=='passed') throw Error('native runner failed or source identity changed');
  for(const id of requiredNativeTests) {
    const row=native.run.results.find(row=>row.testId===id && row.selected);
    if(!row || row.status!=='passed' || row.attempts.length!==1) throw Error(`required native entry point incomplete: ${id}`);
  }
  const binding={repo:'jbookout/doctorcre-app',sourceCommit,buildDigest:built.archiveSha256,buildConfigDigest,fixtureDigest,runtime,runId:native.run.id,attempt:Number(process.env.GITHUB_RUN_ATTEMPT||1)};
  await writeFile(join(output,'binding.json'),JSON.stringify(binding));
  phase='continuity';
  run(['--test','test/browser-product-proof.test.mjs'],{BROWSER_PROOF_DIR:output,DOCTORCRE_FIXTURE_ROOT:buildRoot,BROWSER_PROOF_BINDING:JSON.stringify(servedBuild)});
  phase='packet';
  const rows=[];
  for(const id of journeys) {
    const matches=native.run.results.filter(row=>row.selected && row.file===`tests/journeys/${id}.e2e.ts`);
    if(!matches.length) throw Error(`required journey was not exercised: ${id}`);
    rows.push({id,status:matches.every(row=>row.status==='passed' && row.attempts.length===1)?'passed':'failed',attempts:Math.max(...matches.map(row=>row.attempts.length))});
  }
  for(const id of continuity) rows.push(JSON.parse(await readFile(join(output,`${id}.json`))));
  const qualification=JSON.parse(await readFile(join(output,'qualification.json')));
  if(rows.some(row=>row.status!=='passed') || qualification.broken!=='failed' || qualification.repaired!=='passed') throw Error('required continuity or qualification failed');
  const put=async(ref,value)=>{await writeFile(join(output,ref),JSON.stringify(value));return refFor(ref);};
  const refFor=async ref=>({ref,digest:sha(await readFile(join(output,ref)))});
  const coverage=await put('coverage.json',{binding,rows:rows.map(({id,status,attempts})=>({id,status,attempts})),qualification:{broken:qualification.broken,repaired:qualification.repaired}});
  const build=await put('build.json',{binding,manifestFiles:built.manifest.files,servedBuild});
  const values=rows.find(row=>row.id==='continuity-390-reduce').values;
  const written=await put('written.json',{binding,phase:'write',value:values.written});
  const readback=await put('readback.json',{binding,phase:'reload',value:values.readback});
  await copyFile(join(root,'.e2e/report.json'),join(output,'native-report.json'));
  await copyFile(join(root,'dist/doctorcre-app.tar'),join(output,'build.tar'));
  const ghRun=process.env.GITHUB_RUN_ID||'0';
  if(!/^\d+$/.test(ghRun)) throw Error('invalid workflow run');
  const link=`https://github.com/jbookout/doctorcre-app/actions/runs/${ghRun}`;
  const packet={schema:'browser-product-proof.v1',binding,build,coverage,buildArchive:await refFor('build.tar'),nativeReport:await refFor('native-report.json'),persistence:[{id:'draft-reload',written,readback}],recordings:[{id:'draft-reload',operation:'save-reload',video:await refFor('video.webm'),trace:await refFor('trace.zip'),checkpoint:await refFor('checkpoint.png')}],links:{run:link,artifacts:link},metrics:{firstReviewUiFindings:null,reproductionMinutes:null}};
  await writeFile(join(output,'packet.json'),JSON.stringify(packet,null,2)+'\n');
  // This is a producer template for local qualification. Delivery intake must
  // authenticate these fields from the orchestrator's exact source/build inputs.
  await writeFile(join(output,'expected-template.json'),JSON.stringify({...binding,requiredNativeTests,requiredCoverage:[...journeys,...continuity],requiredPersistence:['draft-reload'],requiredRecordings:[{id:'draft-reload',operation:'save-reload'}]},null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,`Browser proof for ${sourceCommit}: ${rows.length} required paths.\n\n[Run and downloadable video/trace packet](${link})\n\nFirst-review UI findings and reproduction minutes remain unmeasured.\n`,{flag:'a'});
  console.log('Candidate browser proof written to .e2e/proof/packet.json');
} catch (error) { console.error(`Browser product proof refused in ${phase}: ${error.message}`);process.exitCode=1; }
