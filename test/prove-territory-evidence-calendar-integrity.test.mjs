import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(path, 'utf8'));
const disposalMutants = new Map();
for (const [mode, guard] of [
  ['loading-only-disposal', "view.kind !== 'loading'"],
  ['ready-disposal', "view.kind === 'ready'"],
  ['error-disposal', "view.kind === 'error'"],
]) {
  disposalMutants.set(mode, await uiAssets(async path => {
    const source = await readFile(path, 'utf8');
    return path === 'src/ui/territory-evidence.tsx'
      ? source.replace('dispose() { disposed = true;', `dispose() { if (${guard}) return; disposed = true;`)
      : source;
  }));
}
const exec = promisify(execFile);
async function run(t, mode, timeout = '30000') {
  const routes = new Map([...(disposalMutants.get(mode)||assets)].map(([key,body])=>['/'+key,
    mode==='unavailable'||mode==='chunk-missing'&&key.includes('ui-shared-')?{status:404}:{contentType:'text/javascript',body}]));
  if(mode==='contradiction'||mode==='foreign-import')routes.set('/js/ui-territory-evidence.generated.js',{contentType:'text/javascript',body:mode==='contradiction'?'export function mountTerritoryEvidence(){throw new Error("Synthetic contradiction")}':'import "https://foreign.invalid/a.js";'});
  routes.set('/app-release',{contentType:'application/json',body:mode==='release-missing'?'{}':JSON.stringify({service:'doctorcre-app',source_commit:'a'.repeat(40),environment:'production'}),...(mode==='timeout'?{hold:'timeout'}:{})});
  const server=await startFixture({routes});
  t.after(()=>server.close());
  const origin=server.origin;
  const args = ['scripts/prove-territory-evidence-calendar-integrity.mjs', '--origin', origin, '--timeout-ms', timeout];
  try { const result = await exec(process.execPath, args, { timeout: 35000 }); return { code: 0, receipt: JSON.parse(result.stdout) }; }
  catch (error) { return { code: error.code, receipt: JSON.parse(error.stdout) }; }
}
test('proof CLI executes fetched module closure with declared flags', async t => {
  const result = await run(t, 'success');
  assert.equal(result.code, 0, JSON.stringify(result.receipt));
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
  assert.equal(result.code, 1); assert.match(JSON.stringify(result.receipt), /timeout/);
});

for (const [mode, assertion] of [
  ['loading-only-disposal', 'ready disposal empties host'],
  ['ready-disposal', 'ready disposal empties host'],
  ['error-disposal', 'error disposal empties host'],
]) test(`proof CLI rejects ${mode} mutation`, async t => {
  const result = await run(t, mode);
  assert.equal(result.code, 1, 'proof must reject broken disposal');
  assert.ok(result.receipt.assertions[0].name.includes(assertion), JSON.stringify(result.receipt));
});
