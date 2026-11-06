import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { handleDoctorcreRequest } from '../src/worker.js';
import { readAppRelease } from '../scripts/app-release-reader.mjs';
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
 let mode = 'pass', identities = 0, assets = 0;
 const server = createServer(async (req,res) => {
  try {
   const pathname = decodeURIComponent(req.url.split('?')[0]);
   const target = path.resolve(root, `.${pathname}`);
   if (!target.startsWith(root.replace(/\/$/,'') + path.sep)) {res.writeHead(403);res.end();return;}
   if (pathname === '/app-release') {
    identities++;
    if (mode === 'timeout') return;
    if (mode === 'unavailable') {res.writeHead(503);res.end();return;}
    const release = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), {APP_ENV:'production', GIT_SHA: mode==='changed' && identities===2 ? 'b'.repeat(40) : 'a'.repeat(40)});
    res.writeHead(release.status,Object.fromEntries(release.headers));res.end(await release.text());return;
   }
   assets++;
   if (mode === 'missing') {res.writeHead(404);res.end();return;}
   let body = mode === 'cap' && pathname.startsWith('/js/synthetic-') ? Buffer.from('export const value = 1;') : await readFile(target);
   if (mode === 'bytes') body=Buffer.alloc(8 * 1024 * 1024 + 1, ' ');
   if (mode === 'fail' && pathname === '/js/deal-timeline.js') body=Buffer.from(body.toString().replace("const today = now => businessDay(new Date(now));", "const today = now => new Date(now).toISOString().slice(0,10);"));
   if (mode === 'cap' && pathname === '/js/deal-timeline.js') body=Buffer.from(Array.from({length:21},(_,i)=>`import './synthetic-${i}.js';`).join('\n'));
   if (mode === 'foreign' && pathname === '/js/deal-timeline.js') body=Buffer.from("import 'https://foreign.invalid/module.js';");
   res.writeHead(200,{'content-type':'text/javascript'});res.end(body);
  } catch {res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const release=await readAppRelease(origin, async url=>{const r=await fetch(url);return {type:r.headers.get('content-type'),body:Buffer.from(await r.arrayBuffer())};});
 assert.equal(release.service,'doctorcre-app');assert.equal(release.environment,'production');
 for (const [scenario,code] of [['pass',0],['fail',1],['unavailable',78],['missing',78],['changed',1],['foreign',1],['cap',1],['bytes',1],['timeout',78]]) {
  mode=scenario;identities=0;assets=0;
  const result=await cli(origin);
  assert.equal(result.code,code,JSON.stringify(result));
  const receipt=JSON.parse(result.output);
  console.log(JSON.stringify({scenario,exit:result.code,assertions:receipt.assertions?.length,error:receipt.error}));
  if (code===0) {
   assert.equal(receipt.assertions.length,332);assert.ok(receipt.assertions.every(a=>a.passed));
   assert.equal(identities,2);assert.ok(assets<=20);assert.equal(receipt.assets.length,assets);
   assert.ok(receipt.assets.every(a=>/^[a-f0-9]{64}$/.test(a.sha256)));
  }
 }
 const traversal=await fetch(`${origin}/%2e%2e%2fpackage.json`);
 assert.equal(traversal.status,403);
});
