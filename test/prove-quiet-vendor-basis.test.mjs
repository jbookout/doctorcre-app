import { readAppRelease } from '../scripts/app-release-reader.mjs';
import { admitRecording } from './fixtures/quiet-vendor-basis/producer.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixture, startWorkerFixture } from '../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { prove } from '../scripts/prove-quiet-vendor-basis.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';
const exec = promisify(execFile);
const commit = '1'.repeat(40);
const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-vendor-basis/recordings.json', import.meta.url)));

await admitRecording();
recording.proposals = recording.proposals.filter(row => row.owner !== 'dell' || row.basis === 'last_contact');
validateQuietFollowUps(recording);
const assets = await appAssetSnapshot();

async function fixture(t) {
  let source=commit, response=structuredClone(recording), corrupt=false, nearMiss=false, server;
  const start = async () => {
    await server?.close();
    const snapshot = new Map([...assets].map(([path, value]) => [path, {
      ...value, body: corrupt && path === '/js/ui-quiet-vendors.generated.js'
        ? value.body.toString().replaceAll(corrupt === 'history' ? 'Contact history' : 'data-vendor-id', corrupt === 'history' ? 'History unavailable' : 'data-wrong-id') : nearMiss && path === '/js/ui-quiet-vendors.generated.js' ? value.body.toString().replaceAll('matching loaded vendors','matching loaded vendorsx') : value.body,
    }]));
    server = await startWorkerFixture({ assets: snapshot, env: {
      APP_ENV: 'production', GIT_SHA: source,
      CARR: { fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/v1/business/')) return Response.json(directoryFixture(request.url));
        if (url.pathname === '/mcp') {
          const body = await request.json();
          const payload = structuredClone(response);
          return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}});
        }
        return new Response('signed in');
      } },
    } });
  };
  t.after(()=>server?.close());
  await start();
  return {get origin(){return server.origin;},async setSource(value){source=value;await start();},empty(){response.proposals=[];},async nearMiss(){nearMiss=true;await start();},async corrupt(mode='ids'){corrupt=mode;await start();}};
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
  assert.equal(receipt.status,'passed');assert.ok(receipt.assertions.length > 6);assert.equal(receipt.business_reads,receipt.reads_before_filters);
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
  await assertProofDeadlineCleanup(t,{entry:'scripts/prove-quiet-vendor-basis.mjs',args:['--origin',f.origin,'--expected-commit',commit,'--fixture'],mode,timeoutMs:3000});
});

test('CLI executes a pass and insufficient evidence',async t=>{
  const f=await fixture(t);
  const args=['scripts/prove-quiet-vendor-basis.mjs','--origin',f.origin,'--expected-commit',commit,'--timeout-ms','10000','--fixture'];
  const {stdout}=await exec(process.execPath,args);t.diagnostic(`pass exit 0 ${stdout.trim()}`);assert.equal(JSON.parse(stdout).status,'passed');
  await f.nearMiss();args[2]=f.origin;await assert.rejects(exec(process.execPath,args),error=>{t.diagnostic(`near-miss exit ${error.code} ${error.stdout.trim()}`);return error.code===1;});
  await f.corrupt();args[2]=f.origin;await assert.rejects(exec(process.execPath,args),{code:1});
  f.empty();await assert.rejects(exec(process.execPath,args),{code:78});
});

test('CDP observation closes its page and disconnects while preserving the existing browser and page',async t=>{
  const f=await fixture(t);
  const portFixture=await startFixture();
  const port=new URL(portFixture.origin).port;await portFixture.close();
  const {chromium}=await import('../scripts/proof-browser.mjs');
  const existing=await chromium.launch({args:[`--remote-debugging-port=${port}`]});
  t.after(()=>existing.close());
  const page=await existing.newPage();await page.goto('about:blank');
  const receipt=await prove({origin:f.origin,expectedCommit:commit,cdpUrl:`http://127.0.0.1:${port}`});
  assert.equal(receipt.scope,'natural');
  assert.equal(existing.isConnected(),true);assert.equal(page.isClosed(),false);
  assert.equal(existing.contexts()[0].pages().length,1);
});

test('containing release with unreachable CDP is insufficient evidence', async t => {
  const f = await fixture(t);
  const portFixture = await startFixture();
  const endpoint = portFixture.origin; await portFixture.close();
  await assert.rejects(prove({origin:f.origin,expectedCommit:commit,cdpUrl:endpoint,timeoutMs:1000}), {exitCode:78});
});


