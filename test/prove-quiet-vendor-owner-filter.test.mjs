import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from './proof-fixture-server.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { routeContract } from '../js/routes.js';
import { prove } from '../scripts/prove-quiet-vendor-owner-filter.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';
const exec = promisify(execFile);
const commit = '1'.repeat(40);
const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-vendor-owner-filter/recordings.json', import.meta.url))).response;

async function fixture(t) {
  let source=commit, response=structuredClone(recording), broken=false, corrupt=false;
  const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
  const server=createServer(async(req,res)=>{
    try {
      const path=decodeURIComponent(new URL(req.url,'http://fixture.invalid').pathname);
      res.setHeader('content-type','application/json');
      if(path==='/app-release') return res.end(JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:source}));
      if(path.startsWith('/api/v1/business/')) return res.end(JSON.stringify(directoryFixture('http://fixture.invalid'+req.url)));
      if(path==='/mcp') {
        let body='';for await(const chunk of req) body+=chunk;
        const request=JSON.parse(body);
        const payload=structuredClone(response);
        if(broken) payload.proposals[0].owner={bad:true};
        return res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}}));
      }
      const filename=resolve(root,routeContract.routes[path]||path.slice(1));
      if(!filename.startsWith(root+sep)) {res.writeHead(403);return res.end();}
      res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(filename)]||'application/octet-stream');
      const bytes=await readFile(filename);
      res.end(corrupt && path==='/js/ui-quiet-vendors.js' ? bytes.toString().replaceAll('data-vendor-id','data-wrong-id') : bytes);
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {origin:`http://127.0.0.1:${server.address().port}`,setSource(value){source=value;},empty(){response.proposals=[];},break(){broken=true;},corrupt(){corrupt=true;}};
}

test('recorded registered response passes the production app boundary',()=>{
  assert.deepEqual(validateQuietFollowUps(recording),recording);
  for(const owner of [false,12,{},[],'','   ']) {
    const bad=structuredClone(recording);bad.proposals[0].owner=owner;
    assert.throws(()=>validateQuietFollowUps(bad),{code:'invalid_projection'});
  }
});

test('equal release runs real rendered selection and clear; empty is insufficient',async t=>{
  const f=await fixture(t);
  const receipt=await prove({origin:f.origin,expectedCommit:commit,fixture:true});
  assert.equal(receipt.status,'passed');assert.equal(receipt.matching_count,7);assert.equal(receipt.business_reads,1);
  f.empty();await assert.rejects(prove({origin:f.origin,expectedCommit:commit,fixture:true}),{exitCode:78});
});

test('natural mode requires the existing signed-in session',async t=>{
  const f=await fixture(t);
  await assert.rejects(prove({origin:f.origin,expectedCommit:commit}),{exitCode:78});
});

test('equal, descendant, older, unrelated and unknown ancestry use self-contained git fixtures',async t=>{
  const root=temporaryDirectory('quiet-owner-ancestry-',t);
  const git=async(...args)=>(await exec('git',args,{cwd:root})).stdout.trim();
  await git('init','-q');await git('config','user.name','Synthetic');await git('config','user.email','synthetic@example.invalid');
  await writeFile(root+'/file','one');await git('add','file');await git('commit','-qm','one');const first=await git('rev-parse','HEAD');
  await writeFile(root+'/file','two');await git('commit','-qam','two');const second=await git('rev-parse','HEAD');
  await git('checkout','--orphan','unrelated');await git('commit','-qm','unrelated');const unrelated=await git('rev-parse','HEAD');
  const f=await fixture(t),prior=process.cwd();
  try {
    process.chdir(root);
    for(const [mode,expected,released,passes] of [['equal',first,first,true],['descendant',first,second,true],['older',second,first,false],['unrelated',first,unrelated,false],['unknown',first,'f'.repeat(40),false]]) {
      f.setSource(released);
      if(passes) assert.equal((await prove({origin:f.origin,expectedCommit:expected,fixture:true})).status,'passed',mode);
      else await assert.rejects(prove({origin:f.origin,expectedCommit:expected,fixture:true}),{exitCode:78},mode);
    }
  } finally {process.chdir(prior);}
});

for(const mode of ['late launch','stalled evaluation']) test(`total deadline cleans ${mode}`,async t=>{
  const f=await fixture(t);
  await assertProofDeadlineCleanup(t,{entry:'scripts/prove-quiet-vendor-owner-filter.mjs',args:['--origin',f.origin,'--expected-commit',commit,'--fixture'],mode,timeoutMs:3000});
});

test('CLI executes a pass and insufficient evidence',async t=>{
  const f=await fixture(t);
  const args=['scripts/prove-quiet-vendor-owner-filter.mjs','--origin',f.origin,'--expected-commit',commit,'--timeout-ms','10000','--fixture'];
  const {stdout}=await exec(process.execPath,args);assert.equal(JSON.parse(stdout).status,'passed');
  f.corrupt();await assert.rejects(exec(process.execPath,args),{code:1});
  f.empty();await assert.rejects(exec(process.execPath,args),{code:78});
});

test('CDP observation closes its page and disconnects while preserving the existing browser and page',async t=>{
  const f=await fixture(t);
  const portServer=createServer(()=>{});
  await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
  const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const {chromium}=await import('../scripts/proof-browser.mjs');
  const existing=await chromium.launch({args:[`--remote-debugging-port=${port}`]});
  t.after(()=>existing.close());
  const page=await existing.newPage();await page.goto('about:blank');
  const receipt=await prove({origin:f.origin,expectedCommit:commit,cdpUrl:`http://127.0.0.1:${port}`});
  assert.equal(receipt.scope,'natural');
  assert.equal(existing.isConnected(),true);assert.equal(page.isClosed(),false);
  assert.equal(existing.contexts()[0].pages().length,1);
});
