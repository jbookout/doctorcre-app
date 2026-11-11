import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { prove } from '../scripts/prove-territory-pages.mjs';
import { chromium } from '../scripts/proof-browser.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { territoryFixture } from './fixtures/territory-pages/fixture.mjs';
const exec=promisify(execFile), sha='a'.repeat(40);
async function setup(t, {count=45, release=sha, after=release, mismatch=false}={}) {
  const server=await startFixture({routes:new Map([['/app-release',{sequence:[release,after].map(source_commit=>({contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit})}))}]])});
  t.after(()=>server.close());
  const root=temporaryDirectory('territory-pages-proof-',t), recording=join(root,'recording.json');
  await writeFile(recording,JSON.stringify(territoryFixture(count)));
  let engine=chromium;
  if(mismatch)engine={launch:async options=>{
    const browser=await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }), create=browser.newPage.bind(browser);
    browser.newPage=async options=>{const page=await create(options);await page.addInitScript(()=>{new MutationObserver(()=>{const status=document.querySelector('.territory-evidence [role="status"]');if(status?.textContent.startsWith('Showing ')&&!status.textContent.includes('999'))status.textContent=status.textContent.replace('45 total','999 total');}).observe(document,{subtree:true,childList:true,characterData:true});});return page;};return browser;
  }};
  return {origin:server.origin,expectedCommit:sha,fixture:true,recordingUrl:recording,engine};
}
for(const [mode,source,ancestry,code] of [['equal',sha,undefined,0],['descendant','b'.repeat(40),async()=>true,0],['older','c'.repeat(40),async()=>false,78],['unrelated','d'.repeat(40),async()=>false,78],['unknown','f'.repeat(40),async()=>{throw Error('unknown');},78]])test(`release ${mode} exits ${code}`,async t=>{
  const options=await setup(t,{release:source});
  if(code)await assert.rejects(prove({...options,ancestry}),e=>e.exitCode===code);
  else {const receipt=await prove({...options,ancestry});assert.equal(receipt.local_reads,0);assert.equal(receipt.counts.loaded,45);assert.equal(receipt.assertions.length,5);}
});
test('changing release is insufficient evidence',async t=>{const options=await setup(t,{after:'b'.repeat(40)});await assert.rejects(prove({...options,ancestry:async()=>true}),e=>e.exitCode===78);});
for(const count of [0,20,21])test(`insufficient natural subjects ${count}`,async t=>{await assert.rejects(prove(await setup(t,{count})),e=>e.exitCode===78);});
test('near miss visible total fails exactly',async t=>{await assert.rejects(prove(await setup(t,{mismatch:true})),e=>!e.exitCode&&e.code==='ERR_ASSERTION');});
test('containing release and unreachable CDP exit 78',async t=>{const options=await setup(t);await assert.rejects(prove({...options,fixture:false,cdpUrl:'http://127.0.0.1:1',timeoutMs:2000}),e=>e.exitCode===78);});
for(const mode of ['stalled evaluation','late launch'])test(`timeout drains ${mode}`,async t=>{
  const options=await setup(t);let owned;
  const engine={launch:async args=>{
    owned=await chromium.launch({ ...args, args: [...CHROMIUM_SAFETY_ARGS, ...(args.args || [])] });
    if(mode==='late launch')await new Promise(r=>setTimeout(r,1800));
    else {const create=owned.newPage.bind(owned);owned.newPage=async options=>{const page=await create(options);const go=page.goto.bind(page);page.goto=async(...args)=>{await go(...args);return page.evaluate(()=>new Promise(()=>{}));};return page;};}
    return owned;
  }};
  await assert.rejects(prove({...options,engine,timeoutMs:1400}),e=>e.exitCode===78);
  assert.equal(owned?.isConnected(),false,'zero connected owned browsers');
});
for(const [mode,count,code]of [['pass',45,0],['insufficient',1,78]])test(`CLI ${mode} exits ${code}`,async t=>{
  const options=await setup(t,{count});
  const args=[fileURLToPath(new URL('../scripts/prove-territory-pages.mjs',import.meta.url)),'--origin',options.origin,'--expected-commit',sha,'--fixture','--recording',options.recordingUrl,'--timeout-ms','30000'];
  let result;try{result=await exec(process.execPath,args,{timeout:35000});result.code=0;}catch(e){result=e;}
  assert.equal(result.code,code,result.stdout+result.stderr);console.log(`${mode}: exit ${result.code} ${result.stdout.trim()}`);
});
import { chromium as cdpChromium } from 'playwright';
test('real CDP late page closes before disconnect and preserves borrowed tabs',async t=>{
  const ownedFixture = await ownedCdpFixture(); t.after(() => ownedFixture.close());
  const owned=ownedFixture.browser;t.after(()=>owned.close());
  const url=ownedFixture.endpoint, original=await cdpChromium.connectOverCDP(url);t.after(()=>original.close());
  const borrowed=await original.contexts()[0].newPage();await borrowed.goto('about:blank');
  const count=original.contexts()[0].pages().length;
  const engine={connectOverCDP:async(...args)=>{
    const connection=await cdpChromium.connectOverCDP(...args),context=connection.contexts()[0],create=context.newPage.bind(context);
    context.newPage=async()=>{const page=await create();await new Promise(r=>setTimeout(r,1500));return page;};return connection;
  }};
  const options=await setup(t);
  await assert.rejects(prove({...options,fixture:false,cdpUrl:url,engine,timeoutMs:800}),e=>e.exitCode===78);
  const fresh=await cdpChromium.connectOverCDP(url);try{assert.equal(fresh.contexts()[0].pages().length,count);assert.equal(borrowed.isClosed(),false);}finally{await fresh.close();}
});
test('CLI near miss assertion exits 1',async t=>{
  const options=await setup(t),root=temporaryDirectory('territory-pages-injection-',t),injection=join(root,'inject.mjs');
  const driver=new URL('../node_modules/playwright/index.mjs',import.meta.url).href;
  await writeFile(injection,`import {chromium} from ${JSON.stringify(driver)};
const launch=chromium.launch.bind(chromium);
chromium.launch=async options=>{const browser=await launch(options),create=browser.newPage.bind(browser);browser.newPage=async options=>{const page=await create(options);await page.addInitScript(()=>{new MutationObserver(()=>{const status=document.querySelector('.territory-evidence [role="status"]');if(status?.textContent.includes('45 total')&&!status.dataset.corrupted){status.dataset.corrupted='true';status.textContent=status.textContent.replace('45 total','145 total');}}).observe(document,{subtree:true,childList:true,characterData:true});});return page;};return browser;};`);
  let result;try{result=await exec(process.execPath,['--import',injection,fileURLToPath(new URL('../scripts/prove-territory-pages.mjs',import.meta.url)),'--origin',options.origin,'--expected-commit',sha,'--fixture','--recording',options.recordingUrl],{timeout:35000});}catch(e){result=e;}
  assert.equal(result.code,1,result.stdout+result.stderr);console.log(`near-miss: exit ${result.code} ${result.stdout.trim()}`);
});

