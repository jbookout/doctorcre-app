import { uiAssets } from '../scripts/ui-bundle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { startFixture } from '../scripts/fixture-http.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

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
  const root=resolve('.');
  const source=await readFile('src/ui/ideal-client-profile.tsx','utf8');
  const check='selectedType === undefined || row.deal_type === selectedType';
  assert.ok(source.includes(check),'mutation must remove the real deal type predicate');
  const mutated=await build({stdin:{contents:source.replace(check,'true'),loader:'tsx',resolveDir:root},bundle:true,write:false,format:'esm',jsx:'automatic'});
  const assets = await uiAssets(path => readFile(path));
  async function snapshot(mode = 'pass') {
    const responses = new Map([...assets].map(([path, body]) => ['/' + path, { body, contentType: 'text/javascript' }]));
    responses.set('/app-release', { body: JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:revision}), contentType: 'application/json' });
    if (mode === 'protected') for (const path of assets.keys()) responses.set('/' + path, { status: 403 });
    if (mode === 'contradiction') responses.set('/js/ui-ideal-client-profile.generated.js', { body: mutated.outputFiles[0].text, contentType: 'text/javascript' });
    const fixture = await startFixture({ routes: responses }); t.after(() => fixture.close()); return fixture;
  }
  let fixture = await snapshot(), origin = fixture.origin;
  const args=['--origin',origin,'--timeout-ms','30000','--fixture'];
  const pass=await cli(args);assert.equal(pass.code,0,pass.stderr);assert.equal(JSON.parse(pass.stdout).assertions.length,10);
  await fixture.close(); fixture = await snapshot('contradiction'); origin = fixture.origin; args[1] = origin;const fail=await cli(args);assert.equal(fail.code,1,fail.stderr);
  await fixture.close(); fixture = await snapshot('pass'); origin = fixture.origin; args[1] = origin;const natural=await cli(args.slice(0,-1));assert.equal(natural.code,78,natural.stderr);
  await fixture.close(); fixture = await snapshot('protected'); origin = fixture.origin; args[1] = origin;const protectedResult=await cli(['--origin',origin,'--fixture','--timeout-ms','1500']);assert.equal(protectedResult.code,78,protectedResult.stderr);
  await fixture.close(); fixture = await snapshot('pass'); origin = fixture.origin; args[1] = origin;
  for(const pathname of ['/..%2f..%2fsecret','/%2e%2e%2fsecret','/%E0%A4%A']) {
    const response=await fetch(origin+pathname);assert.equal(response.status,400);
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
