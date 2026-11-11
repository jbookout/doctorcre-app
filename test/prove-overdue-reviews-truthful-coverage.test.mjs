import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
const script = 'scripts/prove-overdue-reviews-truthful-coverage.mjs';
const cli = args => new Promise((done, reject) => {
  const child = spawn(process.execPath, [script, ...args]); let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
});
test('declared CLI verifies deployed bytes and refuses contradictions or unavailable evidence', async t => {
  const outDir = temporaryDirectory('coverage-proof-', t);
  const built = await buildArtifact({ root: process.cwd(), outDir });
  const root = resolve(outDir, 'site');
  const snapshot=await loadFixtureAssets({root,manifest:new Map(built.manifest.files.filter(row=>row.path.startsWith('js/')).map(row=>['/'+row.path,row.path]))});
  const wrong = 'export function mountDealUpdateReviews() { return { refresh: async () => {}, dispose() {} }; }';
  const servers=[];
  async function prepare(mode) {
    await servers.at(-1)?.close();
    const routes=new Map(snapshot),manifest=structuredClone(built.manifest);
    if(mode==='release')manifest.source_commit='f'.repeat(40);
    if(mode==='assertion') {
      const entry=manifest.files.find(f=>f.path==='js/ui-deal-reviews.generated.js');
      entry.bytes=Buffer.byteLength(wrong);entry.sha256=createHash('sha256').update(wrong).digest('hex');
    }
    routes.set('/artifact-manifest.json',{contentType:'application/json',body:mode==='manifest'?'{}':JSON.stringify(manifest)});
    routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:built.manifest.source_commit}),...(mode==='timeout'?{hold:'timeout'}:{})});
    if(mode==='asset'||mode==='assertion')routes.set('/js/ui-deal-reviews.generated.js',{contentType:'text/javascript',body:mode==='asset'?'export const wrong = true;':wrong});
    const server=await startFixture({routes});servers.push(server);return server.origin;
  }
  t.after(()=>Promise.all(servers.map(server=>server.close())));
  const origin=await prepare('valid');
  const declaration = JSON.parse(await readFile('proofs/requirements/overdue-reviews-truthful-coverage.json'));
  const args = declaration.assertions[0].predicate.match(/`([^`]+)`/)[1].split(' ').slice(2);
  args[args.indexOf('--origin') + 1] = origin;
  const passed = await cli(args); assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  const receipt = JSON.parse(passed.stdout); assert.ok(receipt.assertions.length > 20);
  assert.deepEqual([...new Set(receipt.assertions.map(a => a.width))], [390, 1440]);
  assert.ok(receipt.assets.length > 0); assert.ok(servers[0].requests.length <= 10);
  for (const [failure, code] of [['manifest', 78], ['release', 78], ['asset', 1], ['assertion', 1], ['timeout', 78]]) {
    const origin=await prepare(failure);
    const failed = await cli(['--origin', origin, '--timeout-ms', failure === 'timeout' ? '100' : '30000']);
    assert.equal(failed.code, code, failure + failed.stdout + failed.stderr);
  }
  assert.ok(servers.every(server=>server.requests.every(req=>req.method==='GET')));
});
test('CLI rejects invalid origin and deadline', async () => {
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '0']]) assert.equal((await cli(args)).code, 1);
});
