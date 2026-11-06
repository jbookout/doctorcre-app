import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
const runner='scripts/prove-waiting-editor-canonical-reopen.mjs';let outDir;
before(async()=>{outDir=temporaryDirectory('waiting-reopen-proof-');await buildArtifact({root:process.cwd(),outDir});});
after(()=>rm(outDir,{recursive:true,force:true}));
function cli(origin,timeout='30000') {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[runner,'--origin',origin,'--timeout-ms',timeout]);let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
async function serve(mode) {
 const root=resolve(outDir,'site');const requests=[];
 const server=createServer(async(req,res)=>{
  requests.push({method:req.method,url:req.url});
  if(mode==='timeout')return;
  if(req.url==='/app-release'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(mode==='unavailable'?{}:{service:'doctorcre-app',source_commit:'1'.repeat(40)}));}
  if(mode==='missing'){res.writeHead(404);return res.end();}
  let path;try{path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));}catch{res.writeHead(400);return res.end();}
  if(!path.startsWith(root+sep)){res.writeHead(403);return res.end();}
  try{let body=await readFile(path);if(mode==='contradiction'&&req.url==='/js/ui-inbox.js')body=Buffer.from('document.querySelector("main").textContent="Wrong deployed behavior";');res.setHeader('Content-Type','text/javascript');res.end(body);}catch{res.writeHead(404);res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));return {origin:`http://127.0.0.1:${server.address().port}`,requests,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
test('exact production-proof declaration and command pass fetched fixture bytes',async()=>{
 const plan=JSON.parse(await readFile('proofs/requirements/waiting-editor-canonical-reopen.json','utf8'));
 assert.ok(plan.assertions[0].predicate.includes(`node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`));
 const server=await serve('pass');try{const result=await cli(server.origin);assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.assertions.length,5);assert.ok(receipt.assets.length<=30);assert.ok(receipt.assets.every(a=>/^[0-9a-f]{64}$/.test(a.sha256)));assert.ok(receipt.assets.some(a=>a.path==='/js/ui-inbox.js'));assert.ok(server.requests.every(r=>r.method==='GET'));}finally{await server.close();}
});
for(const [mode,expected] of [['unavailable',78],['missing',78],['timeout',78],['contradiction',1]])test(`proof ${mode} exit ${expected}`,async()=>{
 const server=await serve(mode);try{const result=await cli(server.origin,mode==='timeout'?'100':'3000');assert.equal(result.code,expected,result.stderr);assert.notEqual(result.stderr,'');}finally{await server.close();}
});
