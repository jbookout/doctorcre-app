import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { execFileSync } from 'node:child_process';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const script = 'scripts/prove-deal-checklist-malformed-recovery.mjs';
function cli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../' + script, import.meta.url).pathname, ...args], {cwd});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('proof CLI help and invalid arguments', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '0']]) {
    assert.notEqual((await cli(args)).code, 0);
  }
});

test('declaration command reaches real fixture assertions and refuses missing proof inputs', async t => {
  const servers = [];
  async function prepare(mode) {
    await servers.at(-1)?.close();
    const routes = new Map(snapshot);
    if (mode === 'near-miss') {
      for (const [path, asset] of routes) routes.set(path, { ...asset, body: String(asset.body).replaceAll('Received', 'Received extra') });
    }
    routes.set('/app-release',{contentType:'application/json',body:JSON.stringify(mode==='release'?{}:{service:'doctorcre-app',environment:'production',source_commit:commit}),...(mode==='timeout'?{hold:'timeout'}:{})});
    if(mode==='export'||mode==='assertion')routes.set('/js/ui-checklist.generated.js',{contentType:'text/javascript',body:mode==='export'?'export const wrong = true;':'export function mountDealChecklist() { return {update(){},dispose(){}}; }'});
    const server = await startFixture({routes});servers.push(server);return server.origin;
  }
  t.after(()=>Promise.all(servers.map(server=>server.close())));
  const origin = await prepare('valid');
  const declaration = JSON.parse(await readFile('proofs/requirements/deal-checklist-malformed-recovery.json'));
  const args = declaration.assertions[0].predicate.match(/`([^`]+)`/)[1].split(' ').slice(2);
  args[args.indexOf('--origin') + 1] = origin;
  args[args.indexOf('--expected-commit') + 1] = commit;
  const result = await cli(args);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.natural.origin, origin);
  assert.equal(receipt.natural.assertions.length, 3);
  assert.ok(receipt.natural.loaded_module_urls.includes(`${origin}/js/ui-checklist.generated.js`));
  for (const failure of ['release', 'export', 'assertion', 'near-miss', 'timeout']) {
    const origin = await prepare(failure);
    const failed = await cli(['--origin', origin, '--expected-commit',commit, '--timeout-ms', failure === 'timeout' ? '100' : '30000']);
    assert.notEqual(failed.code, 0, failure);
    assert.equal(failed.code, ['release','timeout'].includes(failure)?78:1, JSON.stringify(failed));
  }
  assert.ok(servers.every(server=>server.requests.every(req=>req.method==='GET')));
});

import { prove } from '../scripts/prove-deal-checklist-malformed-recovery.mjs';
import { startWorkerFixture } from '../scripts/fixture-http.mjs';
const expected='a'.repeat(40),descendant='b'.repeat(40);
function setup(overrides={}){
 let alive=0,closed=0;
 const browser={newPage:async()=>({}),close:async()=>{alive=0;closed++;}};
 const engine={launch:async()=>{alive++;return browser;}};
 return {options:{origin:'http://localhost',expectedCommit:expected,timeoutMs:1000,engine,readRelease:async()=>({source_commit:expected}),observe:async()=>({assertions:['synthetic natural observation']}),...overrides},alive:()=>alive,closed:()=>closed};
}
test('real release ancestry accepts equal and descendant and refuses older unrelated unknown',async t=>{
 const {requireContainingRelease}=await import('../scripts/prove-fact-review-pending-status-view.mjs');
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {writeFile}=await import('node:fs/promises');
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const exec=promisify(execFile),root=temporaryDirectory('attribution-ancestry-',t);
 const git=async(...args)=>(await exec('git',args,{cwd:root})).stdout.trim();
 await git('init','-q');await git('config','user.name','Synthetic');await git('config','user.email','synthetic@example.invalid');
 const commit=async label=>{await writeFile(root+'/fixture',label);await git('add','fixture');await git('commit','-qm',label);return git('rev-parse','HEAD');};
 const older=await commit('older'),equal=await commit('equal'),descendant=await commit('descendant');
 await git('checkout','--orphan','unrelated');const unrelated=await commit('unrelated');
 for(const [name,source,code] of [['equal',equal,0],['descendant',descendant,0],['older',older,78],['unrelated',unrelated,78],['unknown','f'.repeat(40),78]]){
  const s=setup({expectedCommit:equal,readRelease:async()=>({source_commit:source}),contains:(a,b,options)=>requireContainingRelease(a,b,{...options,cwd:root})});
  assert.equal((await prove(s.options)).exitCode,code,name);assert.equal(s.alive(),0);
  const routes = new Map(snapshot);
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:source})});
  const server = await startFixture({routes});
  try { const result = await cli(['--origin',server.origin,'--expected-commit',equal],root); assert.equal(result.code,code,JSON.stringify({name,...result})); } finally { await server.close(); }
 }
});
test('containing release assertion failure exits 1 and closes acquired browser',async()=>{
 const s=setup({contains:async()=>{},observe:async()=>{throw Error('synthetic incorrect credit');}});const result=await prove(s.options);assert.equal(result.exitCode,1);assert.equal(s.alive(),0);
});
test('missing session and missing subject are insufficient evidence',async()=>{
 for(const reason of ['No session','No activity']){
  const s=setup({contains:async()=>{},observe:async()=>{throw Object.assign(Error(reason),{exitCode:78});}});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
 }
});
test('release change refuses a previously containing proof',async()=>{
 let calls=0;const s=setup({contains:async()=>{},readRelease:async()=>({source_commit:++calls===1?expected:descendant})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
});
test('stalled evaluation exits 78 with no surviving acquired browser',async()=>{
 const s=setup({contains:async()=>{},timeoutMs:25,observe:()=>new Promise(()=>{})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);assert.ok(s.closed()>=1);
});
test('late launch exits 78 and closes the late acquired browser',async()=>{
 let alive=0,release;
 const pending=new Promise(resolve=>release=resolve);
 const s=setup({contains:async()=>{},timeoutMs:25,engine:{launch:()=>pending}});
 const result=await prove(s.options);assert.equal(result.exitCode,78);
 alive++;release({close:async()=>alive--});
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(alive,0);
});
test('release read shares the total deadline',async()=>{
 const s=setup({timeoutMs:25,readRelease:()=>new Promise(()=>{})});assert.equal((await prove(s.options)).exitCode,78);assert.equal(s.alive(),0);
});
test('actual stalled browser evaluation is closed at the total deadline',async()=>{
 const {chromium}=await import('../scripts/proof-browser.mjs');let acquired;
 const s=setup({timeoutMs:3000,contains:async()=>{},engine:{launch:async options=>acquired=await chromium.launch(options)},observe:page=>page.evaluate(()=>new Promise(()=>{}))});
 assert.equal((await prove(s.options)).exitCode,78);assert.ok(acquired);assert.equal(acquired.isConnected(),false);
});
test('actual late browser acquisition closes after deadline without leaving its process alive',async()=>{
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const acquired=await chromium.launch();let resolve;
 const pending=new Promise(r=>resolve=r);
 try{
  const s=setup({timeoutMs:25,contains:async()=>{},engine:{launch:()=>pending}});
  assert.equal((await prove(s.options)).exitCode,78);
  const closed=new Promise(r=>acquired.once('disconnected',r));resolve(acquired);await closed;
  assert.equal(acquired.isConnected(),false);
 }finally{await acquired.close();}
});
test('CLI acquisition failures refuse evidence and late CDP pages are closed before disconnect',async t=>{
 const {writeFile}=await import('node:fs/promises');
 const {pathToFileURL,fileURLToPath}=await import('node:url');
 const {execFile}=await import('node:child_process');
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const {chromium:cdp}=await import('playwright');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const commit=await new Promise((yes,no)=>execFile('git',['rev-parse','HEAD'],{cwd:root},(error,out)=>error?no(error):yes(out.trim())));
 const server=await startWorkerFixture({env:{APP_ENV:'production',GIT_SHA:commit}});
 t.after(()=>server.close());
 const origin=server.origin;

 const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
 const endpoint = browserFixture.endpoint;
 const browser=browserFixture.browser;t.after(()=>browser.close());
 const existing=browserFixture.page;
 const scratch=temporaryDirectory('attribution-acquisition-',t);
 const playwrightURL=import.meta.resolve('playwright');
 for(const mode of ['unreachable','connect-rejection','retired-context','missing-context','late-page'])await t.test(mode,async()=>{
  const preload=`${scratch}/${mode}.mjs`;
  await writeFile(preload,`
   import {chromium} from ${JSON.stringify(playwrightURL)};
   const connect=chromium.connectOverCDP.bind(chromium);
   chromium.connectOverCDP=async(...args)=>{
    if(${JSON.stringify(mode)}==='connect-rejection')throw Error('Synthetic CDP rejection');
    const browser=await connect(...args);
    const context=browser.contexts()[0];
    const newPage=context.newPage.bind(context);
    if(${JSON.stringify(mode)}==='retired-context')context.newPage=async()=>{throw Error('Target page, context or browser has been closed');};
    if(${JSON.stringify(mode)}==='missing-context')browser.contexts=()=>[];
    if(${JSON.stringify(mode)}==='late-page')context.newPage=async()=>{const page=await newPage();await new Promise(r=>setTimeout(r,2000));return page;};
    return browser;
   };
  `);
  const result=await new Promise(resolve=>execFile(process.execPath,['--import',pathToFileURL(preload).href,'scripts/prove-deal-checklist-malformed-recovery.mjs','--origin',origin,'--expected-commit',commit,'--cdp-url',mode==='unreachable'?'http://127.0.0.1:1':endpoint,'--timeout-ms','1500'],{cwd:root,timeout:10000},(error,stdout,stderr)=>resolve({code:error?.code||0,receipt:stdout.trim()?JSON.parse(stdout.trim()):null,stderr})));
  assert.equal(result.code,78,JSON.stringify(result));assert.equal(result.receipt.status,'insufficient_evidence');
  const fresh=await cdp.connectOverCDP(endpoint);
  try{assert.equal(fresh.contexts().flatMap(c=>c.pages()).length,1,'only the pre-existing tab survives');}finally{await fresh.close();}
  assert.equal(existing.isClosed(),false);assert.equal(browser.isConnected(),true);
 });
});
