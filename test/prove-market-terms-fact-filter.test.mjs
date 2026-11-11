import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
import { prove } from '../scripts/prove-market-terms-fact-filter.mjs';

function cli(origin) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,['scripts/prove-market-terms-fact-filter.mjs','--origin',origin,'--timeout-ms','10000','--fixture'], {stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk; }); child.stderr.on('data',chunk => { stderr += chunk; });
    child.on('error',reject); child.on('close',code => resolve({code,stdout,stderr}));
  });
}
const release = {service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)};

test('CLI working-tree fixture passes; broken deployed asset fails; natural proof remains insufficient', async () => {
  const routes=new Map(snapshot);
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify(release)});
  let proxy=await startFixture({routes});
  try {
    const pass = await cli(proxy.origin);
    assert.equal(pass.code,0,pass.stderr);
    const receipt = JSON.parse(pass.stdout);
    assert.equal(receipt.production_acceptance,false);
    assert.equal(receipt.deployed_asset_fixture.assertions.reads,6);
    await proxy.close();
    routes.set('/js/ui-market.generated.js',{contentType:'text/javascript',body:'export const missing = true;'});
    proxy=await startFixture({routes});
    const fail = await cli(proxy.origin);
    assert.equal(fail.code,1,fail.stderr);
    await assert.rejects(prove({origin:proxy.origin}), error => error.exitCode === 78 && /insufficient_evidence/.test(error.message));
  } finally { await proxy.close(); }
});

for (const mode of ['late launch', 'stalled evaluation']) test(`real CLI closes owned Chromium after ${mode}`, async t => {
  const fixture = await startFixture({routes:new Map([['/app-release',{contentType:'application/json',body:JSON.stringify(release)}]])});
  try {
    await assertProofDeadlineCleanup(t, {
      entry: 'scripts/prove-market-terms-fact-filter.mjs',
      args: ['--origin', fixture.origin, '--fixture'], mode,
    });
  } finally { await fixture.close(); }
});
