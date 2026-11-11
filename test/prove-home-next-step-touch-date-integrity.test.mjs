import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import worker from '../src/worker.js';
import { options } from '../scripts/prove-home-next-step-touch-date-integrity.mjs';
const runner = 'scripts/prove-home-next-step-touch-date-integrity.mjs';
const cli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runner, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
});
test('CLI contract rejects unsafe origins and invalid flags', async () => {
  for (const args of [[], ['--origin', 'http://example.com'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '30001'], ['--origin', 'https://example.com', '--unknown']]) assert.throws(() => options(args));
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /78 unavailable/);
});
test('exact proof CLI passes deployed bytes, contradicts calendar normalization, and refuses unavailable or changing release', async t => {
  const source = await readFile('src/ui/home/missing-next-step.tsx', 'utf8');
  const invalidCalendar = source.replace(/  if \(!Number\.isFinite\(date\.getTime\(\)\) \|\| date\.toISOString\(\)\.slice\(0, 10\) !== day\) return 'Last touch unavailable';\n/, '');
  assert.notEqual(invalidCalendar, source, 'negative fixture removes calendar validation');
  const defective = (await build({ stdin: { contents: invalidCalendar, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })).outputFiles[0].text;
  let server;
  async function prepare(mode) {
    await server?.close();
    const routes = new Map(snapshot);
    for(const key of routes.keys()) {
      if(mode==='asset-unavailable')routes.set(key,{status:404});
      if(key==='/js/ui-next-step.generated.js'&&['invalid-calendar','foreign','cap'].includes(mode))routes.set(key,{contentType:'text/javascript',body:mode==='invalid-calendar'?defective:mode==='foreign'?'import "https://example.com/foreign.js";':Array.from({length:21},(_,i)=>`import "./ui-shared-A${i}.generated.js";`).join('\n')});
    }
    const identity = async sha => ({contentType:'application/json',status:mode==='unavailable'?503:200,body:await(await worker.fetch(new Request('https://synthetic.invalid/app-release'),{APP_ENV:mode==='wrong-environment'?'staging':'production',GIT_SHA:sha.repeat(40)})).text(),...(mode==='timeout'?{hold:'timeout'}:{})});
    routes.set('/app-release',{sequence:[await identity('a'),await identity(mode==='changed'?'b':'a')]});
    server=await startFixture({routes});
    return ['--origin',server.origin,'--timeout-ms','30000'];
  }
  t.after(()=>server?.close());
  for (const [value, expected] of [['pass', 0], ['invalid-calendar', 1], ['changed', 1], ['unavailable', 78], ['wrong-environment', 78], ['asset-unavailable', 78], ['foreign', 78], ['cap', 78]]) {
    const args=await prepare(value);
    const result = await cli(args);
    assert.equal(result.code, expected, `${value}: ${result.stdout} ${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    const assetReads=server.requests.filter(req=>req.path!=='/app-release').length;
    assert.ok(assetReads <= 20);
    if (value === 'invalid-calendar') assert.match(receipt.assertions.at(-1).name, /impossible date unavailable without Mar 3/);
    if (value === 'pass') {
      assert.equal(server.requests.filter(req=>req.path==='/app-release').length, 2); assert.ok(receipt.assets.length >= 1);
      assert.ok(receipt.assertions.length >= 30); assert.ok(receipt.assertions.every(a => a.passed));
      for (const asset of receipt.assets) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    }
    console.log(JSON.stringify({ mode:value, exit: result.code, assertion: receipt.assertions?.at(-1), assets: assetReads }));
  }
  const args=await prepare('timeout');
  const timeout = await cli(args); assert.equal(timeout.code, 78, timeout.stdout);
  console.log(JSON.stringify({ mode:'timeout', exit: timeout.code, receipt: JSON.parse(timeout.stdout) }));
});
