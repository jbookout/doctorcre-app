import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { prove } from '../scripts/prove-quiet-vendor-owner-filter.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';
const exec = promisify(execFile);
const commit = '1'.repeat(40);
const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-vendor-owner-filter/recordings.json', import.meta.url))).response;

const assets = await appAssetSnapshot();

async function fixture(t) {
  let source=commit, response=structuredClone(recording), broken=false, corrupt=false, server;
  const start = async () => {
    await server?.close();
    const snapshot = new Map([...assets].map(([path, value]) => [path, {
      ...value, body: corrupt && path === '/js/ui-quiet-vendors.generated.js'
        ? value.body.toString().replaceAll('data-vendor-id','data-wrong-id') : value.body,
    }]));
    server = await startWorkerFixture({ assets: snapshot, env: {
      APP_ENV: 'production', GIT_SHA: source,
      CARR: { fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/v1/business/')) return Response.json(directoryFixture(request.url));
        if (url.pathname === '/mcp') {
          const body = await request.json();
          if (body.params?.name === "list-verbs") return Response.json({result:{content:[{type:"text",text:JSON.stringify(registry)}]}});
          const payload = structuredClone(response);
          if (broken) payload.proposals[0].owner = {bad:true};
          return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}});
        }
        return new Response('signed in');
      } },
    } });
  };
  t.after(()=>server?.close());
  await start();
  return {get origin(){return server.origin;},async setSource(value){source=value;await start();},empty(){response.proposals=[];},break(){broken=true;},async corrupt(){corrupt=true;await start();}};
}

test('recorded registered response passes the production app boundary',()=>{
  assert.deepEqual(validateQuietFollowUps(recording),recording);
  for(const owner of [false,12,{},[],'','   ']) {
    const bad=structuredClone(recording);bad.proposals[0].owner=owner;
    assert.throws(()=>validateQuietFollowUps(bad),{code:'invalid_projection'});
  }
});

test('equal release runs real rendered selection and clear; empty is insufficient',async t=>{
  const f=await fixture(t);
  const receipt=await prove({origin:f.origin,expectedCommit:commit,fixture:true});
  assert.equal(receipt.status,'passed');assert.equal(receipt.matching_count,7);assert.equal(receipt.business_reads,1);
  f.empty();await assert.rejects(prove({origin:f.origin,expectedCommit:commit,fixture:true}),{exitCode:78});
});

test('natural mode requires the existing signed-in session',async t=>{
  const f=await fixture(t);
  await assert.rejects(prove({origin:f.origin,expectedCommit:commit}),{exitCode:78});
});

test('equal, descendant, older, unrelated and unknown ancestry use self-contained git fixtures',async t=>{
  const root=temporaryDirectory('quiet-owner-ancestry-',t);
  const git=async(...args)=>(await exec('git',args,{cwd:root})).stdout.trim();
  await git('init','-q');await git('config','user.name','Synthetic');await git('config','user.email','synthetic@example.invalid');
  await writeFile(root+'/file','one');await git('add','file');await git('commit','-qm','one');const first=await git('rev-parse','HEAD');
  await writeFile(root+'/file','two');await git('commit','-qam','two');const second=await git('rev-parse','HEAD');
  await git('checkout','--orphan','unrelated');await git('commit','-qm','unrelated');const unrelated=await git('rev-parse','HEAD');
  const f=await fixture(t),prior=process.cwd();
  try {
    process.chdir(root);
    for(const [mode,expected,released,passes] of [['equal',first,first,true],['descendant',first,second,true],['older',second,first,false],['unrelated',first,unrelated,false],['unknown',first,'f'.repeat(40),false]]) {
      await f.setSource(released);
      if(passes) assert.equal((await prove({origin:f.origin,expectedCommit:expected,fixture:true})).status,'passed',mode);
      else await assert.rejects(prove({origin:f.origin,expectedCommit:expected,fixture:true}),{exitCode:78},mode);
    }
  } finally {process.chdir(prior);}
});

for(const mode of ['late launch','stalled evaluation']) test(`total deadline cleans ${mode}`,async t=>{
  const f=await fixture(t);
  await assertProofDeadlineCleanup(t,{entry:'scripts/prove-quiet-vendor-owner-filter.mjs',args:['--origin',f.origin,'--expected-commit',commit,'--fixture'],mode,timeoutMs:3000});
});

test('CLI executes a pass and insufficient evidence',async t=>{
  const f=await fixture(t);
  const args=['scripts/prove-quiet-vendor-owner-filter.mjs','--origin',f.origin,'--expected-commit',commit,'--timeout-ms','10000','--fixture'];
  const {stdout}=await exec(process.execPath,args);assert.equal(JSON.parse(stdout).status,'passed');
  await f.corrupt();args[2]=f.origin;await assert.rejects(exec(process.execPath,args),{code:1});
  f.empty();await assert.rejects(exec(process.execPath,args),{code:78});
});

