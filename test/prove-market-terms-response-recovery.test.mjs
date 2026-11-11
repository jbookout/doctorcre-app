import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
import { writeFile, mkdir } from 'node:fs/promises';

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prove-market-terms-response-recovery.mjs', ...args], {stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({code,stdout,stderr}));
  });
}

test('proof CLI help, bad arguments and exact declaration command against fixture', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin','bad'], ['--origin','https://example.com/path'], ['--origin','https://example.com','--timeout-ms','NaN']]) assert.notEqual((await cli(args)).code, 0);
  const routes = new Map(snapshot);
  routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'1'.repeat(40)})});
  const server = await startFixture({routes});
  try {
    const result = await cli(['--origin',server.origin,'--timeout-ms','30000']);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.origin, server.origin);
    assert.ok(receipt.loaded_module_urls.includes(`${server.origin}/js/ui-market.generated.js`));
    assert.equal(receipt.assertions.length, 5);
    await mkdir('out/test-artifacts/market-terms-recovery', { recursive: true });
    await writeFile('out/test-artifacts/market-terms-recovery/proof-receipt.json', result.stdout);
  } finally { await server.close(); }
});

test('proof CLI fails on missing export, unavailable identity, timeout and broken UI', async () => {
  for (const mode of ['export','release','timeout','assertion']) {
    const routes = new Map([['/app-release',{status:mode==='release'?503:200,contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)}),...(mode==='timeout'?{hold:'timeout'}:{})}],['/js/ui-market.generated.js',{contentType:'text/javascript',body:mode==='export'?'export const missing = true;':'export function mountMarketTerms() { return { dispose() {} }; }'}]]);
    const server = await startFixture({routes});
    try {
      const result = await cli(['--origin',server.origin,'--timeout-ms', mode === 'timeout' ? '1000' : '3000']);
      assert.notEqual(result.code, 0, mode);
      assert.match(result.stderr, mode === 'release' ? /Proof HTTP unavailable/ : mode === 'export' ? /Missing mountMarketTerms/ : /timeout|Timeout|unavailable/);
    } finally { await server.close(); }
  }
});