test('fixture mode refuses nonloopback origins before any read',async()=>{await assert.rejects(prove({origin:'https://example.invalid',expectedCommit:sha,fixture:true,readRelease:()=>{throw Error('must not read');}}),e=>e.exitCode===78);});

test('controlled cold asset startup reaches evaluation before deadline', async t => {
  const options = await setup(t);
  const root = temporaryDirectory('territory-timing-', t), preload = join(root, 'preload.mjs');
  await writeFile(preload, "import { registerHooks, syncBuiltinESMExports } from 'node:module';\nimport http from 'node:http';\nimport { chromium } from 'playwright';\nconst launch = chromium.launch.bind(chromium);\nchromium.launch = async options => {\n  globalThis.reviewDeadline = Date.now() + 1400;\n  const browser = await launch(options);\n  const create = browser.newPage.bind(browser);\n  browser.newPage = async (...args) => {\n    const page = await create(...args);\n    const go = page.goto.bind(page);\n    page.goto = async (url, options) => {\n      await go(url, { ...options, ...(options?.timeout < 400 ? { timeout: 6 } : {}) });\n      process.stderr.write('TIMING_PROBE_EVALUATION_REACHED\\n');\n      return page.evaluate(() => new Promise(() => {}));\n    };\n    return page;\n  };\n  return browser;\n};\nconst server = http.createServer;\nhttp.createServer = function (...args) {\n  const i = args.findIndex(a => typeof a === 'function');\n  if (i >= 0) {\n    const handler = args[i];\n    args[i] = (req, res) => {\n      if (req.url === '/leads') setTimeout(() => handler(req, res), 100);\n      else handler(req, res);\n    };\n  }\n  return server.apply(this, args);\n};\nsyncBuiltinESMExports();\nregisterHooks({load(url, context, next) {\n  const result = next(url, context);\n  if (url.endsWith('/scripts/fixture-app-assets.mjs')) {\n    result.source = String(result.source).replace('export async function appAssetSnapshot(builtRoot, sourceRoot = process.cwd()) {', 'export async function appAssetSnapshot(builtRoot, sourceRoot = process.cwd()) { await new Promise(r=>setTimeout(r, Math.max(0, globalThis.reviewDeadline-Date.now()-250)));');\n  }\n  return result;\n}});\n".replace("from 'playwright'", `from ${JSON.stringify(import.meta.resolve('playwright'))}`));
  let result;
  try { result = await exec(process.execPath, ['--import', preload, 'scripts/prove-territory-pages.mjs', '--origin', options.origin, '--expected-commit', sha, '--fixture', '--recording', options.recordingUrl, '--timeout-ms', '1400'], { timeout: 35000 }); }
  catch (error) { result = error; }
  t.diagnostic(`controlled startup exit ${result.code} ${result.stdout?.trim()}`);
  assert.equal(result.code, 78, result.stdout + result.stderr);
  assert.match(result.stderr, /TIMING_PROBE_EVALUATION_REACHED/);
  assert.equal(JSON.parse(result.stdout).status, 'insufficient_evidence');
});
