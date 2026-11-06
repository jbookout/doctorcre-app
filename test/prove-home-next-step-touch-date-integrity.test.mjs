import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve, sep } from 'node:path';
import worker from '../src/worker.js';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { options } from '../scripts/prove-home-next-step-touch-date-integrity.mjs';
const runner = 'scripts/prove-home-next-step-touch-date-integrity.mjs';
const cli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runner, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
});
test('CLI contract rejects unsafe origins and invalid flags', async () => {
  for (const args of [[], ['--origin', 'http://example.com'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', '30001'], ['--origin', 'https://example.com', '--unknown']]) assert.throws(() => options(args));
  const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /78 unavailable/);
});
test('exact proof CLI passes deployed bytes, contradicts merge-base, and refuses unavailable or changing release', async t => {
  const fixture = await startFixtureServer(); t.after(() => fixture.stop());
  const original = execFileSync('git', ['show', '043e4b4f:src/ui/home/missing-next-step.tsx'], { encoding: 'utf8' });
  const old = (await build({ stdin: { contents: original, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' })).outputFiles[0].text;
  let mode = 'pass', reads = 0, assetReads = 0;
  const server = createServer(async (req, res) => {
    let decoded;
    try { decoded = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    const resolved = resolve(process.cwd(), `.${decoded}`);
    if (!resolved.startsWith(process.cwd() + sep)) { res.writeHead(403); return res.end(); }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/app-release') {
      reads++;
      if (mode === 'timeout') return;
      if (mode === 'unavailable') { res.writeHead(503); return res.end(); }
      const response = await worker.fetch(new Request('https://synthetic.invalid/app-release'), {
        APP_ENV: mode === 'wrong-environment' ? 'staging' : 'production',
        GIT_SHA: (mode === 'changed' && reads > 1 ? 'b' : 'a').repeat(40),
      });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') });
      return res.end(await response.text());
    }
    assetReads++;
    if (mode === 'asset-unavailable') { res.writeHead(404); return res.end(); }
    if (mode === 'original') { res.setHeader('content-type', 'text/javascript'); return res.end(old); }
    if (mode === 'foreign') { res.setHeader('content-type', 'text/javascript'); return res.end('import "https://example.com/foreign.js";'); }
    if (mode === 'cap') { res.setHeader('content-type', 'text/javascript'); return res.end(Array.from({ length: 21 }, (_, i) => `import "./ui-shared-A${i}.generated.js";`).join('\n')); }
    const upstream = await fetch(`${fixture.url}${path}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const args = ['--origin', `http://127.0.0.1:${server.address().port}`, '--timeout-ms', '30000'];
  for (const [value, expected] of [['pass', 0], ['original', 1], ['changed', 1], ['unavailable', 78], ['wrong-environment', 78], ['asset-unavailable', 78], ['foreign', 78], ['cap', 78]]) {
    mode = value; reads = 0; assetReads = 0;
    const result = await cli(args);
    assert.equal(result.code, expected, `${mode}: ${result.stdout} ${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.ok(assetReads <= 20);
    if (value === 'pass') {
      assert.equal(reads, 2); assert.ok(receipt.assets.length >= 1);
      assert.ok(receipt.assertions.length >= 30); assert.ok(receipt.assertions.every(a => a.passed));
      for (const asset of receipt.assets) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    }
    console.log(JSON.stringify({ mode, exit: result.code, assertion: receipt.assertions?.at(-1), assets: assetReads }));
  }
  mode = 'timeout';
  const timeout = await cli(args); assert.equal(timeout.code, 78, timeout.stdout);
  console.log(JSON.stringify({ mode, exit: timeout.code, receipt: JSON.parse(timeout.stdout) }));
});
