import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fixtureServer } from './browser-harness.mjs';
const run=promisify(execFile);
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const cli=new URL('../scripts/prove-queued-asks-corrupt-entry-isolation.mjs',import.meta.url).pathname;

async function origin(t, mode='valid') {
 const fixture=await fixtureServer();t.after(()=>fixture.close());
 const server=createServer(async(req,res)=>{
  if(req.url==='/app-release') {
   if(mode==='signin') {res.writeHead(401);res.end('sign in');return;}
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({service:'doctorcre-app',environment:'fixture',source_commit:mode==='stale'?'0'.repeat(40):revision}));return;
  }
  if(req.url==='/js/ui-host.js' && mode!=='valid' && mode!=='stale') {
   if(mode==='protected') {res.writeHead(403);res.end('protected');return;}
   res.setHeader('content-type','text/javascript');
   res.end(mode==='missing'?'export const absent=true;':mode==='timeout'?'export async function mountAskComposer(){await new Promise(()=>{});}':'export async function mountAskComposer(){document.body.textContent="Wrong result";}');return;
  }
  try {const upstream=await fetch(fixture.origin+req.url);res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));}
  catch {res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return `http://127.0.0.1:${server.address().port}`;
}
test('proof CLI imports served modules and proves isolated composer at both widths and themes',async t=>{
 const base=await origin(t);
 const {stdout}=await run(process.execPath,[cli,'--origin',base,'--revision',revision,'--timeout-ms','30000']);
 const result=JSON.parse(stdout);assert.equal(result.assertions.length,4);
 assert.ok(result.modules.includes(base+'/js/ui-host.js'));assert.ok(result.modules.length>1);
 assert.equal(result.release.source_commit,revision);
});
for(const mode of ['signin','stale','protected','missing','timeout','assertion']) test(`proof CLI fails closed for ${mode}`,async t=>{
 const base=await origin(t,mode);
 await assert.rejects(run(process.execPath,[cli,'--origin',base,'--revision',revision,'--timeout-ms','1500']),error=>error.code===1 && /queued-asks proof failed/.test(error.stderr));
});
test('proof CLI rejects unknown arguments and invalid timeout',async()=>{
 for(const args of [['--unknown','value'],['--origin','http://localhost','--timeout-ms','0']])
  await assert.rejects(run(process.execPath,[cli,...args]),error=>error.code===1);
});
test('proof CLI help describes its arguments without requiring an origin',async()=>{
 const {stdout}=await run(process.execPath,[cli,'--help']);
 for(const flag of ['--origin','--timeout-ms','--revision'])assert.ok(stdout.includes(flag));
});
