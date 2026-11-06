import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { readFileSync } from 'node:fs';
const runner = 'scripts/prove-quick-switcher-partial-read.mjs';
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
test('help and malformed arguments', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [[], ['--origin', 'invalid'], ['--origin', 'file:///tmp'], ['--origin', 'http://localhost/path'], ['--origin', 'http://localhost', '--timeout-ms', '0']]) assert.notEqual((await cli(args)).code, 0);
});
test('declared runner command proves served fixture module', async t => {
  const upstream = await startFixtureServer();
  t.after(upstream.stop);
  const proxy = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) })); }
    const response = await fetch(upstream.url + req.url);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || '' }); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const server = { url: `http://127.0.0.1:${proxy.address().port}`, stop: () => { proxy.closeAllConnections(); proxy.close(); } };
  try {
    const plan = JSON.parse(readFileSync('proofs/requirements/quick-switcher-partial-read.json', 'utf8'));
    assert.ok(plan.assertions[0].predicate.includes(`node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`));
    const result = await cli(['--origin', server.url, '--timeout-ms', '30000']);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.release.service, 'doctorcre-app');
    assert.equal(receipt.assertions.length, 4);
    assert.ok(receipt.module_urls.includes(`${server.url}/js/ui-quick-switcher.js`));
    assert.ok(receipt.requests <= 64);
  } finally { await server.stop(); }
});
for (const mode of ['missing export', 'failed assertion', 'unavailable release', 'timeout']) test(`runner refuses ${mode}`, async () => {
  const methods = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    methods.push(request.method);
    if (mode === 'timeout') return;
    response.setHeader('Content-Type', request.url === '/app-release' ? 'application/json' : 'text/javascript');
    if (request.url === '/app-release') return response.end(JSON.stringify(mode === 'unavailable release' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    response.end(mode === 'missing export' ? 'export const unrelated = 1;' : 'export function openQuickSwitcher() { throw Error("Fixture assertion failed"); }');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await cli(['--origin', `http://127.0.0.1:${server.address().port}`, '--timeout-ms', mode === 'timeout' ? '500' : '3000']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /failed|timeout/i);
    assert.ok(methods.every(method => method === 'GET'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
