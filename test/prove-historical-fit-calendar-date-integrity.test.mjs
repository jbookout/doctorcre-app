import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { options } from '../scripts/prove-historical-fit-calendar-date-integrity.mjs';

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runner = 'scripts/prove-historical-fit-calendar-date-integrity.mjs';
function cli(args, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, runner, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
test('CLI help documents every flag without contacting the origin', async t => {
  const server=await startFixture({routes:new Map([['/app-release',{status:500}]])});
  t.after(()=>server.close());
  const origin=server.origin;
  const guard = `data:text/javascript,${encodeURIComponent(`import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))}; chromium.launch = () => { throw Error('help attempted browser launch'); };`)}`;
  for (const args of [['--help'], ['--help', '--origin', origin]]) {
    const result = await cli(args, ['--import', guard]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const flag of ['--help', '--origin', '--timeout-ms', '--expected-revision']) assert.ok(result.stdout.includes(flag), flag);
    assert.match(result.stdout, /30000/);
    assert.equal(server.requests.length, 0, 'help must not run the proof');
  }
});
test('CLI refuses unsafe origin and invalid arguments', () => {
  for (const args of [[], ['--origin', 'http://example.com'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', 'NaN'], ['--origin', 'https://example.com', '--expected-revision', 'main']]) {
    assert.throws(() => options(args));
  }
});
test('proof command uses served modules and fails closed on unavailable assets and releases', async t => {
  const root = resolve('.');
  const source = await readFile('src/ui/ideal-client-profile.tsx', 'utf8');
  const check = 'new Date(date).toISOString().slice(0, 10) === value';
  assert.ok(source.includes(check), 'mutation must remove the real calendar round-trip guard');
  const invalidDates = await build({ stdin: { contents: source.replace(check, 'true'), loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  let server;
  async function prepare(mode) {
    await server?.close();
    const routes=new Map(snapshot);
    for(const key of routes.keys()) {
      if(mode==='protected-module')routes.set(key,{status:403});
      if(mode==='missing-export')routes.set(key,{contentType:'text/javascript',body:'export const missing = true;'});
    }
    if(mode==='accepts-impossible-date')routes.set('/js/ui-ideal-client-profile.generated.js',{contentType:'text/javascript',body:invalidDates.outputFiles[0].text});
    routes.set('/app-release',{status:mode==='protected-release'?401:200,contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:mode==='stale'?'0'.repeat(40):revision}),...(mode==='timeout'?{hold:'timeout'}:{})});
    server=await startFixture({routes});
    return ['--origin',server.origin,'--expected-revision',revision,'--timeout-ms','30000'];
  }
  t.after(()=>server?.close());
  const args=await prepare('valid'),origin=server.origin;
  const passed = await cli(args);
  assert.equal(passed.code, 0, passed.stderr);
  const receipt = JSON.parse(passed.stdout);
  assert.equal(receipt.origin, origin); assert.equal(receipt.release.source_commit, revision);
  assert.equal(receipt.assertions.length, 7);
  assert.ok(receipt.assertions.includes('invalidation terminally retires history')); assert.ok(receipt.module_urls.some(url => url.endsWith('/js/ui-ideal-client-profile.generated.js')));
  const brokenArgs=await prepare('accepts-impossible-date');
  const contradiction = await cli([...brokenArgs.slice(0, -1), '2000']);
  assert.equal(contradiction.code, 1, 'proof refuses renderer accepting February 31');
  assert.match(contradiction.stderr, /invalid evidence must not claim a completed win/);
  console.log(JSON.stringify({ scenario: 'accepts-impossible-date', exit: contradiction.code, error: contradiction.stderr.trim() }));
  for (const failure of ['stale', 'protected-release', 'protected-module', 'missing-export', 'timeout']) {
    const args=await prepare(failure);
    const result = await cli(failure === 'timeout' ? [...args.slice(0, -1), '200'] : args);
    assert.notEqual(result.code, 0, failure); assert.match(result.stderr, /Historical fit proof failed/);
  }
});
