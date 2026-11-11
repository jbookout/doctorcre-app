import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {temporaryDirectory} from '../scripts/temp-directory.mjs';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startFixture} from '../scripts/fixture-http.mjs';
import {appAssetSnapshot} from '../scripts/fixture-app-assets.mjs';
import {prove} from '../scripts/prove-client-anniversary-panel.mjs';
import {assertProofDeadlineCleanup} from './proof-browser-harness.mjs';
const exec=promisify(execFile), expected='a'.repeat(40);
const root=resolve(new URL('../',import.meta.url).pathname);
const fixtures=JSON.parse(await readFile(new URL('./fixtures/client-anniversary-panel/recordings.json',import.meta.url),'utf8'));
const assets=await appAssetSnapshot();
async function server(t,{commit=expected,wrong=false,state='ready',auth=false,unavailableAfter=false,mutate='',collapsed=false }={}) {
  const json=(value,status=200)=>({body:JSON.stringify(value),contentType:'application/json',status});
  const snapshot=new Map(assets);
  snapshot.set('/leases',{contentType:'text/html',body:`<div id="host"></div><script type="module">import {mountClientAnniversaries} from '/js/ui-client-anniversaries.generated.js';import {createClientAnniversariesClient} from '/js/ui-client-anniversaries.generated.js';const client=createClientAnniversariesClient();${collapsed?"new MutationObserver((_,observer)=>{const button=document.querySelector('button[aria-expanded=true]');if(button){observer.disconnect();button.click();}}).observe(document.getElementById('host'),{childList:true,subtree:true,attributes:true});":''}mountClientAnniversaries(document.getElementById('host'),{load:async signal=>{const value=await client.read({signal});${wrong?"value.rows[0].client_name='Wrong label';":''}${mutate}return value;}});</script>`});
  const response=json(fixtures[state].output,state==='unavailable'?503:200);
  const fixture=await startFixture({assets:snapshot,routes:new Map([
    ['/app-release',json({service:'doctorcre-app',environment:'production',source_commit:commit})],
    ['/auth/session',auth?json({error:'unauthorized'},401):json({actor:{slug:'joe'},csrf_token:'synthetic'})],
    ['/api/v1/intelligence/client-anniversary-read',unavailableAfter
      ?{sequence:[response,json(fixtures.unavailable.output,503)]}:response],
  ])});
  t.after(()=>fixture.close());
  return fixture.origin;
}
test('proof CLI passes equal containing release and fails mismatched visible labels',async t=>{
  const origin=await server(t);
  const result=await exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--timeout-ms','15000']);
  assert.equal(JSON.parse(result.stdout).status,'passed');
  for(const state of ['empty','more']){
    const origin=await server(t,{state});
    const result=await exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--timeout-ms','15000']);
    assert.equal(JSON.parse(result.stdout).status,'passed');
  }
  const wrong=await server(t,{wrong:true});
  await assert.rejects(exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',wrong,'--expected-commit',expected,'--timeout-ms','15000']),e=>e.code===1);
});
test('CLI release ancestry uses only freshly constructed synthetic git objects',async t=>{
  const repository=temporaryDirectory('anniversary-ancestry-',t);
  const git=(args,options={})=>execFileSync('git',args,{cwd:repository,encoding:'utf8',...options}).trim();
  git(['init','-q']);
  const tree=git(['hash-object','-t','tree','-w','--stdin'],{input:''});
  async function commit(message,parent) {
    const file=resolve(repository,'message.txt');await writeFile(file,message);
    return git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit-tree',tree,...(parent?['-p',parent]:[]),'-F',file]);
  }
  const older=await commit('Synthetic older');
  const merge=await commit('Synthetic merge',older);
  const descendant=await commit('Synthetic descendant',merge);
  const unrelated=await commit('Synthetic unrelated');
  for(const [name,observed,code] of [['equal',merge,0],['descendant',descendant,0],['older',older,78],['unrelated',unrelated,78],['unknown','f'.repeat(40),78]])await t.test(name,async t=>{
    const origin=await server(t,{commit:observed});
    const args=[resolve(root,'scripts/prove-client-anniversary-panel.mjs'),'--origin',origin,'--expected-commit',merge,'--timeout-ms','15000'];
    if(code===0)assert.equal(JSON.parse((await exec(process.execPath,args,{cwd:repository})).stdout).status,'passed');
    else await assert.rejects(exec(process.execPath,args,{cwd:repository}),error=>error.code===78);
  });
});
for(const options of [{state:'unavailable'},{auth:true},{unavailableAfter:true}])test(`unavailable natural session ${JSON.stringify(options)} exits 78`,async t=>{
  const origin=await server(t,options);
  await assert.rejects(prove({origin,expectedCommit:expected,timeoutMs:1500}),{exitCode:78});
});
for(const mode of ['late launch','stalled evaluation'])test(`total deadline cleans ${mode}`,async t=>{
  const origin=await server(t);
  await assertProofDeadlineCleanup(t,{entry:'scripts/prove-client-anniversary-panel.mjs',args:['--origin',origin,'--expected-commit',expected],mode,timeoutMs:3000});
});
test('CDP proof closes its acquired page and preserves the shared browser and existing page',async t=>{
  const {chromium}=await import('../scripts/proof-browser.mjs');
  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser=browserFixture.browser;
  t.after(()=>browser.close());
  const sentinel=browserFixture.page;
  await sentinel.setContent('<title>Owned synthetic shared page</title>');
  const endpoint=browserFixture.endpoint;
  const origin=await server(t);
  const before=browser.contexts()[0].pages().length;
  assert.equal((await prove({origin,expectedCommit:expected,cdpUrl:endpoint})).status,'passed');
  assert.equal(browser.isConnected(),true);
  assert.equal(await sentinel.title(),'Owned synthetic shared page');
  assert.equal(browser.contexts()[0].pages().length,before);
});

for (const [field,mutate] of [
  ['years', 'value.rows[0].years=16;'],
  ['days until', 'value.rows[0].days_until=16;'],
  ['scanned', 'value.coverage.scanned=Number(String(value.coverage.scanned)+"0");'],
  ['skipped invalid', 'value.coverage.skipped_invalid=10+value.coverage.skipped_invalid;'],
  ['client name', "value.rows[0].client_name='Prefix '+value.rows[0].client_name;"],
  ['deal name', "value.rows[0].deal_name='Prefix '+value.rows[0].deal_name;"],
]) test(`proof CLI refuses near-miss ${field} on a containing release`,async t=>{
  const origin=await server(t,{mutate});
  await assert.rejects(exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--timeout-ms','15000']),error=>error.code===1);
});

test('CDP deadline waits for a late page before disconnecting and leaves no borrowed tabs',async t=>{
  const {chromium}=await import('../scripts/proof-browser.mjs');
  const {chromium:driver}=await import('playwright');
  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser=browserFixture.browser;
  t.after(()=>browser.close());
  const sentinel=browserFixture.page;
  await sentinel.setContent('<title>Preserved shared page</title>');
  const endpoint=browserFixture.endpoint;
  const cdpUrl=endpoint;
  const connect=driver.connectOverCDP.bind(driver);
  const baseline=browser.contexts()[0].pages().length;
  let acquired=false;
  driver.connectOverCDP=async (...args)=>{
    const connection=await connect(...args);
    const context=connection.contexts()[0],newPage=context.newPage.bind(context);
    context.newPage=async (...args)=>{
      const page=await newPage(...args);
      acquired=true;
      await new Promise(resolve=>setTimeout(resolve,1800));
      return page;
    };
    return connection;
  };
  t.after(()=>{driver.connectOverCDP=connect;});
  const origin=await server(t);
  await assert.rejects(prove({origin,expectedCommit:expected,cdpUrl,timeoutMs:1500}),{exitCode:78});
  assert.equal(acquired,true);
  const observer=await connect(cdpUrl);
  try {
    assert.equal(observer.contexts()[0].pages().length,baseline);
    assert.equal(await sentinel.title(),'Preserved shared page');
    assert.equal(browser.isConnected(),true);
  } finally { await observer.close(); }
});

test('CLI refuses an unreachable borrowed CDP endpoint on a containing release',async t=>{
  const origin=await server(t);
  const endpoint=await startFixture();
  const cdpUrl=endpoint.origin;
  await endpoint.close();
  await assert.rejects(exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--cdp-url',cdpUrl,'--timeout-ms','3000']),error=>error.code===78);
});

test('proof CLI refuses a section that requires opening on a containing release',async t=>{
  const origin=await server(t,{collapsed:true});
  await assert.rejects(exec(process.execPath,['scripts/prove-client-anniversary-panel.mjs','--origin',origin,'--expected-commit',expected,'--timeout-ms','15000']),error=>error.code===1);
});
