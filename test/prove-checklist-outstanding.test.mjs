import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import {prove} from '../scripts/prove-checklist-outstanding.mjs';
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
 const reserve=await startFixture();const port=new URL(reserve.origin).port;await reserve.close();
 const endpoint=`http://127.0.0.1:${port}`;
 const browser=await chromium.launch({args:[`--remote-debugging-port=${port}`]});t.after(()=>browser.close());
 const existing=await browser.newPage();
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
  const result=await new Promise(resolve=>execFile(process.execPath,['--import',pathToFileURL(preload).href,'scripts/prove-checklist-outstanding.mjs','--origin',origin,'--expected-commit',commit,'--cdp-url',mode==='unreachable'?'http://127.0.0.1:1':endpoint,'--timeout-ms','1500'],{cwd:root,timeout:10000},(error,stdout,stderr)=>resolve({code:error?.code||0,receipt:stdout.trim()?JSON.parse(stdout.trim()):null,stderr})));
  assert.equal(result.code,78,JSON.stringify(result));assert.equal(result.receipt.status,'insufficient_evidence');
  const fresh=await cdp.connectOverCDP(endpoint);
  try{assert.equal(fresh.contexts().flatMap(c=>c.pages()).length,1,'only the pre-existing tab survives');}finally{await fresh.close();}
  assert.equal(existing.isClosed(),false);assert.equal(browser.isConnected(),true);
 });
});

test('recordings replay the exact pinned producer bytes',async()=>{
 const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const bytes=await readFile(new URL('./fixtures/checklist-outstanding/producer.txt',import.meta.url));
 const provenance=JSON.parse(await readFile(new URL('./fixtures/checklist-outstanding/provenance.json',import.meta.url)));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.producer_sha256);
 const recording=JSON.parse(await readFile(new URL('./fixtures/checklist-outstanding/recordings.json',import.meta.url)));
 const {execFile}=await import('node:child_process');
 const output=await new Promise((yes,no)=>execFile(process.execPath,['--input-type=module','--eval',bytes.toString()+'\nconsole.log(JSON.stringify(deriveDealChecklist('+JSON.stringify(recording.record)+','+JSON.stringify(recording.sources)+','+JSON.stringify(recording.today)+')));'],(error,out)=>error?no(error):yes(out)));
 assert.deepEqual(JSON.parse(output),recording.response);
 assert.deepEqual([...new Set(recording.response.phases.flatMap(p=>p.items.map(i=>i.status)))].sort(),['complete','due','not_recorded','overdue','received','upcoming']);
});

test('natural observer CLI compares exact recorded counts, rows, due summary and evidence',async t=>{
 const {readFile}=await import('node:fs/promises');const {execFile}=await import('node:child_process');
 const {uiAssets}=await import('../scripts/ui-bundle.mjs');
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const recording=JSON.parse(await readFile(new URL('./fixtures/checklist-outstanding/recordings.json',import.meta.url)));
 const assets=await uiAssets(path=>readFile(new URL('../'+path,import.meta.url),'utf8'));
 const commit=await new Promise((yes,no)=>execFile('git',['rev-parse','HEAD'],(error,out)=>error?no(error):yes(out.trim())));
 let server;t.after(()=>server?.close());
 const start=async(mutation,readMode="normal")=>{
  await server?.close();
  const routes=new Map([...assets].map(([path,body])=>['/'+path,{body,contentType:'text/javascript'}]));
  routes.set('/js/pipeline.js',{body:`const detail={checklist:${JSON.stringify(recording.response)}}; export const state={panelDeal:"synthetic",panelDetail:detail,client:{getDeal:async()=>{if(${JSON.stringify(readMode)}==="auth")throw Error("Synthetic session expired");return ${JSON.stringify(readMode)}==="malformed"?{checklist:{schema_version:"deal-checklist.v1",template_state:"current",phases:{},due_items:[]}}:detail;}}};`,contentType:'text/javascript'});
  routes.set('/deals',{contentType:'text/html',body:`<!doctype html><div class="kanban-card"><button class="card-open">Open synthetic deal</button></div><main hidden><form id="detailUpdateForm">Synthetic detail</form><div id="host"></div></main><script type="module">
    import {mountDealChecklist} from '/js/ui-checklist.generated.js';
    import {state} from '/js/pipeline.js';
    document.querySelector('.card-open').onclick=()=>{document.querySelector('main').hidden=false;mountDealChecklist(document.querySelector('#host'),{dealId:'synthetic',checklist:state.panelDetail.checklist});};
    ${mutation ? `new MutationObserver(()=>{const n=document.querySelector('[data-checklist-count]');if(n && n.dataset.proofValue!==n.textContent){n.textContent='1'+n.textContent;n.dataset.proofValue=n.textContent;}}).observe(document.querySelector('#host'),{subtree:true,childList:true,characterData:true});` : ''}
  </script>`});
  server=await startWorkerFixture({routes,env:{APP_ENV:'production',GIT_SHA:commit}});
 };
 const reserve=await startFixture();const port=new URL(reserve.origin).port;await reserve.close();
 const browser=await chromium.launch({args:[`--remote-debugging-port=${port}`]});t.after(()=>browser.close());const existing=await browser.newPage();
 const run=()=>new Promise(resolve=>execFile(process.execPath,['scripts/prove-checklist-outstanding.mjs','--origin',server.origin,'--expected-commit',commit,'--cdp-url',`http://127.0.0.1:${port}`,'--timeout-ms','7000'],{timeout:12000},(error,stdout,stderr)=>resolve({code:error?.code||0,stdout,stderr})));
 await start(false);const pass=await run();assert.equal(pass.code,0,JSON.stringify(pass));assert.equal(JSON.parse(pass.stdout).status,'passed');
 await start(true);const fail=await run();assert.equal(fail.code,1,JSON.stringify(fail));
 for(const mode of ['auth','malformed']){await start(false,mode);const missing=await run();assert.equal(missing.code,78,JSON.stringify({mode,...missing}));}
 assert.equal(browser.isConnected(),true);assert.equal(existing.isClosed(),false);assert.equal(browser.contexts().flatMap(c=>c.pages()).length,1);
});