test('CDP observation closes its page and disconnects while preserving the existing browser and page',async t=>{
  const f=await fixture(t);

  const {chromium}=await import('../scripts/proof-browser.mjs');
  const existingFixture = await ownedCdpFixture(); t.after(() => existingFixture.close());
  const existing=existingFixture.browser;
  t.after(()=>existing.close());
  const page=existingFixture.page;await page.goto('about:blank');
  const receipt=await prove({origin:f.origin,expectedCommit:commit,cdpUrl:existingFixture.endpoint});
  assert.equal(receipt.scope,'natural');
  assert.equal(existing.isConnected(),true);assert.equal(page.isClosed(),false);
  assert.equal(existing.contexts()[0].pages().length,1);
});

const registry = JSON.parse(await readFile(new URL("./fixtures/walk-verb-registry.json", import.meta.url))).response;

for (const mode of ['extra read', 'future read', 'write', 'unknown', 'unreadable', 'malformed', 'incomplete', 'empty', 'cleanup write', 'cleanup unknown']) test(`registry CLI ${mode}`, async t => {
  const f = await fixture(t, 'equal');
  const scratch = temporaryDirectory('registry-cli-', t);
  const preload = join(scratch, 'preload.mjs');
  const marker = join(scratch, 'forwarded');
  const live = structuredClone(registry);
  live.verbs.push({ name: 'future-proof-read', write: false }); live.count++;
  const name = mode.endsWith('write') ? live.verbs.find(row => row.write).name : mode.endsWith('unknown') ? 'unregistered-proof-call' : mode === 'future read' ? 'future-proof-read' : 'read-doctrine';
  if (mode === 'malformed') delete live.verbs[0].write;
  if (mode === 'incomplete') live.count++;
  if (mode === 'empty') { live.verbs = []; live.count = 0; }
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
    import { appendFile } from 'node:fs/promises';
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args), context = connection.contexts()[0];
      await context.route('**/mcp', async route => {
        const call = route.request().postDataJSON().params;
        if (call.name === 'list-verbs') {
          await appendFile(${JSON.stringify(marker + '.registry')}, '1');
          if (call.arguments.names_only !== true) throw Error('names_only registry required');
          if (${JSON.stringify(mode)} === 'unreadable') return route.fulfill({status:503,body:'Unavailable'});
          return route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(${JSON.stringify(live)})}]}}});
        }
        if (call.name === ${JSON.stringify(name)}) {
          await appendFile(${JSON.stringify(marker)}, call.name);
          return route.fulfill({json:{result:{content:[{type:'text',text:'{}'}]}}});
        }
        return route.fallback();
      });
      if (${JSON.stringify(mode)}.startsWith('cleanup')) {
        const newPage = context.newPage.bind(context);
        context.newPage = async (...args) => {
          const page = await newPage(...args), close = page.close.bind(page);
          page.close = async (...options) => {
            await page.evaluate(async name => {
              await fetch('/mcp', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name,arguments:{}}})}).catch(() => {});
            }, ${JSON.stringify(name)}).catch(() => {});
            return close(...options);
          };
          return page;
        };
      }
      await context.addInitScript(({name, cleanup}) => {
        if (cleanup) return;
        document.addEventListener('DOMContentLoaded', () => {
          void fetch('/mcp', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/call',params:{name,arguments:{}}})}).catch(() => {});
        });
      }, {name: ${JSON.stringify(name)}, cleanup: ${JSON.stringify(mode)}.startsWith('cleanup')});
      return connection;
    };
  `);

  const { chromium: owner } = await import('../scripts/proof-browser.mjs');
  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  t.after(() => browser.close());
  const cliArgs = ['--import', preload, 'scripts/prove-quiet-vendor-owner-filter.mjs', '--origin', f.origin, '--expected-commit', commit, '--cdp-url', browserFixture.endpoint];
  const execution = promisify(execFile)(process.execPath, cliArgs);
  if (['extra read', 'future read'].includes(mode)) {
    assert.equal(JSON.parse((await execution).stdout).status, 'passed');
    assert.equal(await readFile(marker, 'utf8'), name);
  } else {
    await assert.rejects(execution, error => {
      assert.equal(error.code, mode.endsWith('write') ? 1 : 78, error.stdout);
      return true;
    });
    await assert.rejects(readFile(marker), {code:'ENOENT'});
  }
  assert.equal(await readFile(marker + '.registry', 'utf8'), '1', 'one registry read');
  assert.ok(browser.isConnected());
});
