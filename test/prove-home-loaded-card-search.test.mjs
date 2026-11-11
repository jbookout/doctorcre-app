import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-home-loaded-card-search.mjs';
const exec = promisify(execFile);
let outDir, manifest;
before(async () => { outDir = temporaryDirectory('loaded-proof-'); ({ manifest } = await buildArtifact({ root: process.cwd(), outDir })); });
after(async () => rm(outDir, { recursive: true, force: true }));
async function fixture(t, broken = false) {
  const root = resolve(outDir, 'site');
  const responses = await loadFixtureAssets({ root, manifest: new Map(manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
  responses.set('/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) });
  if (broken) responses.set('/js/ui-inbox.generated.js', { body: 'document.body.textContent="broken";', contentType: 'text/javascript' });
  const fixture = await startFixture({ routes: responses });
  t.after(() => fixture.close());
  return fixture.origin;
}
for (const broken of [false, true]) test(`proof CLI fixture ${broken ? 'failure' : 'pass remains insufficient natural evidence'}`, async t => {
  const origin = await fixture(t, broken);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-home-loaded-card-search.mjs', '--origin', origin, '--timeout-ms', '15000'], { timeout: 25000 }), code: 0 }; }
  catch (error) { result = error; }
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.code, broken ? 1 : 78, result.stdout + result.stderr);
  assert.equal(receipt.natural_acceptance, 'insufficient_evidence');
  if (!broken) { assert.equal(receipt.synthetic, true); assert.equal(receipt.assertions.length, 4); assert.ok(receipt.assets.length > 1); }
});
for (const late of [false, true]) test(`deadline closes owned browser during ${late ? 'late launch' : 'stalled evaluation'}`, async t => {
  const origin = await fixture(t);
  let browser;
  let acquired;
  const acquisition = new Promise(resolve => { acquired = resolve; });
  const engine = { launch: async options => {
    browser = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS] });
    acquired();
    if (late) await new Promise(resolve => setTimeout(resolve, 1500));
    return browser;
  } };
  let started;
  const evaluation = new Promise(resolve => { started = resolve; });
  const result = prove({ origin, timeoutMs: 1200, engine, observe: async page => { started(); await page.evaluate(() => new Promise(() => {})); } });
  await acquisition;
  if (!late) await evaluation;
  await assert.rejects(result, error => error.exitCode === 78);
  if (late) await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(browser.isConnected(), false, 'zero surviving browsers acquired by this proof');
});
