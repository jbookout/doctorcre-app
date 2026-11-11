import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const assets = await proofAssetSnapshot();
import {prove} from '../scripts/prove-activity-attribution-panel.mjs';
const expected='a'.repeat(40),descendant='b'.repeat(40);
function setup(overrides={}){
 let alive=0,closed=0;
 const browser={newPage:async()=>({}),close:async()=>{alive=0;closed++;}};
 const engine={launch:async()=>{alive++;return browser;}};
 return {options:{origin:'http://localhost',expectedCommit:expected,timeoutMs:1000,engine,readRelease:async()=>({source_commit:expected}),observe:async()=>({assertions:['synthetic natural observation']}),...overrides},alive:()=>alive,closed:()=>closed};
}
for(const relation of ['equal','descendant','older','unrelated','unknown'])test(`proof requires ${relation} release containment`,async()=>{
 const s=setup({readRelease:async()=>({source_commit:relation==='equal'?expected:descendant}),contains:async(a,b)=>{assert.equal(a,expected);if(!['equal','descendant'].includes(relation))throw Error('No ancestry evidence');}});
 const result=await prove(s.options);assert.equal(result.exitCode,['equal','descendant'].includes(relation)?0:78);assert.equal(s.alive(),0);
});
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
test('real CLI fixture passes, detects incorrect credit and preserves the supplied browser',async t=>{
 const {readFile}=await import('node:fs/promises');
 const {fileURLToPath}=await import('node:url');
 const {execFile}=await import('node:child_process');
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const commit=await new Promise((yes,no)=>execFile('git',['rev-parse','HEAD'],{cwd:root},(error,out)=>error?no(error):yes(out.trim())));
 const recording=JSON.parse(await readFile(new URL('./fixtures/activity-attribution-panel/recordings.json',import.meta.url)));
 let server;
 const start=async(mutation,response=recording.cases[0].response)=>{
  await server?.close();
  server=await startWorkerFixture({assets,routes:new Map([['/deals',{contentType:'text/html',body:`<!doctype html><div class="kanban-card" hidden><button class="card-open">Open synthetic deal</button></div><main hidden><form id="detailUpdateForm">Synthetic detail</form><div id="updates"></div></main><script type="module">
    import {renderDealUpdates,mountActivityAttribution} from '/js/deal-timeline.js';
    setTimeout(()=>document.querySelector('.kanban-card').hidden=false,100);
    const id=${JSON.stringify(recording.activity_id)};
    updates.innerHTML=renderDealUpdates({entries:[{id,kind:'note',summary:'Synthetic fixture activity',when:'2026-11-01T12:00:00Z'}],activities:[{id}]});
    mountActivityAttribution(updates);
    document.querySelector('.card-open').onclick=()=>document.querySelector('main').hidden=false;
    new MutationObserver(()=>{for(const p of updates.querySelectorAll('p,li,h4,a,summary'))if(p.textContent===${JSON.stringify(mutation?.[0])})p.textContent=${JSON.stringify(mutation?.[1])};}).observe(updates,{subtree:true,childList:true,characterData:true});
   </script>`}]]),env:{APP_ENV:'production',GIT_SHA:commit,CARR:{fetch:async request=>{
   if(new URL(request.url).pathname==='/mcp'){
    const body=await request.json();
    return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(response)}]}});
   }
   return new Response('signed in');
  }}}});
 };
 t.after(()=>server?.close());
 await start();

 const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
 const browser=browserFixture.browser;t.after(()=>browser.close());
 const existing=browserFixture.page;await existing.goto('about:blank');
 const run=()=>new Promise(resolve=>execFile(process.execPath,['scripts/prove-activity-attribution-panel.mjs','--origin',server.origin,'--expected-commit',commit,'--cdp-url',browserFixture.endpoint],{cwd:root,timeout:35000},(error,stdout,stderr)=>resolve({code:error?.code||0,receipt:stdout.trim()?JSON.parse(stdout.trim()):null,stderr})));
 const passing=await run();assert.equal(passing.code,0,JSON.stringify(passing));assert.equal(passing.receipt.status,'passed');assert.equal(browser.isConnected(),true);assert.equal(existing.isClosed(),false);
 for(const mutation of [
  ['1 credited activities','0 credited activities'],
  ['1 credited activities','11 credited activities'],
  ['Coverage complete.','Coverage incomplete.'],
  ['Direct deal attribution','Wrong direct deal attribution'],
  ['Synthetic <Practice> & Lease','Synthetic <Practice> & Lease wrong'],
  ['Synthetic <Practice> & Lease, deal version 4.','Synthetic <Practice> & Lease, deal version 14.'],
  [`Activity ${recording.activity_id}, version 3.`,`Activity ${recording.activity_id}, version 13.`],
  [`Activity ${recording.activity_id}, version 3. Source activity:${recording.activity_id}. Source version synthetic-v2.`,`Activity ${recording.activity_id}, version 13. Source activity:${recording.activity_id}. Source version synthetic-v2.`],
 ]){
  await start(mutation);const failing=await run();assert.equal(failing.code,1,JSON.stringify({mutation,...failing}));assert.equal(failing.receipt.status,'failed');assert.equal(browser.isConnected(),true);assert.equal(existing.isClosed(),false);
 }

 for(const {name,response} of recording.cases){
  await start(undefined,response);const result=await run();assert.equal(result.code,0,JSON.stringify({name,...result}));
 }
 await start(['Review candidates. These links receive no activity credit.','Review candidates. These links receive no activity credit. Wrong.'],recording.cases.find(row=>row.name==='source_linked').response);
 const wrongReview=await run();assert.equal(wrongReview.code,1,JSON.stringify(wrongReview));
 assert.equal(browser.contexts().flatMap(c=>c.pages()).length,1);
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
  const result=await new Promise(resolve=>execFile(process.execPath,['--import',pathToFileURL(preload).href,'scripts/prove-activity-attribution-panel.mjs','--origin',origin,'--expected-commit',commit,'--cdp-url',mode==='unreachable'?'http://127.0.0.1:1':endpoint,'--timeout-ms','1500'],{cwd:root,timeout:10000},(error,stdout,stderr)=>resolve({code:error?.code||0,receipt:stdout.trim()?JSON.parse(stdout.trim()):null,stderr})));
  assert.equal(result.code,78,JSON.stringify(result));assert.equal(result.receipt.status,'insufficient_evidence');
  const fresh=await cdp.connectOverCDP(endpoint);
  try{assert.equal(fresh.contexts().flatMap(c=>c.pages()).length,1,'only the pre-existing tab survives');}finally{await fresh.close();}
  assert.equal(existing.isClosed(),false);assert.equal(browser.isConnected(),true);
 });
});
