import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
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
  let mode = 'pass';
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      requests.push(req.url);
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
      if (pathname === '/app-release') {
        if (mode === 'timeout') return;
        if (mode === 'unavailable') { res.writeHead(503); return res.end(); }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ service: 'doctorcre-app', source_commit: '1'.repeat(40), environment: 'synthetic-proof-test' }));
      }
      if (mode === 'missing-asset') { res.writeHead(404); return res.end(); }
      if (!/^\/js\/(ui-ideal-client-profile\.js|ui-shared-[A-Z0-9]+\.generated\.js)$/.test(pathname)) { res.writeHead(403); return res.end(); }
      res.setHeader('content-type', 'text/javascript');
      return res.end(mode === 'contradiction' && pathname === '/js/ui-ideal-client-profile.js' ? bundled.outputFiles[0].text : await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = ['--origin', origin, '--timeout-ms', '30000'];
  for (const [scenario, expected] of [['pass', 0], ['contradiction', 1], ['unavailable', 78], ['missing-asset', 78], ['timeout', 78]]) {
    mode = scenario; requests.length = 0;
    const result = await cli(args);
    assert.equal(result.code, expected, `${scenario}: ${result.stderr}`);
    if (scenario === 'contradiction') assert.match(result.stderr, /idle removes private rows and controls/);
    if (scenario === 'pass') {
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.assertions.length, 8); assert.equal(receipt.release.service, 'doctorcre-app');
      assert.ok(receipt.assets.some(asset => asset.path === '/js/ui-ideal-client-profile.js'));
      assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
      assert.ok(receipt.assets.length <= 30); assert.ok(receipt.bytes <= 10 * 1024 * 1024);
      for (const state of ['idle', 'loading', 'ready', 'error', 'clear', 'pagehide', 'dispose']) assert.ok(receipt.assertions.some(value => value.startsWith(state + ':')), state);
    }
    console.log(JSON.stringify({ scenario, exit: result.code, output: result.stdout.trim(), error: result.stderr.trim() }));
  }
});
