import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { build } from 'esbuild';
import { createServer } from './proof-fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const runner='scripts/prove-historical-fit-deal-type-filter.mjs';
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
function cli(args, preload) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[...(preload?['--import',preload]:[]),runner,...args]);
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
    child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
}
test('proof CLI passes fixtures, rejects contradictions and reports insufficient evidence',async t=>{
  const upstream=await startFixtureServer();t.after(()=>upstream.stop());
  const root=resolve('.');let mode='pass';
  const source=await readFile('src/ui/ideal-client-profile.tsx','utf8');
  const mutated=await build({stdin:{contents:source.replace('profiles.filter(row => row.deal_type === selectedType)','profiles'),loader:'tsx',resolveDir:root},bundle:true,write:false,format:'esm',jsx:'automatic'});
  const server=createServer(async(req,res)=>{
    let pathname;
    try {pathname=decodeURIComponent(req.url.split('?')[0]);} catch {res.writeHead(403);return res.end();}
    const path=resolve(root,`.${pathname}`);
    if(path!==root && !path.startsWith(root+sep)) {res.writeHead(403);return res.end();}
    if(pathname==='/app-release') {
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:revision}));
    }
    if(!/^\/js\/[\w.-]+\.js$/.test(pathname)) {res.writeHead(403);return res.end();}
    if(mode==='protected') {res.writeHead(403);return res.end();}
    if(mode==='contradiction' && pathname==='/js/ui-ideal-client-profile.js') {
      res.setHeader('content-type','text/javascript');return res.end(mutated.outputFiles[0].text);
    }
    const response=await fetch(upstream.url+pathname);
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')});res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const args=['--origin',origin,'--timeout-ms','30000','--fixture'];
  const pass=await cli(args);assert.equal(pass.code,0,pass.stderr);assert.equal(JSON.parse(pass.stdout).assertions.length,10);
  mode='contradiction';const fail=await cli(args);assert.equal(fail.code,1,fail.stderr);
  mode='pass';const natural=await cli(args.slice(0,-1));assert.equal(natural.code,78,natural.stderr);
  mode='protected';const protectedResult=await cli(['--origin',origin,'--fixture','--timeout-ms','1500']);assert.equal(protectedResult.code,78,protectedResult.stderr);
  mode='pass';
  for(const pathname of ['/..%2f..%2fsecret','/%2e%2e%2fsecret','/%E0%A4%A']) {
    const response=await fetch(origin+pathname);assert.equal(response.status,403);
  }
  for(const probe of ['stalled evaluation','late launch']) {
    const scratch=temporaryDirectory('historical-filter-cleanup-',t), marker=join(scratch,'closed.json');
    const preload='data:text/javascript,'+encodeURIComponent(`
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
      import { writeFileSync } from 'node:fs';
      const launch=chromium.launch.bind(chromium);
      chromium.launch=async options=>{
        const browser=await launch(options);
        browser.on('disconnected',()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify({connected:browser.isConnected()})));
        if(${JSON.stringify(probe)}==='late launch') await new Promise(resolve=>setTimeout(resolve,2000));
        else {
          const newContext=browser.newContext.bind(browser);
          browser.newContext=async (...args)=>{
            const context=await newContext(...args),newPage=context.newPage.bind(context);
            context.newPage=async (...args)=>{const page=await newPage(...args);page.evaluate=()=>new Promise(()=>{});return page;};return context;
          };
        }
        return browser;
      };`);
    const result=await cli(['--origin',origin,'--fixture','--timeout-ms','1000'],preload);
    assert.equal(result.code,78,result.stderr);
    assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),{connected:false},'owned browser disconnected before process exited');
    console.log(`${probe}: exit 78, owned browser disconnected`);
  }
  console.log('fixture pass exit 0; contradiction exit 1; natural/protected exit 78');
});

test('recordings identify the checked-out producer and query provenance',async()=>{
  const { createHash }=await import('node:crypto');
  const root=new URL('./fixtures/historical-fit-deal-type-filter/',import.meta.url);
  const source=await readFile(new URL('producer.txt',root));
  const provenance=JSON.parse(await readFile(new URL('provenance.json',root)));
  assert.equal(createHash('sha256').update(source).digest('hex'),provenance.producer_sha256);
  assert.match(provenance.producer_revision,/^[a-f0-9]{40}$/);
  assert.equal(provenance.verb,'ideal-client-profile');
  assert.equal(provenance.queries.length,3);
  for(const query of provenance.queries) assert.deepEqual(query.args,[null,null,null]);
});
