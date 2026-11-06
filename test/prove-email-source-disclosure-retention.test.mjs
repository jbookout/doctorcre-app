import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixtureServer } from './browser-harness.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-email-source-disclosure-retention.mjs';
const exec = promisify(execFile);

test('proof CLI working-tree pass and broken fixture', async t => {
  const outDir = temporaryDirectory('disclosure-proof-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir });
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const args = ['scripts/prove-email-source-disclosure-retention.mjs', '--origin', server.origin, '--timeout-ms', '30000', '--fixture'];
  const passed = await exec(process.execPath, args, { timeout: 40000 });
  const receipt = JSON.parse(passed.stdout);
  assert.equal(receipt.status, 'fixture_pass');
  assert.equal(receipt.deployed_asset_fixture.checks.length, 21);
  assert.equal(receipt.natural_authenticated_observation, 'not_executed');
  const asset = join(outDir, 'site/js/email-followups.js');
  const original = await readFile(asset);
  await writeFile(asset, 'export function mountEmailFollowups(){throw Error("Broken fixture behavior")}');
  await assert.rejects(exec(process.execPath, args, { timeout: 40000 }), error => {
    assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).status, 'failed'); return true;
  });
  await writeFile(asset, original);
  await assert.rejects(exec(process.execPath, args.map(value => value === '30000' ? '1' : value), { timeout: 10000 }), error => {
    assert.equal(error.code, 78); assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence'); return true;
  });
});

for (const mode of ['stalled evaluation', 'late launch']) test(`proof deadline closes owned browser after ${mode}`, async () => {
  let owned, evaluated = false;
  const engine = { async launch(options) {
    owned = await chromium.launch(options);
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 150));
    if (mode === 'late launch') return owned;
    const page = await owned.newPage();
    return { newPage: async () => ({ route: async () => {}, goto: async () => {}, evaluate: () => { evaluated = true; return new Promise(() => {}); } }),
      close: () => owned.close(), page };
  } };
  try {
    await assert.rejects(prove({ origin: 'http://127.0.0.1:1', fixture: true, timeoutMs: mode === 'stalled evaluation' ? 1000 : 100, engine }), error => {
      assert.ok(error.name === 'TimeoutError' || error.exitCode === 78); return true;
    });
    // The acquisition may settle after the caller's deadline; wait for its recorded browser to close.
    const deadline = Date.now() + 10000;
    while ((!owned || owned.isConnected()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (mode === 'stalled evaluation') assert.equal(evaluated, true);
    assert.ok(owned); assert.equal(owned.isConnected(), false, 'zero surviving owned browser connections');
  } finally { await owned?.close(); }
});
