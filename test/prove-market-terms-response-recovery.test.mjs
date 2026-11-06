import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fixtureServer } from './browser-harness.mjs';

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
  const upstream = await fixtureServer();
  const proxy = createServer(async (req, res) => {
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) })); }
    const response = await fetch(upstream.origin + req.url);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || '' }); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const server = { origin: `http://127.0.0.1:${proxy.address().port}`, close: async () => { proxy.closeAllConnections(); proxy.close(); await upstream.close(); } };
  try {
    const result = await cli(['--origin',server.origin,'--timeout-ms','30000']);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.origin, server.origin);
    assert.ok(receipt.loaded_module_urls.includes(`${server.origin}/js/ui-market.js`));
    assert.equal(receipt.assertions.length, 5);
    await mkdir('out/test-artifacts/market-terms-recovery', { recursive: true });
    await writeFile('out/test-artifacts/market-terms-recovery/proof-receipt.json', result.stdout);
  } finally { await server.close(); }
});

test('proof CLI fails on missing export, unavailable identity, timeout and broken UI', async () => {
  for (const mode of ['export','release','timeout','assertion']) {
    const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
      if (mode === 'timeout') return;
      if (req.url === '/app-release') {
        res.writeHead(mode === 'release' ? 503 : 200, {'content-type':'application/json'});
        return res.end(JSON.stringify({service:'doctorcre-app', environment: 'production',source_commit:'a'.repeat(40)}));
      }
      res.writeHead(200, {'content-type':'text/javascript'});
      res.end(mode === 'export' ? 'export const missing = true;' : 'export function mountMarketTerms() { return { dispose() {} }; }');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await cli(['--origin',`http://127.0.0.1:${server.address().port}`,'--timeout-ms', mode === 'timeout' ? '1000' : '3000']);
      assert.notEqual(result.code, 0, mode);
      assert.match(result.stderr, mode === 'release' ? /Proof HTTP unavailable/ : mode === 'export' ? /Missing mountMarketTerms/ : /timeout|Timeout|unavailable/);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
