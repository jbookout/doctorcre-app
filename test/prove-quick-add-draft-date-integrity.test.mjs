import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = 'scripts/prove-quick-add-draft-date-integrity.mjs';

test('proof CLI help and invalid arguments fail closed', async () => {
  assert.match((await exec(process.execPath, [script, '--help'])).stdout, /--origin/);
  for (const args of [[], ['--origin', 'bad'], ['--origin', 'ftp://example.com'], ['--origin', 'http://127.0.0.1:1', '--timeout-ms', '0']]) {
    await assert.rejects(exec(process.execPath, [script, ...args]));
  }
});

test('proof declaration command runs deployed module assertions against fixture', async t => {
  const routes = new Map(snapshot);
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)})});
  const server = await startFixture({routes});
  t.after(()=>server.close());
  const { stdout } = await exec(process.execPath, [script, '--origin', server.origin, '--timeout-ms', '30000']);
  await writeFile('/tmp/WR617.S18.J1-proof-receipt.json', stdout);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.origin, server.origin);
  assert.equal(receipt.assertions.length, 3);
  assert.ok(receipt.loaded_module_urls.includes(`${server.origin}/js/local-drafts.mjs`));
  await assert.rejects(exec(process.execPath, [script, '--origin', server.origin, '--timeout-ms', '1']));
});

for (const failure of ['release', 'export', 'assertion']) test(`proof fails closed for ${failure}`, async t => {
  const routes = new Map([['/app-release',{contentType:'application/json',body:JSON.stringify(failure==='release'?{}:{service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)})}],['/js/local-drafts.mjs',{contentType:'text/javascript',body:failure==='export'?'export const missing = true;':'export function createLocalDrafts() { return { save: () => ({}) }; }'}]]);
  const server = await startFixture({routes});
  t.after(() => server.close());
  await assert.rejects(exec(process.execPath, [script, '--origin', server.origin, '--timeout-ms', '30000']), error => {
    assert.match(error.stderr, /Missing app release identity|Missing createLocalDrafts export|Impossible new date accepted/);
    return true;
  });
});
