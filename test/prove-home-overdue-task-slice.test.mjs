import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-home-overdue-task-slice.mjs';
const exec = promisify(execFile);
let out, manifest;
before(async () => { out = temporaryDirectory('overdue-cli-'); ({ manifest } = await buildArtifact({ root: process.cwd(), outDir: out })); });
after(async () => rm(out, { recursive: true, force: true }));
async function fixture(t, mode = 'pass') {
  const root = resolve(out, 'site');
  const responses = await loadFixtureAssets({ root, manifest: new Map(manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
  if (mode === 'fail') for (const [path, response] of responses) responses.set(path, { ...response, body: response.body.toString().replaceAll('"Overdue"', '"Broken overdue"') });
  responses.set('/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return server.origin;
}
for (const mode of ['pass', 'fail']) test(`proof CLI ${mode} through production v5 parser`, async t => {
  const origin = await fixture(t, mode);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-home-overdue-task-slice.mjs', '--origin', origin], { timeout: 40000 }), code: 0 }; }
  catch (error) { result = error; }
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.code, mode === 'pass' ? 78 : 1, result.stdout + result.stderr);
  assert.equal(receipt.ok, mode === 'pass');
  assert.equal(receipt.natural_acceptance.status, 'insufficient_evidence');
  if (mode === 'pass') { assert.equal(receipt.deployed_asset_fixture.status, 'passed'); assert.ok(receipt.assets.length > 1); }
});
for (const mode of ['late launch', 'stalled evaluation']) test(`proof closes acquired browser after ${mode}`, async t => {
  const origin = await fixture(t);
  let acquired, pending;
  const engine = { launch: () => {
    pending = (async () => {
      acquired = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
      return mode === 'late launch' ? acquired : new Proxy(acquired, { get(target, key) {
        if (key === 'newContext') return () => new Promise(() => {});
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    })();
    return pending;
  } };
  t.after(async () => { await pending; await acquired?.close(); });
  await assert.rejects(prove({ origin, timeoutMs: 1000, engine }), error => error.exitCode === 78);
  await pending;
  if (acquired.isConnected()) await new Promise(resolve => acquired.once('disconnected', resolve));
  assert.equal(acquired.isConnected(), false, 'owned real browser closed, including late acquisition');
});