test('closed CDP context during CLI page acquisition is insufficient evidence', async t => {
  const f = await fixture(t);
  const portFixture = await startFixture();
  const endpoint = portFixture.origin; await portFixture.close();
  const { chromium } = await import('../scripts/proof-browser.mjs');
  const { chromium: driver } = await import('playwright');
  const existing = await chromium.launch({args:[`--remote-debugging-port=${new URL(endpoint).port}`]});
  t.after(() => existing.close());
  const preexisting = await existing.newPage();
  const root = temporaryDirectory('quiet-vendor-closed-context-', t);
  const preload = root + '/preload.mjs';
  await writeFile(preload, `
    const { chromium } = await import(${JSON.stringify(import.meta.resolve('playwright'))});
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const browser = await connect(...args);
      const context = browser.contexts()[0], newPage = context.newPage.bind(context);
      context.newPage = async () => {
        await browser.close();
        return newPage();
      };
      return browser;
    };
  `);
  await assert.rejects(exec(process.execPath, ['--import', preload, 'scripts/prove-quiet-vendor-basis.mjs', '--origin', f.origin, '--expected-commit', commit, '--cdp-url', endpoint]), error => {
    t.diagnostic(`closed context exit ${error.code} ${error.stdout.trim()}`);
    assert.match(JSON.parse(error.stdout).error, /browserContext.newPage: Target page, context or browser has been closed/);
    assert.equal(error.code, 78);
    return true;
  });
  const fresh = await driver.connectOverCDP(endpoint);
  try { assert.equal(fresh.contexts()[0].pages().length, 1); } finally { await fresh.close(); }
  assert.equal(existing.isConnected(), true);
  assert.equal(preexisting.isClosed(), false);
  t.diagnostic('borrowedBrowserPreserved=true pages=1');
});

test('late CDP page acquisition drains before disconnect and preserves borrowed pages', async t => {
  const f = await fixture(t);
  const portFixture = await startFixture();
  const port = new URL(portFixture.origin).port; await portFixture.close();
  const { chromium } = await import('../scripts/proof-browser.mjs');
  const { chromium: driver } = await import('playwright');
  const existing = await chromium.launch({args:[`--remote-debugging-port=${port}`]});
  t.after(() => existing.close());
  const preexisting = await existing.newPage();
  let acquired = false;
  const endpoint = `http://127.0.0.1:${port}`;
  const engine = { async connectOverCDP(...args) {
    const browser = await driver.connectOverCDP(...args);
    const context = browser.contexts()[0], original = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await original(); acquired = true;
      await new Promise(resolve => setTimeout(resolve, 1300));
      return page;
    };
    return browser;
  } };
  await assert.rejects(prove({origin:f.origin,expectedCommit:commit,cdpUrl:endpoint,engine,timeoutMs:1000}),{exitCode:78});
  assert.equal(acquired,true);
  const fresh = await driver.connectOverCDP(endpoint);
  try { assert.equal(fresh.contexts()[0].pages().length,1); } finally { await fresh.close(); }
  assert.equal(existing.isConnected(),true); assert.equal(preexisting.isClosed(),false);
});

test('missing history control on a containing release is an assertion failure', async t => {
  const f = await fixture(t); await f.corrupt('history');
  await assert.rejects(exec(process.execPath, ['scripts/prove-quiet-vendor-basis.mjs', '--origin', f.origin, '--expected-commit', commit, '--fixture']), error => {
    const receipt = JSON.parse(error.stdout);
    t.diagnostic(`missing control exit ${error.code} ${error.stdout.trim()}`);
    return error.code === 1 && receipt.error.startsWith('Contact history selector present');
  });
});

for (const mismatch of [false, true]) test(`changing release refuses evidence even with assertion mismatch ${mismatch}`, async t => {
  const f = await fixture(t);
  if (mismatch) await f.corrupt();
  let reads = 0;
  const readRelease = async (...args) => {
    const observed = await readAppRelease(...args);
    return ++reads === 1 ? observed : {...observed, source_commit:'f'.repeat(40)};
  };
  await assert.rejects(prove({origin:f.origin,expectedCommit:commit,fixture:true,readRelease}),{exitCode:78});
  assert.equal(reads,2);
});
