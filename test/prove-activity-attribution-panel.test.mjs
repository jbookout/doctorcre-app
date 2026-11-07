import test from 'node:test';
import assert from 'node:assert/strict';
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
 const {createServer}=await import('./proof-fixture-server.mjs');
 const {readFile}=await import('node:fs/promises');
 const {resolve,sep}=await import('node:path');
 const {fileURLToPath}=await import('node:url');
 const {execFile}=await import('node:child_process');
 const {chromium}=await import('../scripts/proof-browser.mjs');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const commit=await new Promise((yes,no)=>execFile('git',['rev-parse','HEAD'],{cwd:root},(error,out)=>error?no(error):yes(out.trim())));
 const recording=JSON.parse(await readFile(new URL('./fixtures/activity-attribution-panel/recordings.json',import.meta.url)));
 let incorrect=false;
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/app-release'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:commit}));}
  if(path==='/mcp'){
   let body='';for await(const chunk of req)body+=chunk;
   const request=JSON.parse(body);res.setHeader('content-type','application/json');
   return res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify(recording.cases[0].response)}]}}));
  }
  if(path==='/deals'){
   res.setHeader('content-type','text/html');
   return res.end(`<!doctype html><div class="kanban-card" hidden><button class="card-open">Open synthetic deal</button></div><main hidden><form id="detailUpdateForm">Synthetic detail</form><div id="updates"></div></main><script type="module">
    import {renderDealUpdates,mountActivityAttribution} from '/js/deal-timeline.js';
    setTimeout(()=>document.querySelector('.kanban-card').hidden=false,100);
    const id=${JSON.stringify(recording.activity_id)};
    updates.innerHTML=renderDealUpdates({entries:[{id,kind:'note',summary:'Synthetic fixture activity',when:'2026-11-01T12:00:00Z'}],activities:[{id}]});
    mountActivityAttribution(updates);
    document.querySelector('.card-open').onclick=()=>document.querySelector('main').hidden=false;
    if(${incorrect})new MutationObserver(()=>{for(const p of updates.querySelectorAll('p'))if(p.textContent==='1 credited activities')p.textContent='0 credited activities';}).observe(updates,{subtree:true,childList:true,characterData:true});
   </script>`);
  }
  let file;
  try{file=resolve(root,'.'+decodeURIComponent(path));}catch{res.writeHead(400);return res.end();}
  if(!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(403);return res.end();}
  try{res.setHeader('content-type',path.endsWith('.js')||path.endsWith('.mjs')?'text/javascript':'text/plain');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const reserve=createServer(()=>{});await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const browser=await chromium.launch({args:[`--remote-debugging-port=${port}`]});t.after(()=>browser.close());
 const existing=await browser.newPage();await existing.goto('about:blank');
 const run=()=>new Promise(resolve=>execFile(process.execPath,['scripts/prove-activity-attribution-panel.mjs','--origin',origin,'--expected-commit',commit,'--cdp-url',`http://127.0.0.1:${port}`],{cwd:root,timeout:35000},(error,stdout,stderr)=>resolve({code:error?.code||0,receipt:stdout.trim()?JSON.parse(stdout.trim()):null,stderr})));
 const passing=await run();assert.equal(passing.code,0,JSON.stringify(passing));assert.equal(passing.receipt.status,'passed');assert.equal(browser.isConnected(),true);assert.equal(existing.isClosed(),false);
 incorrect=true;const failing=await run();assert.equal(failing.code,1,JSON.stringify(failing));assert.match(failing.receipt.error,/credit/);assert.equal(browser.isConnected(),true);assert.equal(existing.isClosed(),false);
 assert.equal(browser.contexts().flatMap(c=>c.pages()).length,1);
});
