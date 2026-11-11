import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { handleDoctorcreRequest } from '../src/worker.js';

const snapshot = await proofAssetSnapshot();
async function fixture(t, mode) {
  const responses = new Map(snapshot);
  if (mode === 'budget') for (let n = -1; n < 20; n++) responses.set(n === -1 ? '/js/ui-inbox.generated.js' : `/js/budget-${n}.js`,
    { contentType: 'text/javascript', body: `import './budget-${n + 1}.js';` });
  if (mode === 'unavailable') for (const path of responses.keys()) responses.set(path, { status: 404 });
  if (mode === 'broken' || mode === 'network') responses.set('/js/ui-inbox.generated.js', { contentType: 'text/javascript',
    body: mode === 'broken' ? 'throw Error("contradictory fixture")' : 'await fetch("/api/business", {method:"POST"})' });
  const identity = async sha => ({ contentType: 'application/json', body: mode === 'identity' ? '{}' : await (await handleDoctorcreRequest(
    new Request('https://app.doctorcre.com/app-release'), { APP_ENV: 'production', GIT_SHA: sha.repeat(40) })).text() });
  responses.set('/app-release', { sequence: [await identity('1'), await identity(mode === 'changed' ? '2' : '1')] });
  if (mode === 'timeout') responses.set('/app-release', { contentType: 'application/json', hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests.map(req => ({ method: req.method, path: req.target })); } };
}
async function cli(origin, flags = []) {
  const child = spawn(process.execPath, ['scripts/prove-home-fact-review-refresh-selection.mjs', '--origin', origin, '--timeout-ms', '30000', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('proof CLI boots deployed entry, checks fresh requests, empty evidence and reload failure', async t => {
  const f = await fixture(t, 'pass');
  const { code, receipt } = await cli(f.origin);
  console.log(JSON.stringify({ mode: 'pass', code, receipt }));
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.release.source_commit, '1'.repeat(40));
  assert.equal(receipt.business_network_writes, 0);
  assert.ok(receipt.assertions.some(a => a.startsWith('replaced: request contains')));
  assert.ok(receipt.assertions.some(a => a.startsWith('empty: request contains')));
  assert.ok(receipt.assertions.some(a => a.startsWith('reload-failure:')));
  assert.ok(receipt.assets.length > 1 && receipt.assets.length <= 20);
  assert.ok(receipt.assets.every(a => /^[a-f0-9]{64}$/.test(a.sha256)));
  assert.ok(f.seen.every(r => r.method === 'GET' && (r.path === '/app-release' || r.path.startsWith('/js/'))), JSON.stringify(f.seen));
});
for (const [mode, expected] of [['budget', 1], ['broken', 1], ['network', 1], ['changed', 1], ['identity', 78], ['unavailable', 78], ['timeout', 78]]) {
  test(`proof CLI refuses ${mode} with identical production flags`, { timeout: 40000 }, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin);
    console.log(JSON.stringify({ mode, code, receipt }));
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    if (mode === 'budget') { assert.match(receipt.error, /Asset request budget/); assert.equal(f.seen.filter(r => r.path.startsWith('/js/')).length, 20); }
    assert.ok(f.seen.every(r => r.method === 'GET'));
  });
}
test('proof CLI rejects unknown flags', async t => {
  const f = await fixture(t, 'pass');
  assert.equal((await cli(f.origin, ['--retry'])).code, 1);
  assert.equal(f.seen.length, 0);
});
