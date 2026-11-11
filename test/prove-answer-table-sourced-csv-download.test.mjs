import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-answer-table-sourced-csv-download.mjs';

const run = (origin, fixture = true) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/prove-answer-table-sourced-csv-download.mjs', '--origin', origin, ...(fixture ? ['--fixture'] : [])]);
  let output = ''; child.stdout.on('data', data => { output += data; });
  child.on('error', reject); child.on('exit', code => resolve({code, receipt:JSON.parse(output)}));
});
test('proof uses checked-out assets, distinguishes fixture evidence and cleans owned browsers', async t => {
  const assets = await proofAssetSnapshot();
  const release = { service:'doctorcre-app', environment:'production', source_commit:'c962c060e2b1aa2cc1f4a4a0a6dd4e3c868d44af' };
  let server;
  const start = async mode => {
    await server?.close();
    const snapshot = new Map([...assets].map(([key, value]) => [key, mode === 'missing' ? { status:404 }
      : { ...value, body: mode === 'fail' ? value.body.toString().replaceAll('Download visible rows','Broken action') : value.body }]));
    server = await startFixture({ assets:snapshot, routes:new Map([['/app-release', {body:JSON.stringify(release),contentType:'application/json'}]]) });
    return server.origin;
  };
  t.after(() => server?.close());
  for (const [name, fixture, expected] of [['pass',true,0],['fail',true,1],['missing',true,78],['pass',false,78]]) await t.test(`${name} fixture=${fixture}`,async () => {
    const result = await run(await start(name),fixture);
    assert.equal(result.code,expected,JSON.stringify(result.receipt));
    if (expected === 0) assert.ok(result.receipt.assertions.length > 30);
    if (!fixture) { assert.equal(result.receipt.status,'insufficient_evidence'); console.log(`reviewed release, no session: exit ${result.code}, assertions ${result.receipt.assertions.filter(a=>a.passed).length}`); }
  });
  for (const path of ['/..%2fpackage.json','/%2e%2e%2fpackage.json']) {
    const response = await fetch(server.origin + path);
    assert.equal(response.status,400,'encoded traversal is refused');
  }
  const origin = await start('pass');
  for (const scenario of ['stalled evaluation','late launch']) await t.test(`${scenario} exits 78 without owned survivors`,async () => {
    let acquired;
    let started;
    const launchStarted = new Promise(resolve => { started = resolve; });
    const engine = {async launch(options) {
      const server = await chromium.launchServer({...options,args:[...CHROMIUM_SAFETY_ARGS,...(options.args || [])]});
      const pid = server.process().pid;
      const browser = await chromium.connect(server.wsEndpoint());
      const originalClose = browser.close.bind(browser);
      browser.close = async () => { await originalClose(); await server.close(); };
      acquired = {browser,pid}; started();
      if (scenario === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
      else {
        const originalContext = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await originalContext(...args), originalPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await originalPage();
            page.evaluate = () => new Promise(() => {});
            return page;
          };
          return context;
        };
      }
      return browser;
    }};
    const pending = prove({origin,timeoutMs:1000,fixture:true,engine});
    await launchStarted;
    const receipt = await pending;
    assert.equal(receipt.exitCode,78,JSON.stringify(receipt));
    await new Promise(resolve => setTimeout(resolve,1500));
    assert.equal(acquired.browser.isConnected(),false);
    assert.throws(() => process.kill(acquired.pid,0), {code:'ESRCH'});
  });
});

