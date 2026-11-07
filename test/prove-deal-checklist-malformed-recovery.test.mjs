import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const script = 'scripts/prove-deal-checklist-malformed-recovery.mjs';
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('proof CLI help and invalid arguments', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '0']]) {
    assert.notEqual((await cli(args)).code, 0);
  }
});

test('declaration command reaches real fixture assertions and refuses missing proof inputs', async t => {
  const servers = [];
  async function prepare(mode) {
    await servers.at(-1)?.close();
    const routes = new Map(snapshot);
    routes.set('/app-release',{contentType:'application/json',body:JSON.stringify(mode==='release'?{}:{service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)}),...(mode==='timeout'?{hold:'timeout'}:{})});
    if(mode==='export'||mode==='assertion')routes.set('/js/ui-checklist.js',{contentType:'text/javascript',body:mode==='export'?'export const wrong = true;':'export function mountDealChecklist() { return {update(){},dispose(){}}; }'});
    const server = await startFixture({routes});servers.push(server);return server.origin;
  }
  t.after(()=>Promise.all(servers.map(server=>server.close())));
  const origin = await prepare('valid');
  const declaration = JSON.parse(await readFile('proofs/requirements/deal-checklist-malformed-recovery.json'));
  const args = declaration.assertions[0].predicate.match(/`([^`]+)`/)[1].split(' ').slice(2);
  args[args.indexOf('--origin') + 1] = origin;
  const result = await cli(args);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.origin, origin);
  assert.equal(receipt.assertions.length, 3);
  assert.ok(receipt.loaded_module_urls.includes(`${origin}/js/ui-checklist.js`));
  for (const failure of ['release', 'export', 'assertion', 'timeout']) {
    const origin = await prepare(failure);
    const failed = await cli(['--origin', origin, '--timeout-ms', failure === 'timeout' ? '100' : '30000']);
    assert.notEqual(failed.code, 0, failure);
    assert.ok(failed.stderr.length, failure);
  }
  assert.ok(servers.every(server=>server.requests.every(req=>req.method==='GET')));
});
