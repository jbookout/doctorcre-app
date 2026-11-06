import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(path, 'utf8'));
const exec = promisify(execFile);
async function run(t, mode, timeout = '30000', fixture = false) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'timeout') return;
    if (req.url === '/app-release') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(mode === 'release-missing' ? '{}' : JSON.stringify({ service: 'doctorcre-app', source_commit: 'a'.repeat(40), environment: 'production' }));
    }
    let bytes = assets.get(req.url.slice(1));
    if (mode === 'unavailable' || (mode === 'chunk-missing' && req.url.includes('ui-shared-'))) bytes = undefined;
    if (mode === 'missing-selector' && req.url === '/js/ui-territory-evidence.js') bytes = Buffer.from('export function mountTerritoryEvidence(host){host.innerHTML="<details><table><tbody></tbody></table></details>"; return {dispose(){host.replaceChildren()}}}');
    if (mode === 'contradiction' && req.url === '/js/ui-territory-evidence.js') bytes = Buffer.from('export function mountTerritoryEvidence(){throw new Error("Synthetic contradiction")}');
    if (mode === 'foreign-import' && req.url === '/js/ui-territory-evidence.js') bytes = Buffer.from('import "https://foreign.invalid/a.js";');
    res.writeHead(bytes ? 200 : 404, { 'Content-Type': 'text/javascript' }); res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = ['scripts/prove-territory-evidence-current-history-view.mjs', '--origin', origin, '--timeout-ms', timeout];
  if (fixture) args.push('--fixture');
  try { const result = await exec(process.execPath, args, { timeout: 35000 }); return { code: 0, receipt: JSON.parse(result.stdout) }; }
  catch (error) { return { code: error.code, receipt: JSON.parse(error.stdout) }; }
}
test('proof CLI passes module fixtures but refuses natural acceptance', async t => {
  const result = await run(t, 'success');
  assert.equal(result.code, 78, JSON.stringify(result.receipt));
  assert.equal(result.receipt.natural.status, 'insufficient_evidence');
  assert.equal(result.receipt.scope, 'deployed_module_fixture');
  assert.equal(result.receipt.release.source_commit, 'a'.repeat(40));
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
  const server = createServer((req, res) => {
    if (req.url === '/app-release') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)}));
    }
    const bytes = assets.get(req.url.slice(1));
    res.writeHead(bytes ? 200 : 404, {'content-type':'text/javascript'}); res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let owned, acquired;
  const acquisition = new Promise(resolve => acquired = resolve);
  const engine = { launch: async options => {
    owned = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    acquired();
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1400));
    return owned;
  } };
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(prove({origin, timeoutMs:1200, engine,
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