test('natural CLI release ancestry and deadline exit matrix', async t => {
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const { writeFile, chmod, mkdir } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const root = temporaryDirectory('sourced-csv-proof-', t);
  const git = args => execFileSync('/usr/bin/git', args, {cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  git(['init','-q']);
  const tree = git(['mktree']);
  const older = git(['commit-tree',tree,'-m','older']);
  const equal = git(['commit-tree',tree,'-p',older,'-m','reviewed merge (#767)']);
  const descendant = git(['commit-tree',tree,'-p',equal,'-m','descendant']);
  const unrelated = git(['commit-tree',tree,'-m','unrelated']);
  git(['update-ref','refs/remotes/origin/main',descendant]);
  await mkdir(resolve(root,'bin'));
  await writeFile(resolve(root,'bin/git'), `#!/bin/sh\nif [ "$PROOF_SLOW_GIT" = 1 ]; then exec /bin/sleep 10; fi\nexec /usr/bin/git -C '${root}' "$@"\n`);
  await chmod(resolve(root,'bin/git'),0o755);
  let release = equal, mode = 'pass';
  const assets = await proofAssetSnapshot();
  const blocks = JSON.parse(await readFile('test/fixtures/answer-table-sourced-csv-download/recordings.json'));
  let server, origin, snapshotKey, page;
  const prepare = async () => {
    const key = `${release}:${mode}`;
    if (snapshotKey === key) return;
    await server?.close();
    const snapshot = new Map([...assets].map(([path, value]) => [path, { ...value,
      body: mode === 'fail' ? value.body.toString().replaceAll('Download visible rows','Broken action') : value.body }]));
    const identity = sha => ({ body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:sha}),contentType:'application/json' });
    const routes = new Map([
      ['/app-release', mode === 'unreadable' ? {status:503} : mode === 'changed'
        ? {sequence:[identity(release),identity(descendant)]} : identity(release)],
      ['/', { contentType:'text/html', body:`<!doctype html><button id="accountSignOut">Sign out</button><main></main><script type="module">import {mountAnswerBlocks} from '/js/ui-answers.generated.js';mountAnswerBlocks(document.querySelector('main'),${JSON.stringify(blocks.populated)},'recorded');</script>` }],
    ]);
    server = await startFixture({assets:snapshot,routes});
    origin = server.origin; snapshotKey = key;
    if (page) { await page.goto(origin); await page.locator('.answer-table tbody tr').first().waitFor(); }
  };
  await prepare();
  t.after(() => server?.close());
  const portFixture = await startFixture();
  const port = new URL(portFixture.origin).port;
  await portFixture.close();
  const context = await chromium.launchPersistentContext(temporaryDirectory('sourced-csv-browser-',t),{headless:true,acceptDownloads:true,args:[...CHROMIUM_SAFETY_ARGS,`--remote-debugging-port=${port}`]});
  t.after(()=>context.close());
  page = await context.newPage();
  await page.goto(origin);
  await page.locator('.answer-table tbody tr').first().waitFor();
  const runNatural = async (options = {}) => {
    await prepare();
    return new Promise((resolve,reject) => {
      const child = spawn(process.execPath,['scripts/prove-answer-table-sourced-csv-download.mjs','--origin',origin,...(options.defaultCommit ? [] : ['--commit',equal]),'--timeout-ms',String(options.timeout || 10000),...(options.noSession ? [] : ['--cdp-url',`http://127.0.0.1:${port}`])],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`,PROOF_SLOW_GIT:options.slow ? '1' : '0'}});
      let output = '';
      child.stdout.on('data',data=>output+=data);
      child.on('error',reject);
      child.on('close',code=>resolve({code,receipt:JSON.parse(output)}));
    });
  };
  for (const [name,sha,state,expected] of [['equal',equal,'pass',0],['descendant',descendant,'pass',0],['older',older,'pass',78],['unrelated',unrelated,'pass',78],['unknown','b'.repeat(40),'pass',78],['unreadable',equal,'unreadable',78],['assertion failure',equal,'fail',1]]) await t.test(name,async()=>{
    release=sha;mode=state;
    const result=await runNatural();
    assert.equal(result.code,expected,JSON.stringify(result.receipt));
    if(expected===0){assert.equal(result.receipt.natural.passed,true);assert.equal(result.receipt.release.source_commit,result.receipt.releaseAfter.source_commit);assert.ok(result.receipt.assertions.length>=55);}
    console.log(`${name}: exit ${result.code}, assertions ${result.receipt.assertions.length}`);
  });
  release=equal;mode='pass';
  await t.test('default resolves the PR merge commit',async()=>assert.equal((await runNatural({defaultCommit:true})).code,0));
  await t.test('release changes during proof',async()=>{mode='changed';try{assert.equal((await runNatural()).code,78);}finally{mode='pass';await prepare();}});
  await t.test('signed-out session',async()=>{await page.locator('#accountSignOut').evaluate(node=>node.id='signedOut');try{assert.equal((await runNatural()).code,78);}finally{await page.locator('#signedOut').evaluate(node=>node.id='accountSignOut');}});
  await t.test('no session',async()=>assert.equal((await runNatural({noSession:true})).code,78));
  await t.test('no eligible table',async()=>{
    await page.locator('.answer-table').evaluate(node=>node.hidden=true);
    await page.locator('.answer-table').evaluate(node=>node.classList.remove('answer-table'));
    try { assert.equal((await runNatural()).code,78); }
    finally { await page.locator('section').evaluate(node=>{node.classList.add('answer-table');node.hidden=false;}); }
  });
  await t.test('natural source mismatch exits 1 and restores view',async()=>{
    await page.locator('th button').nth(3).click();
    const before = await page.locator('th').nth(3).getAttribute('aria-sort');
    const source = page.locator('.answer-source span').first();
    const text = await source.textContent();
    await source.evaluate(node=>node.textContent='Record invalid');
    try { assert.equal((await runNatural()).code,1); }
    finally { await source.evaluate((node,text)=>node.textContent=text,text); }
    assert.equal(await page.locator('th').nth(3).getAttribute('aria-sort'),before);
  });
  await t.test('slow ancestry shares total deadline',async()=>{
    const start=Date.now();
    const result=await runNatural({slow:true,timeout:300});
    assert.equal(result.code,78,JSON.stringify(result.receipt));
    assert.ok(Date.now()-start<2000,'git must be killed within the proof deadline');
  });
});
