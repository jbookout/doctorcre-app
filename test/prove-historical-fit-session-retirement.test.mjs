import { uiAssets } from '../scripts/ui-bundle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startFixture } from '../scripts/fixture-http.mjs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { options, responseFixture } from '../scripts/prove-historical-fit-session-retirement.mjs';
const runner = 'scripts/prove-historical-fit-session-retirement.mjs';
const declaration = JSON.parse(await readFile('proofs/requirements/historical-fit-session-retirement.json', 'utf8'));
const root = resolve('.');
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args]); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
test('declared command and assertions match CLI and registered response contract', async () => {
  const command = `node ${runner} --origin https://app.doctorcre.com --timeout-ms 30000`;
  assert.ok(declaration.assertions[0].predicate.includes(command));
  assert.deepEqual(options(command.split(' ').slice(2)), { origin: 'https://app.doctorcre.com', timeout: 30000 });
  assert.equal(declaration.safety.max_requests, 31);
  assert.equal(declaration.safety.max_runtime_seconds, 30);
  assert.equal((await responseFixture()).profiles.length, declaration.safety.max_records);
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /78/);
  for (const args of [[], ['--origin', 'http://example.com'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '30001'], ['--origin', 'https://example.com', '--unknown', '1']]) assert.throws(() => options(args));
});
test('exact CLI flags prove fetched head and reject recoverable invalidation; unavailable and timeout exit 78', async t => {
  const source = await readFile('src/ui/ideal-client-profile.tsx', 'utf8');
  const listener = "addEventListener('doctorcre-session-invalidated', retire)";
  assert.ok(source.includes(listener), 'mutation must replace the session retirement listener');
  const recoverableInvalidation = source.replace(listener, "addEventListener('doctorcre-session-invalidated', clear)");
  const bundled = await build({ stdin: { contents: recoverableInvalidation, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  const assets = await uiAssets(path => readFile(path));
  async function snapshot(mode) {
    const responses = new Map([...assets].map(([path, body]) => ['/' + path, mode === 'missing-asset' ? { status: 404 } : { body, contentType: 'text/javascript' }]));
    if (mode === 'contradiction') responses.set('/js/ui-ideal-client-profile.generated.js', { body: bundled.outputFiles[0].text, contentType: 'text/javascript' });
    responses.set('/app-release', mode === 'unavailable' ? { status: 503 } : { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', source_commit: '1'.repeat(40), environment: mode === 'staging' ? 'staging' : 'production' }), ...(mode === 'timeout' ? { hold: 'timeout' } : {}) });
    const server = await startFixture({ routes: responses }); t.after(() => server.close()); return server;
  }
  for (const [scenario, expected] of [['staging', 78], ['pass', 0], ['contradiction', 1], ['unavailable', 78], ['missing-asset', 78], ['timeout', 78]]) {
    const server = await snapshot(scenario);
    const args = ['--origin', server.origin, '--timeout-ms', '30000'];
    const result = await cli(args);
    const requests = server.requests.map(req => req.target);
    await server.close();
    assert.equal(result.code, expected, `${scenario}: ${result.stderr}`);
    if (scenario === 'staging') assert.deepEqual(requests, ['/app-release'], 'refuse nonproduction release before acquiring assets');
    if (scenario === 'contradiction') assert.match(result.stderr, /idle removes private rows and controls/);
    if (scenario === 'pass') {
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.assertions.length, 8); assert.equal(receipt.release.service, 'doctorcre-app');
      assert.ok(receipt.assets.some(asset => asset.path === '/js/ui-ideal-client-profile.generated.js'));
      assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
      assert.ok(receipt.assets.length <= 30); assert.ok(receipt.bytes <= 10 * 1024 * 1024);
      for (const state of ['idle', 'loading', 'ready', 'error', 'clear', 'pagehide', 'dispose']) assert.ok(receipt.assertions.some(value => value.startsWith(state + ':')), state);
    }
    console.log(JSON.stringify({ scenario, exit: result.code, output: result.stdout.trim(), error: result.stderr.trim() }));
  }
});
