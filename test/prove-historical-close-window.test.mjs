import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium as rawChromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-historical-close-window.mjs';

const exec = promisify(execFile);
const assets = await uiAssets(path => readFile(path));
const runner = fileURLToPath(new URL('../scripts/prove-historical-close-window.mjs',import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('recordings use pinned registered producer and exact production parser',async () => {
  const fixture = new URL('./fixtures/historical-close-window/',import.meta.url);
  const pinned = (await readFile(new URL('producer.txt',fixture),'utf8')).split('\nAPP PARSER\n');
  const provenance = JSON.parse(await readFile(new URL('provenance.json',fixture)));
  const source = await readFile(new URL('../src/ui/ideal-client-profile.tsx',import.meta.url),'utf8');
  assert.equal(pinned[1],source.split('export function mount')[0]);
  assert.equal(sha(pinned[0]),provenance.producer_sha256);
  assert.equal(sha(pinned[1]),provenance.parser_sha256);
  const parser = await transform(pinned[1].replace(/^import .*\n/gm,'')+'\nparse;', {loader:'ts'});
  const parse = vm.runInNewContext(parser.code);
  const producer = await transform('const tools={'+pinned[0]+'}; tools["ideal-client-profile"].handler;',{loader:'ts'});
  const handler = vm.runInNewContext(producer.code,{marketFilters:{}});
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/ideal-client-profile.json',import.meta.url)));
  const recordingBytes = await readFile(new URL('recordings.json',fixture));
  assert.equal(sha(recordingBytes),provenance.recordings_sha256);
  const data = JSON.parse(recordingBytes);
  for (const payload of Object.values(data)) {
    assert.equal(payload.schema_version,contract.schema_version); assert.equal(payload.coverage,contract.coverage);
    assert.ok(payload.profiles.length <= contract.limit);
    parse(payload);
    const rows = payload.profiles.map(({hypothesis,...row})=>row);
    const observed = await handler({query:async()=>({rows})},null,{});
    assert.equal(JSON.stringify(observed),JSON.stringify(payload));
  }
});

async function fixture(t, mode='equal') {
  const history = temporaryDirectory('close-window-history-',t);
  const git = async (...args) => (await exec('git',args,{cwd:history})).stdout.trim();
  await git('init');
  const commit = async name => {
    await writeFile(join(history,'revision'),name); await git('add','revision');
    await git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',name);
    return git('rev-parse','HEAD');
  };
  const older = await commit('older'), expected = await commit('expected'), descendant = await commit('descendant');
  await git('checkout','--orphan','unrelated'); const unrelated = await commit('unrelated');
  const released = ({older,descendant,unrelated,unknown:'f'.repeat(40)})[mode] || expected;
  const recorded = JSON.parse(await readFile(new URL('./fixtures/historical-close-window/recordings.json',import.meta.url)));
  const snapshot = new Map([...assets].map(([path,body])=>['/'+path,{body,contentType:'text/javascript'}]));
  if(mode==='assertion') snapshot.set('/js/ui-ideal-client-profile.js',{body:assets.get('js/ui-ideal-client-profile.js').toString().replaceAll('Full-history wins','Wrong heading'),contentType:'text/javascript'});
  const routes = new Map([['/leads',{contentType:'text/html',body:`<!doctype html><title>Natural fixture</title><main></main><script type="module">
    import { mountIdealClientProfile } from '/js/ui-ideal-client-profile.js';
    mountIdealClientProfile(document.querySelector('main'),{ async getIdealClientProfile(){
      const response=await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ideal-client-profile',arguments:{}}})});
      return JSON.parse((await response.json()).result.content[0].text);
    }});
  </script>`}]]);
  const server = await startWorkerFixture({assets:snapshot,routes,env:{GIT_SHA:released,APP_ENV:'production',CARR:{fetch:async request=>{
    const input=await request.json();
    assert.equal(input.params.name,'ideal-client-profile');
    return Response.json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify(mode==='empty'?recorded.empty:recorded.full)}]}});
  }}}});
  t.after(()=>server.close());
  return {origin:server.origin,expected:mode==='unknown-expected'?'e'.repeat(40):expected,history};
}
async function cli(t, mode, extra=[]) {
  const f = await fixture(t,mode);
  try { const result=await exec(process.execPath,[runner,'--origin',f.origin,'--expected-commit',f.expected,'--timeout-ms','15000',...extra],{cwd:f.history,timeout:25000}); return {code:0,receipt:JSON.parse(result.stdout)}; }
  catch(error) { return {code:error.code,receipt:JSON.parse(error.stdout)}; }
}
for (const mode of ['equal','descendant']) test(`CLI containing ${mode} release passes one-day fixture`,async t=>{
  const result=await cli(t,mode,['--fixture']); assert.equal(result.code,0,JSON.stringify(result)); assert.equal(result.receipt.observation.evidence,1);
});
for (const mode of ['older','unrelated','unknown','unknown-expected']) test(`CLI ${mode} release is insufficient evidence`,async t=>{
  const result=await cli(t,mode,['--fixture']); assert.equal(result.code,78,JSON.stringify(result));
});
test('containing release with unreachable CDP exits 78',async t=>{
  const result=await cli(t,'equal',['--cdp-url','http://127.0.0.1:1']); assert.equal(result.code,78,JSON.stringify(result));
});
test('containing release without signed-in session exits 78',async t=>{
  assert.equal((await cli(t,'equal')).code,78);
});
for (const mode of ['late launch','stalled evaluation']) test(`deadline cleans owned browser after ${mode}`,async t=>{
  const f=await fixture(t); let alive=0;
  const engine={async launch(){
    if(mode==='late launch') await new Promise(resolve=>setTimeout(resolve,150));
    alive++;
    return {close:async()=>{alive=0;},newPage:async()=>({route:async()=>{},goto:()=>new Promise(()=>{})})};
  }};
  await assert.rejects(prove({origin:f.origin,expectedCommit:f.expected,timeoutMs:70,fixture:true,engine}),{exitCode:78});
  await new Promise(resolve=>setTimeout(resolve,200)); assert.equal(alive,0);
});
test('containing release assertion failure exits 1 through CLI',async t=>{
  const result=await cli(t,'assertion',['--fixture']); assert.equal(result.code,1,JSON.stringify(result));
});
for (const mode of ['late launch','stalled evaluation']) test(`real browser is disconnected after proof ${mode}`,async t=>{
  const f=await fixture(t); let owned;
  const engine={async launch(options){
    owned=await rawChromium.launch({...options,timeout:10000,args:[...CHROMIUM_SAFETY_ARGS, ...(options.args || [])]});
    if(mode==='late launch') await new Promise(resolve=>setTimeout(resolve,1000));
    else {
      const newPage=owned.newPage.bind(owned);
      owned.newPage=async()=>{const page=await newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<title>Stall</title>'}));page.goto=()=>page.evaluate(()=>new Promise(()=>{}));return page;};
    }
    return owned;
  }};
  await assert.rejects(prove({origin:f.origin,expectedCommit:f.expected,timeoutMs:700,fixture:true,engine}),{exitCode:78});
  await new Promise(resolve=>setTimeout(resolve,1400)); assert.ok(owned); assert.equal(owned.isConnected(),false);
});

test('signed-in natural fixture passes while borrowed browser survives',async t=>{
  const f=await fixture(t);
  const socket=await startFixture();
  const port=new URL(socket.origin).port; await socket.close();
  const borrowed=await rawChromium.launch({args:[...CHROMIUM_SAFETY_ARGS,`--remote-debugging-port=${port}`]});
  t.after(()=>borrowed.close());
  const context=await borrowed.newContext(); const keeper=await context.newPage();
  const result=await prove({origin:f.origin,expectedCommit:f.expected,cdpUrl:`http://127.0.0.1:${port}`,timeoutMs:15000});
  assert.equal(result.status,'passed'); assert.equal(borrowed.isConnected(),true); assert.equal(keeper.isClosed(),false);
  const empty=await fixture(t,'empty');
  await assert.rejects(prove({origin:empty.origin,expectedCommit:empty.expected,cdpUrl:`http://127.0.0.1:${port}`,timeoutMs:1200}),{exitCode:78});
  assert.equal(borrowed.isConnected(),true); assert.equal(keeper.isClosed(),false);
});
