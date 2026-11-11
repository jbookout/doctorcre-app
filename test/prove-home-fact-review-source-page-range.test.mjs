import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { factCases, factSnapshot } from '../scripts/prove-home-fact-review-source-page-range.mjs';
import { build } from 'esbuild';

const root = resolve('.');
const contract = JSON.parse(await readFile('contracts/carr-interface.v1/home_review.json'));
const facts = JSON.parse(await readFile('contracts/carr-interface.v1/fact_review.json'));
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('proof responses obey registered Home and fact field contracts and the production inbox parser', () => {
  const cases = factCases();
  assert.equal(parseSnapshot(factSnapshot(cases)).items.length, cases.length);
  for (const c of cases) {
    assert.equal(c.response.schema_version, contract.schema_version);
    assert.deepEqual(Object.keys(c.response.reference).sort(), [...contract.reference].sort());
    assert.deepEqual(c.response.reference.operations, contract.kinds.fact_review);
    assert.deepEqual(Object.keys(c.response.detail).sort(), [...facts.list.item].sort());
    assert.deepEqual(c.response.operations[0].args, { entity_ref: c.response.detail.entity_ref, fact_key: c.response.detail.fact_key,
      base_version: c.response.detail.canonical_version, review_version: c.response.detail.review_version });
  }
});
const run = (args, preload) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), 'scripts/prove-home-fact-review-source-page-range.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', resources = '';
  child.stdio[3].on('data', data => { resources += data; });
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject);
  child.on('close', code => {
    try { resolveRun({ code, receipt: JSON.parse(stdout), stderr, resources }); }
    catch (error) { reject(error); }
  });
});
test('proof CLI covers fetched boot, contradiction, unavailable, deadline and identity drift', async t => {
  const assets = await uiAssets(path => readFile(resolve(root, path)));
  const broken = await uiAssets(async path => {
    const bytes = await readFile(resolve(root, path));
    return path === 'src/ui/home/review.ts' ? Buffer.from(bytes.toString().replace('v >= 1 && v <= 100000', 'v >= 0').replace(' || o.source.page_end < o.source.page_start', '')) : bytes;
  });
  let server, origin, requests;
  async function prepare(mode) {
    await server?.close();
    const routes=new Map(snapshot);
    for(const [key,body] of (mode==='fail'?broken:assets))routes.set('/'+key,{contentType:'text/javascript',body});
    if(mode==='missing')for(const key of routes.keys())routes.set(key,{status:404});
    const key='/js/ui-inbox.generated.js';
    if(mode==='external'||mode==='cap')routes.set(key,{contentType:'text/javascript',body:Buffer.concat([Buffer.from(routes.get(key).body),Buffer.from(mode==='external'?'\nimport "https://example.invalid/evil.js";':Array.from({length:21},(_,i)=>`\nimport "./cap${i}.generated.js";`).join(''))])});
    const identity=async sha=>({contentType:'application/json',body:await(await handleDoctorcreRequest(new Request('https://fixture.test/app-release'),{GIT_SHA:sha.repeat(40),APP_ENV:mode==='identity'?'staging':'production'})).text(),...(mode==='timeout'?{hold:'timeout'}:{})});
    routes.set('/app-release',{sequence:[await identity('a'),await identity(mode==='drift'?'b':'a')]});
    server=await startFixture({routes});origin=server.origin;
  }
  t.after(()=>server?.close());
  for (const [scenario, code] of [['pass', 0], ['fail', 1], ['missing', 78], ['identity', 78], ['drift', 1], ['external', 78], ['cap', 78], ['timeout', 78]]) await t.test(scenario, async () => {
    await prepare(scenario);
    const result = await run(['--origin', origin, '--timeout-ms', '30000']);
    assert.equal(result.code, code, JSON.stringify(result.receipt));
    requests=server.requests.map(req=>req.target);
    assert.ok(requests.filter(path => path !== '/app-release').length <= 20);
    const assetPaths = requests.filter(path => path !== '/app-release');
    assert.equal(new Set(assetPaths).size, assetPaths.length, 'no asset retries');
    if (scenario === 'pass') {
      assert.equal(requests.filter(path=>path==='/app-release').length, 2);
      assert.deepEqual(result.receipt.release, result.receipt.releaseAfter);
      assert.ok(result.receipt.assertions.length >= 29);
      assert.ok(result.receipt.assertions.every(a => a.passed));
      for (const asset of result.receipt.assets) {
        const key = new URL(asset.url).pathname.slice(1);
        const bytes = assets.get(key) || snapshot.get('/'+key).body;
        assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
      }
    }
    if (scenario === 'fail') assert.match(result.receipt.error, /zero-start refuses approval/);
    if (scenario === 'drift') assert.match(result.receipt.error, /release changed/);
    if (scenario === 'timeout') assert.match(result.receipt.error, /deadline/);
  });
  for (const fault of ['late launch', 'stalled evaluation']) await t.test(`deadline cleans ${fault}`, async () => {
    await prepare('pass');
    const preload = `
      import { chromium } from ${JSON.stringify(pathToFileURL(resolve('node_modules/playwright/index.mjs')).href)};
      import { writeSync } from 'node:fs';
      import { mock } from 'node:test';
      import { CHROMIUM_SAFETY_ARGS } from ${JSON.stringify(pathToFileURL(resolve('scripts/chromium-safety-args.mjs')).href)};
      process.emitWarning('resource diagnostics must not be parsed as JSON');
      const launch = chromium.launch.bind(chromium);
      const nativeSetTimeout = globalThis.setTimeout;
      const stalled = ${JSON.stringify(fault)} === 'stalled evaluation';
      const browser = await launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: 30000 });
      const session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const pids = processInfo.map(info => info.id);
      await session.detach();
      let evaluationStarted = false, closing;
      const close = browser.close.bind(browser);
      browser.close = () => closing ||= (async () => {
        await close();
        const connected = browser.isConnected();
        const survivors = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        writeSync(3, JSON.stringify({ connected, survivors, evaluationStarted }));
      })();
      mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
      const controlledSetTimeout = globalThis.setTimeout;
      let ownerScheduled = false;
      globalThis.setTimeout = (callback, ms, ...args) => {
        if (!ownerScheduled && ms === 1000) {
          ownerScheduled = true;
          return controlledSetTimeout(callback, ms, ...args);
        }
        return nativeSetTimeout(callback, ms, ...args);
      };
      const expire = () => {
        mock.timers.tick(1000);
        mock.timers.reset();
      };
      chromium.launch = async () => {
        if (!stalled) expire();
        else {
          const newContext = browser.newContext.bind(browser);
          browser.newContext = async options => {
            const context = await newContext(options);
            const newPage = context.newPage.bind(context);
            context.newPage = async () => {
              const page = await newPage();
              page.evaluate = () => new Promise((_, reject) => {
                evaluationStarted = true;
                browser.once('disconnected', () => reject(Error('browser closed during stalled evaluation')));
                expire();
              });
              return page;
            };
            return context;
          };
        }
        return browser;
      };
    `;
    const result = await run(['--origin', origin, '--timeout-ms', '1000'], preload);
    assert.equal(result.code, 78, JSON.stringify(result));
    assert.equal(result.receipt.status, 'unavailable');
    assert.match(result.receipt.error, /deadline/);
    assert.match(result.stderr, /resource diagnostics must not be parsed as JSON/);
    const resources = JSON.parse(result.resources);
    assert.deepEqual(resources, { connected: false, survivors: [], evaluationStarted: fault === 'stalled evaluation' });
    t.diagnostic(JSON.stringify({ fault, exitCode: result.code, ...resources }));
  });
  for (const args of [[], ['--origin', origin, '--timeout-ms', '30001'], ['--origin', origin + '/bad', '--timeout-ms', '30000'], ['--unknown']]) {
    assert.equal((await run(args)).code, 1);
  }
});
