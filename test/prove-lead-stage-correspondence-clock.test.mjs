import { chromium } from './browser-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { handleDoctorcreRequest } from '../src/worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await init;
async function fixture(t, mode) {
 const assets = new Map(), pending = ['/js/leads-model.js','/js/leads-client.js'];
 while(pending.length) {
  const path = pending.shift();
  if(assets.has(path))continue;
  const absolute = resolve(root, '.' + decodeURIComponent(path));
  assert.ok(absolute.startsWith(root.endsWith(sep) ? root : root + sep));
  const bytes = await readFile(absolute);
  assets.set(path, bytes);
  for(const dependency of parse(bytes.toString())[0]) {
   if(dependency.d !== -1)continue;
   assert.ok(dependency.n, 'fixture graph has only resolved imports');
   const url=new URL(dependency.n, 'http://localhost'+path);
   assert.equal(url.origin,'http://localhost');
   pending.push(url.pathname);
  }
  assert.ok(assets.size <= 32);
 }
 if(mode==='assertion') {
  const path='/js/leads-model.js',source=assets.get(path).toString();
  const faulty=source.replace('day <= days[month - 1]', 'day <= 31');
  assert.notEqual(faulty,source,'assertion fixture replaces timestamp admission');
  assets.set(path,Buffer.from(faulty));
 }
 if(mode==='foreign')assets.set('/js/leads-model.js',Buffer.from('import "https://foreign.invalid/module.js";'));
 const manifest={schema:'doctorcre-static-artifact.v1',repository:'jbookout/doctorcre-app',source_commit:'1'.repeat(40),files:[...assets].map(([path,bytes])=>({path:path.slice(1),bytes:bytes.length,sha256:hash(bytes)}))};
 const seen=[];let releases=0;
 const server=createServer(async(req,res)=>{
  seen.push([req.method,req.url]);
  if(mode==='timeout')return;
  if(req.url==='/app-release') {
   const response=await handleDoctorcreRequest(new Request('http://localhost/app-release'),{APP_ENV:'production',GIT_SHA:mode==='release-change' && ++releases>1?'2'.repeat(40):'1'.repeat(40)});
   res.setHeader('content-type','application/json');
   return res.end(mode==='identity'?'{}':await response.text());
  }
  if(req.url==='/artifact-manifest.json')return res.end(JSON.stringify(manifest));
  const bytes=assets.get(req.url);
  if(!bytes || mode==='unavailable'){res.writeHead(404);return res.end();}
  if(mode==='auth'){res.writeHead(401);return res.end();}
  res.setHeader('content-type','text/javascript');
  res.end(mode==='hash'?Buffer.from('export const wrong=true'):bytes);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 return {origin:`http://127.0.0.1:${server.address().port}`,seen,assets};
}
async function cli(origin,timeout='30000') {
 const child=spawn(process.execPath,['scripts/prove-lead-stage-correspondence-clock.mjs','--origin',origin,'--timeout-ms',timeout],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const [code]=await once(child,'close');
 return {code,receipt:JSON.parse(stdout.trim()),stderr};
}
test('lead clock CLI proves exact deployed modules and contract-checked fixtures',async t=>{
 const f=await fixture(t);const {code,receipt}=await cli(f.origin);
 assert.equal(code,0,JSON.stringify(receipt));assert.equal(receipt.release.service,'doctorcre-app');
 assert.equal(receipt.release.environment,'production');assert.equal(receipt.release.source_commit,'1'.repeat(40));
 assert.ok(receipt.assertions.includes('fractional future evidence excluded 2026-03-10T12:00:00.000001Z'));
 assert.ok(receipt.assertions.includes('exact fractional ordering before three-entry limit'));
 assert.ok(receipt.assertions.length>50);assert.equal(receipt.assets.length,f.assets.size);
 for(const asset of receipt.assets)assert.equal(asset.sha256,hash(f.assets.get(new URL(asset.url).pathname)));
 assert.ok(receipt.requests<=35);assert.ok(f.seen.every(([method])=>method==='GET'));
});
for(const [mode,expected] of [['assertion',1],['foreign',1],['hash',1],['identity',78],['unavailable',78],['auth',78],['timeout',78],['release-change',1]])test(`lead clock CLI refuses ${mode}`,async t=>{
 const f=await fixture(t,mode);const {code,receipt}=await cli(f.origin,mode==='timeout'?'100':'30000');
 assert.equal(code,expected,JSON.stringify(receipt));assert.notEqual(receipt.status,'passed');assert.ok(f.seen.length<=35);
 if(mode==='assertion')assert.match(receipt.error,/invalid instant requires explanation 2026-02-31T12:00:00Z/);
});

for(const width of [390,1280])test(`lead clock UI rejects malformed detail and recovers with focused explanation at ${width}`,async t=>{
 const {routeLeads}=await import('./leads-browser-fixture.mjs');
 const {detail}=await import('./leads-workspace-fixture.mjs');
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
 let mode='malformed';const writes=[];
 await routeLeads(page,{onWrite:p=>writes.push(p),getDetail:row=>({...detail(row),correspondence:mode==='malformed'?[{id:'synthetic',kind:'email_in',occurred_at:'2026-02-31T12:00:00Z'}]:mode==='usable'?detail(row).correspondence:[]})});
 await page.goto('http://localhost/leads');
 await page.locator('#stageFilter').selectOption('outreach_active');
 const open=page.locator('.lead-open').first();await open.focus();await page.keyboard.press('Alt+ArrowRight');
 await page.locator('#stageError:visible').waitFor();
 assert.equal(await page.locator('#saveStage').isDisabled(),true);
 assert.equal(await page.locator('#stageQuestions textarea').count(),0);
 await page.locator('#closeStage').click();
 mode='missing';
 await open.focus();await page.keyboard.press('Alt+ArrowRight');
 const answer=page.locator('#stageQuestions textarea');await answer.waitFor();
 assert.match(await page.locator('#stageQuestions').textContent(),/What contact has taken place/);
 assert.equal(await answer.evaluate(node=>node===document.activeElement),true);
 assert.equal(await page.locator('#saveStage').isDisabled(),false);
 await page.locator('#closeStage').click();
 mode='usable';await open.focus();await page.keyboard.press('Alt+ArrowRight');
 await page.locator('#stageContext .stage-evidence b').first().waitFor();
 assert.equal(await page.locator('#stageQuestions textarea').count(),0);
 assert.equal(await page.locator('#saveStage').isDisabled(),false);
 await page.locator('#closeStage').click();assert.deepEqual(writes,[]);
});
