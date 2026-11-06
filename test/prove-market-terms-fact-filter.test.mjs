import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { fixtureServer } from './browser-harness.mjs';
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
async function server(handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${http.address().port}`,close:async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }};
}
const release = {service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)};

test('CLI working-tree fixture passes; broken deployed asset fails; natural proof remains insufficient', async () => {
  const upstream = await fixtureServer();
  let broken = false;
  const proxy = await server(async (req,res) => {
    if (req.url === '/app-release') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify(release)); }
    if (broken) { res.setHeader('content-type','text/javascript'); return res.end('export const missing = true;'); }
    const response = await fetch(upstream.origin + req.url);
    res.writeHead(response.status,{'content-type':response.headers.get('content-type') || ''}); res.end(Buffer.from(await response.arrayBuffer()));
  });
  try {
    const pass = await cli(proxy.origin);
    assert.equal(pass.code,0,pass.stderr);
    const receipt = JSON.parse(pass.stdout);
    assert.equal(receipt.production_acceptance,false);
    assert.equal(receipt.deployed_asset_fixture.assertions.reads,6);
    broken = true;
    const fail = await cli(proxy.origin);
    assert.equal(fail.code,1,fail.stderr);
    await assert.rejects(prove({origin:proxy.origin}), error => error.exitCode === 78 && /insufficient_evidence/.test(error.message));
  } finally { await proxy.close(); await upstream.close(); }
});

for (const mode of ['late launch', 'stalled evaluation']) test(`real CLI closes owned Chromium after ${mode}`, async t => {
  const fixture = await server((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(release)); });
  try {
    await assertProofDeadlineCleanup(t, {
      entry: 'scripts/prove-market-terms-fact-filter.mjs',
      args: ['--origin', fixture.origin, '--fixture'], mode,
    });
  } finally { await fixture.close(); }
});
