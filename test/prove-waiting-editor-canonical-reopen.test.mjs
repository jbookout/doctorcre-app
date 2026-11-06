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
  if(mode==='bytes'){res.setHeader('Content-Type','text/javascript');return res.end(' '.repeat(11*1024*1024));}
  if(mode==='assets'){const n=req.url==='/js/ui-inbox.js'?0:Number(req.url.match(/asset-(\d+)/)?.[1]);res.setHeader('Content-Type','text/javascript');return res.end(`import './asset-${n+1}.js';`);}
  if(mode==='missing'){res.writeHead(404);return res.end();}
  let path;try{path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));}catch{res.writeHead(400);return res.end();}
  if(!path.startsWith(root+sep)){res.writeHead(403);return res.end();}
  try{let body=await readFile(path);if(mode==='contradiction'&&req.url==='/js/ui-inbox.js')body=Buffer.from('document.querySelector("main").textContent="Wrong deployed behavior";');res.setHeader('Content-Type','text/javascript');res.end(body);}catch{res.writeHead(404);res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));return {origin:`http://127.0.0.1:${server.address().port}`,requests,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
test('exact production-proof declaration and command pass fetched fixture bytes',async()=>{
 const plan=JSON.parse(await readFile('proofs/requirements/waiting-editor-canonical-reopen.json','utf8'));
 assert.ok(plan.assertions[0].predicate.includes(`node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`));
 const server=await serve('pass');try{const result=await cli(server.origin);assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.assertions.length,5);assert.ok(receipt.assets.length<=30);assert.ok(receipt.fetched_bytes<=10*1024*1024);assert.ok(receipt.assets.every(a=>/^[0-9a-f]{64}$/.test(a.sha256)));assert.ok(receipt.assets.some(a=>a.path==='/js/ui-inbox.js'));assert.ok(server.requests.every(r=>r.method==='GET'));}finally{await server.close();}
});
for(const [mode,expected] of [['unavailable',78],['missing',78],['timeout',78],['contradiction',1],['bytes',78],['assets',78]])test(`proof ${mode} exit ${expected}`,async()=>{
 const server=await serve(mode);try{const result=await cli(server.origin,mode==='timeout'?'100':'3000');assert.equal(result.code,expected,result.stderr);assert.notEqual(result.stderr,'');}finally{await server.close();}
});

test('startup deadline closes late browser and terminates the CLI', async () => {
 const server = await serve('pass');
 const preload = `
  import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
   const browser = await launch({ ...options, timeout: 5000 });
   process.stderr.write('browser connected\\n');
   browser.on('disconnected', () => process.stderr.write('browser disconnected\\n'));
   await new Promise(resolve => setTimeout(resolve, 1100));
   return browser;
  };
 `;
 let child, watchdog;
 try {
  const result = await new Promise((resolve, reject) => {
   child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, runner, '--origin', server.origin, '--timeout-ms', '1000'], { detached: true });
   let stderr = '';
   child.stderr.on('data', chunk => stderr += chunk);
   child.on('error', reject);
   child.on('exit', code => resolve({ code, stderr }));
   watchdog = setTimeout(() => reject(Error(`CLI did not terminate after startup deadline: ${stderr}`)), 7000);
  });
  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /Proof deadline exceeded/);
  assert.match(result.stderr, /browser connected/);
  assert.match(result.stderr, /browser disconnected/);
  assert.deepEqual(server.requests.map(request => request.url), ['/app-release']);
 } finally {
  clearTimeout(watchdog);
  if (child?.exitCode === null) {
   process.kill(-child.pid, 'SIGKILL');
   await new Promise(resolve => child.once('exit', resolve));
  }
  await server.close();
 }
});
