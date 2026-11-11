import { unreachableCdpEndpoint } from "./unreachable-cdp-fixture.ts";
import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium} from '../scripts/proof-browser.mjs';
import {startFixture,startWorkerFixture} from '../scripts/fixture-http.mjs';
import {appAssetSnapshot} from '../scripts/fixture-app-assets.mjs';
import {temporaryDirectory} from '../scripts/temp-directory.mjs';
import {workspace,emptyQuietFollowUps} from './leads-workspace-fixture.mjs';
import {prove} from '../scripts/prove-reasons-evidence-window.mjs';
const exec=promisify(execFile);
const recording=JSON.parse(await readFile(new URL('./fixtures/reasons-evidence-window/recordings.json',import.meta.url)));
const contract=JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/list-practice-origination.json',import.meta.url))).response;
const assets=await appAssetSnapshot();
test('checked-in fixture satisfies producer contract and pinned production parser bytes',async()=>{
  for(const key of contract.required_keys)assert.ok(Object.hasOwn(recording,key));
  assert.equal(recording.contract,contract.contract);
  for(const row of recording.cards){for(const key of contract.card_keys)assert.ok(Object.hasOwn(row,key));assert.ok(contract.kinds.includes(row.kind));assert.ok(contract.routes.includes(row.route));assert.ok(contract.date_basis.includes(row.date_basis));}
  for(const row of recording.coverage){for(const key of contract.coverage_keys)assert.ok(Object.hasOwn(row,key));assert.ok(contract.coverage_statuses.includes(row.status));}
  const provenance=JSON.parse(await readFile(new URL('./fixtures/reasons-evidence-window/provenance.json',import.meta.url)));
  const bytes=await readFile(new URL('./fixtures/reasons-evidence-window/producer.txt',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.dependency_snapshot_sha256);
  const dependencies=JSON.parse(bytes);
  assert.equal(createHash('sha256').update(dependencies.producer).digest('hex'),provenance.producer.sha256);
  assert.equal(createHash('sha256').update(dependencies.parser).digest('hex'),provenance.parser.sha256);
  assert.equal(dependencies.parser,await readFile(new URL('../js/contact-reasons.mjs',import.meta.url),'utf8'));
  assert.equal(dependencies.contract,await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/list-practice-origination.json',import.meta.url),'utf8'));
});
async function fixture(t,mode='equal'){
  const history=temporaryDirectory('signal-window-history-',t);
  const git=(...args)=>execFileSync('git',args,{cwd:history,encoding:'utf8',stdio:'pipe'}).trim();git('init');
  async function commit(text){await writeFile(resolve(history,'revision'),text);git('add','revision');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',text);return git('rev-parse','HEAD');}
  const older=await commit('older'),expectedCommit=await commit('expected'),descendant=await commit('descendant');git('checkout','--orphan','unrelated');const unrelated=await commit('unrelated');
  const source={older,descendant,unrelated,unknown:'f'.repeat(40)}[mode]||expectedCommit;
  const snapshot=new Map(assets);
  if(mode==='failure'||mode==='near-miss'){
    const row=snapshot.get('/js/ui-reasons.js');snapshot.set('/js/ui-reasons.js',{...row,body:row.body.toString().replaceAll('matching loaded',mode==='failure'?'incorrect loaded':'1 matching loaded')});
  }
  const server=await startWorkerFixture({assets:snapshot,env:{APP_ENV:'production',GIT_SHA:source,CARR:{fetch:async request=>{
    if(new URL(request.url).pathname==='/mcp'){
      const body=await request.json();const name=body.params.name;
      const value=name==='list-practice-origination'?(mode==='empty'?{...recording,cards:[]}:recording):name==='lead-board'?workspace():name==='quiet-follow-ups'?emptyQuietFollowUps():name==='read-home-agenda'?{schema_version:'home-agenda.v1',actor:'example-partner',deals:[]}:{actor:'example-partner',deals:[]};
      return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}});
    }
    return Response.json({actor:{slug:'example-partner'},csrf_token:'synthetic-test-token'});
  }}}});t.after(()=>server.close());
  return {origin:server.origin,expectedCommit,ancestryCwd:history};
}
async function borrowed(t){

  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser=browserFixture.browser;t.after(()=>browser.close());
  return {browser,cdpUrl:browserFixture.endpoint};
}
for(const mode of ['equal','failure','near-miss','empty'])test(`natural proof CLI ${mode}`,async t=>{
  const options=await fixture(t,mode);const {browser,cdpUrl}=await borrowed(t);
  const args=['scripts/prove-reasons-evidence-window.mjs','--origin',options.origin,'--expected-commit',options.expectedCommit,'--cdp-url',cdpUrl,'--timeout-ms','10000'];
  if(mode==='equal')assert.equal(JSON.parse((await exec(process.execPath,args)).stdout).status,'passed');
  else await assert.rejects(exec(process.execPath,args),error=>{assert.equal(error.code,mode==='empty'?78:1,error.stdout+error.stderr);return true;});
  assert.ok(browser.isConnected());
});
for(const mode of ['descendant','older','unrelated','unknown'])test(`release ancestry ${mode}`,async t=>{
  const options=await fixture(t,mode);const {cdpUrl}=await borrowed(t);
  if(mode==='descendant')assert.equal((await prove({...options,cdpUrl})).exit_code,0);
  else await assert.rejects(prove({...options,cdpUrl}),error=>error.exitCode===78);
});
test('missing session and unreachable CDP are insufficient',async t=>{
  const options=await fixture(t);await assert.rejects(prove(options),error=>error.exitCode===78);
  const cdpUrl = await unreachableCdpEndpoint();
  await assert.rejects(exec(process.execPath,['scripts/prove-reasons-evidence-window.mjs','--origin',options.origin,'--expected-commit',options.expectedCommit,'--cdp-url',cdpUrl]),error=>error.code===78);
});
for(const mode of ['late connection','late page','stalled evaluation','page rejection'])test(`deadline and cleanup ${mode}`,async t=>{
  const options=await fixture(t);const {browser,cdpUrl}=await borrowed(t);
  const {chromium:cdp}=await import('playwright');const connection=await cdp.connectOverCDP(cdpUrl);
  const context=connection.contexts()[0];const existing=context.pages()[0] || await context.newPage();await existing.goto('about:blank#existing');
  const newPage=context.newPage.bind(context);let acquisition;
  if(mode==='late page')context.newPage=()=>acquisition=newPage().then(async page=>{await new Promise(resolve=>setTimeout(resolve,700));return page;});
  if(mode==='page rejection')context.newPage=async()=>{throw Error('retired');};
  const engine={connectOverCDP:async()=>{if(mode==='late connection')await new Promise(resolve=>setTimeout(resolve,700));return connection;}};
  await assert.rejects(prove({...options,engine,cdpUrl,timeoutMs:500,observe:()=>new Promise(()=>{})}),error=>error.exitCode===78);
  await acquisition?.catch(()=>{});
  const fresh=await cdp.connectOverCDP(cdpUrl);
  try {assert.deepEqual(fresh.contexts()[0].pages().map(page=>page.url()),['about:blank#existing']);assert.ok(browser.isConnected());}finally{await fresh.close();}
});
