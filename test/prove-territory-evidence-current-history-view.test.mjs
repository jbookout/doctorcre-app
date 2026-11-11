import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(path, 'utf8'));
const exec = promisify(execFile);
async function run(t, mode, timeout = '30000', fixture = false) {
  const history = temporaryDirectory('territory-proof-history-', t);
  const git = async (...args) => (await exec('git', args, { cwd: history })).stdout.trim();
  await git('init');
  const record = async value => {
    await writeFile(join(history, 'revision.txt'), value);
    await git('add', 'revision.txt');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', value);
    return git('rev-parse', 'HEAD');
  };
  const older = await record('older'), required = await record('required'), descendant = await record('descendant');
  await git('checkout', '--orphan', 'unrelated');
  const unrelated = await record('unrelated');
  const commit = mode === 'unknown-expected' ? 'f'.repeat(40) : required;
  const released = mode === 'older' ? older : mode === 'unrelated' ? unrelated : mode === 'unknown' ? 'f'.repeat(40) : ['descendant', 'ancestry-slow'].includes(mode) ? descendant : required;
  const slowBin = join(history, 'bin'), slowPid = join(history, 'git.pid');
  if (mode === 'ancestry-slow') {
    await mkdir(slowBin);
    await writeFile(join(slowBin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(slowPid)}, String(process.pid));
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  }
  const routes = new Map();
  for (const [path, bytes] of assets) {
    if (mode !== 'unavailable' && !(mode === 'chunk-missing' && path.includes('ui-shared-')))
      routes.set('/' + path, { body: bytes, contentType: 'text/javascript' });
  }
  for (const [scenario, body] of [
    ['missing-selector', 'export function mountTerritoryEvidence(host){host.innerHTML="<details><table><tbody></tbody></table></details>"; return {dispose(){host.replaceChildren()}}}'],
    ['contradiction', 'export function mountTerritoryEvidence(){throw new Error("Synthetic contradiction")}'],
    ['foreign-import', 'import "https://foreign.invalid/a.js";'],
  ]) if (mode === scenario) routes.set('/js/ui-territory-evidence.generated.js', { body, contentType: 'text/javascript' });
  const response = await handleDoctorcreRequest(new Request('http://fixture.test/app-release'), { GIT_SHA: released, APP_ENV: 'production' });
  routes.set('/app-release', { body: mode === 'release-missing' ? '{}' : Buffer.from(await response.arrayBuffer()), contentType: 'application/json',
    ...(mode === 'ancestry-slow' ? { delayMs: 700 } : {}), ...(mode === 'timeout' ? { hold: 'timeout' } : {}) });
  const server = await startFixture({ routes });
  t.after(() => server.close());
  const origin = server.origin;
  const args = [fileURLToPath(new URL('../scripts/prove-territory-evidence-current-history-view.mjs', import.meta.url)), '--origin', origin, '--commit', commit, '--timeout-ms', timeout];
  if (fixture) args.push('--fixture');
  const started = performance.now();
  let result;
  try { const child = await exec(process.execPath, args, { cwd: history, timeout: 35000, env: { ...process.env, ...(mode === 'ancestry-slow' ? { PATH: slowBin + ':' + process.env.PATH } : {}) } }); result = { code: 0, receipt: JSON.parse(child.stdout) }; }
  catch (error) { result = { code: error.code, receipt: JSON.parse(error.stdout) }; }
  if (mode === 'ancestry-slow') {
    assert.ok(performance.now() - started < 2200, 'ancestry shares the 1200 ms total deadline');
    assert.deepEqual(server.requests.map(request => request.path), ['/app-release'], 'expired ancestry cannot download assets or launch a browser');
    const pid = Number(await readFile(slowPid, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  if (result.code === 0) assert.equal(result.receipt.release.source_commit, released);
  return result;
}
test('proof CLI passes module fixtures but refuses natural acceptance', async t => {
  const result = await run(t, 'success');
  assert.equal(result.code, 78, JSON.stringify(result.receipt));
  assert.equal(result.receipt.natural.status, 'insufficient_evidence');
  assert.equal(result.receipt.scope, 'deployed_module_fixture');
  assert.ok(result.receipt.assets.length > 2 && result.receipt.assets.length <= 20);
  assert.ok(result.receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(result.receipt.assertions.length > 30);
});
test('proof CLI exits 1 for a deployed contradiction', async t => {
  const result = await run(t, 'contradiction');
  assert.equal(result.code, 1); assert.match(JSON.stringify(result.receipt), /Synthetic contradiction/);
});
for (const mode of ['release-missing', 'unavailable', 'chunk-missing', 'foreign-import']) test(`proof CLI exits 78 for ${mode}`, async t => {
  assert.equal((await run(t, mode)).code, 78);
});
test('proof CLI bounds total timeout', async t => {
  const result = await run(t, 'timeout', '100');
  assert.equal(result.code, 78); assert.match(JSON.stringify(result.receipt), /timeout/);
});


test('proof rejects a missing evidence selector', async t => {
  const result = await run(t, 'missing-selector');
  assert.equal(result.code, 1);
});

import { prove } from '../scripts/prove-territory-evidence-current-history-view.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
for (const mode of ['stalled evaluation', 'late launch']) test(`deadline closes owned browser after ${mode}`, async t => {
  const routes = new Map([...assets].map(([path, body]) => ['/' + path, { body, contentType: 'text/javascript' }]));
  routes.set('/app-release', { contentType: 'application/json', body: JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)}) });
  const server = await startFixture({ routes });
  t.after(() => server.close());
  let owned, acquired;
  const acquisition = new Promise(resolve => acquired = resolve);
  const engine = { launch: async options => {
    owned = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    acquired();
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1400));
    return owned;
  } };
  const origin = server.origin;
  try {
    await assert.rejects(prove({origin, commit:'a'.repeat(40), timeoutMs:1200, engine,
      exercise: mode === 'stalled evaluation' ? () => new Promise(() => {}) : undefined}), error => error.exitCode === 78);
    await acquisition;
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(owned.isConnected(), false, 'zero connected browsers owned by the run');
  } finally { await owned?.close(); }
});

