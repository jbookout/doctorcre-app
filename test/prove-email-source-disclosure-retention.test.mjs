import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-email-source-disclosure-retention.mjs';
const exec = promisify(execFile);

test('proof CLI working-tree pass and broken fixture', async t => {
  const outDir = temporaryDirectory('disclosure-proof-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir });
  let server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const args = ['scripts/prove-email-source-disclosure-retention.mjs', '--origin', server.origin, '--timeout-ms', '30000', '--fixture'];
  const passed = await exec(process.execPath, args, { timeout: 40000 });
  const receipt = JSON.parse(passed.stdout);
  assert.equal(receipt.status, 'fixture_pass');
  assert.equal(receipt.deployed_asset_fixture.checks.length, 21);
  assert.equal(receipt.natural_authenticated_observation, 'not_executed');
  const asset = join(outDir, 'site/js/email-followups.js');
  const original = await readFile(asset);
  await writeFile(asset, 'export function mountEmailFollowups(){throw Error("Broken fixture behavior")}');
  await server.close();
  server = await fixtureServer({ root: join(outDir, 'site') });
  args[2] = server.origin;
  await assert.rejects(exec(process.execPath, args, { timeout: 40000 }), error => {
    assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).status, 'failed'); return true;
  });
  await server.close();
  await writeFile(asset, original);
  server = await fixtureServer({ root: join(outDir, 'site') });
  args[2] = server.origin;
  await assert.rejects(exec(process.execPath, args.map(value => value === '30000' ? '1' : value), { timeout: 10000 }), error => {
    assert.equal(error.code, 78); assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence'); return true;
  });
});

for (const mode of ['stalled evaluation', 'late launch', 'late launch with delayed process exit']) test(`proof deadline closes owned browser after ${mode}`, async t => {
  let owned, server, descendant, evaluated = false, release;
  let ownedPids = [];
  const delivery = new Promise(resolve => { release = resolve; });
  const engine = { async launch(options) {
    server = await chromium.launchServer({ ...options, args: [...CHROMIUM_SAFETY_ARGS], timeout: 10000 });
    owned = await chromium.connect(server.wsEndpoint());
    ownedPids = [server.process().pid];
    if (mode === 'late launch with delayed process exit') {
      descendant = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'ignore', 'ignore'] });
      ownedPids.push(descendant.pid);
    }
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=']);
    const processes = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    for (let index = 0; index < ownedPids.length; index++) {
      ownedPids.push(...processes.filter(([, parent]) => parent === ownedPids[index]).map(([pid]) => pid));
    }
    if (mode.startsWith('late launch')) await delivery;
    return {
      newPage: async () => ({ route: async () => {}, goto: async () => {}, evaluate: () => { evaluated = true; return new Promise(() => {}); } }),
      close: async () => {
        await server.close(); await owned.close();
        if (descendant) setTimeout(() => descendant.stdin.end(), 100);
      },
    };
  } };
  try {
    await assert.rejects(prove({ origin: 'http://127.0.0.1:1', fixture: true, timeoutMs: mode === 'stalled evaluation' ? 5000 : 100, engine }), error => {
      assert.equal(error.exitCode || (error.name === 'TimeoutError' ? 78 : 1), 78); return true;
    });
    release();
    const survivingPids = () => ownedPids.filter(pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    });
    const deadline = Date.now() + 15000;
    while ((!owned || owned.isConnected() || (server.process().exitCode === null && server.process().signalCode === null) || survivingPids().length > 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (mode === 'stalled evaluation') assert.equal(evaluated, true);
    assert.ok(owned, 'a real Chromium handle was acquired');
    assert.equal(owned.isConnected(), false);
    assert.ok(server.process().exitCode !== null || server.process().signalCode !== null, 'owned Chromium process exited');
    assert.deepEqual(survivingPids(), [], 'every recorded owned process exited before the cleanup bound');
    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    t.diagnostic(`${mode}: exit 78; zero surviving owned browser processes (PID ${server.process().pid})`);
  } finally { release(); descendant?.kill(); await owned?.close(); await server?.close(); }
});
