import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { handleDoctorcreRequest } from '../src/worker.js';
import { options } from '../scripts/prove-deal-deadline-central-day.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = 'scripts/prove-deal-deadline-central-day.mjs';
function cli(origin, timeout = '30000') {
 return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runner, '--origin', origin, '--timeout-ms', timeout]);
  let output = '', errors = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  child.on('error', reject); child.on('close', code => resolve({code, output, errors}));
 });
}
test('proof rejects unsafe origins and unbounded arguments', () => {
 for (const origin of ['http://example.com','https://example.com/path','https://user:pass@example.com']) assert.throws(()=>options(['--origin',origin,'--timeout-ms','30000']));
 for (const timeout of ['0','30001','NaN']) assert.throws(()=>options(['--origin','https://example.com','--timeout-ms',timeout]));
});

test('exact proof CLI passes deployed modules and refuses contradictions, unavailable identity and timeouts', {timeout:180000}, async t => {
 const snapshot=await proofAssetSnapshot();
 for(const [key,value] of await loadFixtureAssets({root,manifest:new Map([['/js/deal-timeline.js','js/deal-timeline.js']])}))snapshot.set(key,value);
 let server;
 t.after(()=>server?.close());
 for (const [scenario,code] of [['pass',0],['fail',1],['unavailable',78],['missing',78],['changed',1],['foreign',1],['cap',1],['bytes',1],['timeout',78]]) {
  await server?.close();
  const routes=new Map(snapshot);
  for(const [key,value] of routes) {
   let body=value.body;
   if(scenario==='missing'){routes.set(key,{status:404});continue;}
   if(scenario==='bytes'&&key==='/js/deal-timeline.js')body=Buffer.alloc(8*1024*1024+1,' ');
   if(key==='/js/deal-timeline.js') {
    if(scenario==='fail')body=Buffer.from(body.toString().replace("const today = now => businessDay(new Date(now));","const today = now => new Date(now).toISOString().slice(0,10);"));
    if(scenario==='cap')body=Array.from({length:21},(_,i)=>`import './synthetic-${i}.js';`).join('\n');
    if(scenario==='foreign')body="import 'https://foreign.invalid/module.js';";
   }
   routes.set(key,{...value,body});
  }
  if(scenario==='cap')for(let i=0;i<21;i++)routes.set(`/js/synthetic-${i}.js`,{contentType:'text/javascript',body:'export const value = 1;'});
  const identity=async sha=>({status:scenario==='unavailable'?503:200,contentType:'application/json',body:await(await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'),{APP_ENV:'production',GIT_SHA:sha.repeat(40)})).text(),...(scenario==='timeout'?{hold:'timeout'}:{})});
  routes.set('/app-release',{sequence:[await identity('a'),await identity(scenario==='changed'?'b':'a')]});
  server=await startFixture({routes});
  const origin=server.origin;
  const result=await cli(origin);
  assert.equal(result.code,code,JSON.stringify(result));
  const receipt=JSON.parse(result.output);
  console.log(JSON.stringify({scenario,exit:result.code,assertions:receipt.assertions?.length,error:receipt.error}));
  if (code===0) {
   assert.equal(receipt.assertions.length,332);assert.ok(receipt.assertions.every(a=>a.passed));
   const assets=server.requests.filter(req=>req.path!=='/app-release').length;
   assert.equal(server.requests.length-assets,2);assert.ok(assets<=20);assert.equal(receipt.assets.length,assets);
   assert.ok(receipt.assets.every(a=>/^[a-f0-9]{64}$/.test(a.sha256)));
  }
 }
 const traversal=await fetch(`${server.origin}/%2e%2e%2fpackage.json`);
 assert.equal(traversal.status,400);
});