import { createHash } from 'node:crypto';
test('recording hashes pin the registered producer and synthetic query provenance', async () => {
  const root = new URL('./fixtures/territory-evidence-current-history-view/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  for (const [file, hash] of [['producer.txt', provenance.producer_sha256], ['recordings.json', provenance.recordings_sha256]]) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), hash);
  }
  const producer = JSON.parse(await readFile(new URL('producer.txt', root)));
  assert.equal(createHash('sha256').update(producer.files['lead-follow-up.ts']).digest('hex'), provenance.source_sha256);
  assert.deepEqual(producer.query_inputs, provenance.query_inputs);
  assert.equal(producer.queries.length, 1);
  assert.match(producer.queries[0].query, /f.found and not f.expired/);
});

test('recorded responses agree with the app production response contract', async () => {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/mcp_read_contracts/territory-state-board.json', import.meta.url)));
  const { territoryResponse } = await import('../scripts/prove-territory-evidence-current-history-view.mjs');
  assert.equal(territoryResponse.schema_version, contract.schema_version);
  assert.equal(territoryResponse.coverage, contract.coverage);
  assert.ok(territoryResponse.submarkets.length <= contract.limit);
  for (const area of territoryResponse.submarkets) {
    assert.ok(contract.conditions.includes(area.condition));
    for (const e of area.evidence) {
      assert.ok(contract.submarkets.evidence.condition.split('|').includes(e.condition));
      assert.equal(typeof e.current, 'boolean');assert.equal(typeof e.expired, 'boolean');
      assert.equal(typeof e.flag_id, 'string');assert.ok(e.source);
    }
  }
});

test('explicit loopback fixture replay exits zero', async t => {
  const result = await run(t, 'success', '30000', true);
  assert.equal(result.code, 0);
  assert.equal(result.receipt.natural.status, 'insufficient_evidence');
});

for (const [mode, code] of [['descendant', 0], ['success', 0], ['older', 78], ['unrelated', 78], ['unknown', 78], ['unknown-expected', 78], ['release-missing', 78], ['contradiction', 1], ['ancestry-slow', 78]]) {
  test(`release containment CLI ${mode} exits ${code}`, async t => {
    const result = await run(t, mode, mode === 'ancestry-slow' ? '1200' : '30000', true);
    assert.equal(result.code, code, JSON.stringify(result.receipt));
    if (['older', 'unrelated'].includes(mode)) assert.match(JSON.stringify(result.receipt), /release commit mismatch/);
    if (['unknown', 'unknown-expected'].includes(mode)) assert.match(JSON.stringify(result.receipt), /ancestry evidence unavailable/);
    if (code === 0) assert.equal(result.receipt.assertions.length, 53);
  });
}
