import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { readFile } from 'node:fs/promises';
import { assertions, checkedDirectory, inboxFixture, runProof } from '../scripts/prove-waiting-people-retry-page-cursor.mjs';
import { build } from 'esbuild';
const runner = 'scripts/prove-waiting-people-retry-page-cursor.mjs';
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args]); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(t, mode) {
  const routes = new Map(snapshot);
  for(const [key,value] of routes) {
    if(mode==='contradiction')routes.set(key,{...value,body:value.body.toString().replaceAll('limit:25','limit:24')});
    if(mode==='unavailable asset')routes.set(key,{status:404});
    if(mode==='timeout asset')routes.set(key,{hold:'timeout'});
  }
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify(mode==='unavailable'?{}:{service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)}),...(mode==='timeout'?{hold:'timeout'}:{})});
  const server=await startFixture({routes});
  t.after(()=>server.close());
  return {origin:server.origin,get methods(){return server.requests.map(req=>req.method);}};
}
test('proof fixture uses the production inbox parser and registered directory contract', async () => {
  const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  assert.equal(parseSnapshot(inboxFixture()).items[0].waiting_on, null);
  assert.throws(() => checkedDirectory('search-parties-v1', 'response', { ok: true }));
  assert.throws(() => parseSnapshot({ ok: true }));
});
test('exact declared command and five assertions pass against fetched fixture bytes', async t => {
  const declaration = JSON.parse(await readFile('proofs/requirements/waiting-people-retry-page-cursor.json'));
  assert.ok(declaration.assertions[0].predicate.includes(`node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`));
  assert.equal(declaration.safety.max_requests, 31); assert.equal(declaration.safety.max_runtime_seconds, 30);
  assert.equal(declaration.assertions[0].deadline_seconds, 30);
  const fixtureOrigin = await fixture(t, 'passing');
  const result = await cli(['--origin', fixtureOrigin.origin, '--timeout-ms', '30000']);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.assertions, assertions); assert.equal(receipt.release.source_commit, '1'.repeat(40));
  assert.ok(receipt.assets.some(asset => asset.url.endsWith('/js/ui-inbox.generated.js')));
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(receipt.assets.length <= 30); assert.ok(receipt.bytes <= 10 * 1024 * 1024); assert.ok(fixtureOrigin.methods.every(method => method === 'GET'));
});
for (const [mode, expected] of [['unavailable', 78], ['unavailable asset', 78], ['timeout', 78], ['timeout asset', 78], ['contradiction', 1]]) test(`proof CLI rejects ${mode}`, async t => {
  const server = await fixture(t, mode);
  const result = await cli(['--origin', server.origin, '--timeout-ms', mode === 'timeout' ? '100' : mode === 'timeout asset' ? '2000' : '30000']);
  assert.equal(result.code, expected, result.stderr); assert.ok(server.methods.every(method => method === 'GET'));
});
test('proof CLI refuses invalid flags and origin', async () => {
  for (const args of [[], ['--origin', 'file:///tmp'], ['--origin', 'http://localhost/path'], ['--origin', 'http://localhost', '--timeout-ms', '30001']]) assert.equal((await cli(args)).code, 1);
});

test('proof closes a browser acquired after expiry without starting browser work', async t => {
  const server=await startFixture({routes:new Map([['/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)}),delayMs:200}]])});
  t.after(()=>server.close());
  let acquire, launchOptions, closed = false, browserWork = 0;
  const acquired = new Promise(resolve => { acquire = resolve; });
  const engine = { launch(options) { launchOptions = options; return acquired; } };
  const browser = { async close() { closed = true; }, async newContext() { browserWork++; throw Error('Expired proof started browser work'); } };
  await assert.rejects(runProof({ origin: server.origin, timeout: 600, engine }), /Proof deadline exceeded/);
  assert.ok(launchOptions, 'release completed before launch');
  acquire(browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true, 'late browser must be closed');
  assert.equal(browserWork, 0, 'expired proof must not create a context');
  assert.ok(launchOptions.timeout > 0 && launchOptions.timeout <= 400, 'launch uses only the shared deadline remaining after release retrieval');
});

for (const shift of [0, 100]) for (const stage of ['context', 'page']) test(`proof stops after expired ${stage} acquisition and closes its browser (clock shift ${shift}ms)`, async t => {
  const server = await fixture(t, 'passing');
  let resume, closed = false, subsequentWork = 0;
  const pending = new Promise(resolve => { resume = resolve; });
  const page = { setDefaultTimeout() { subsequentWork++; } };
  const context = { async newPage() { if (stage === 'context') subsequentWork++; return stage === 'page' ? pending : page; } };
  const engine = { async launch() { return { async close() { closed = true; }, async newContext() { return stage === 'context' ? pending : context; } }; } };
  const now = performance.now.bind(performance);
  let reads = 0;
  t.mock.method(performance, 'now', () => now() + (reads++ ? shift : 0));
  await assert.rejects(runProof({ origin: server.origin, timeout: 150, engine }), /Proof deadline exceeded/);
  assert.equal(closed, true);
  resume(stage === 'context' ? context : page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subsequentWork, 0, 'expired acquisition must not advance browser work');
});
