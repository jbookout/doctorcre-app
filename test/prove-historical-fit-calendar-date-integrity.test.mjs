import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { options } from '../scripts/prove-historical-fit-calendar-date-integrity.mjs';

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runner = 'scripts/prove-historical-fit-calendar-date-integrity.mjs';
function cli(args, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, runner, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
test('CLI help documents every flag without contacting the origin', async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json'); requests++; res.writeHead(500); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guard = `data:text/javascript,${encodeURIComponent(`import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))}; chromium.launch = () => { throw Error('help attempted browser launch'); };`)}`;
  for (const args of [['--help'], ['--help', '--origin', origin]]) {
    const result = await cli(args, ['--import', guard]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const flag of ['--help', '--origin', '--timeout-ms', '--expected-revision']) assert.ok(result.stdout.includes(flag), flag);
    assert.match(result.stdout, /30000/);
    assert.equal(requests, 0, 'help must not run the proof');
  }
});
test('CLI refuses unsafe origin and invalid arguments', () => {
  for (const args of [[], ['--origin', 'http://example.com'], ['--origin', 'https://example.com/path'], ['--origin', 'https://example.com', '--timeout-ms', 'NaN'], ['--origin', 'https://example.com', '--expected-revision', 'main']]) {
    assert.throws(() => options(args));
  }
});
test('proof command uses served modules and fails closed on unavailable assets and releases', async t => {
  const fixture = await startFixtureServer(); t.after(() => fixture.stop());
  const root = resolve('.');
  const source = await readFile('src/ui/ideal-client-profile.tsx', 'utf8');
  const check = 'new Date(date).toISOString().slice(0, 10) !== closed_on';
  assert.ok(source.includes(check), 'mutation must remove the real calendar round-trip guard');
  const invalidDates = await build({ stdin: { contents: source.replace(check, 'false'), loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  let mode = 'valid';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!resolve(root, `.${pathname}`).startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (req.url === '/app-release') {
      if (mode === 'timeout') return;
      if (mode === 'protected-release') { res.writeHead(401); return res.end(); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: mode === 'stale' ? '0'.repeat(40) : revision }));
    }
    if (mode === 'accepts-impossible-date' && pathname === '/js/ui-ideal-client-profile.js') {
      res.setHeader('content-type', 'text/javascript'); return res.end(invalidDates.outputFiles[0].text);
    }
    if (mode === 'protected-module') { res.writeHead(403); return res.end(); }
    if (mode === 'missing-export') { res.setHeader('content-type', 'text/javascript'); return res.end('export const missing = true;'); }
    const upstream = await fetch(`${fixture.url}${req.url}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = ['--origin', origin, '--expected-revision', revision, '--timeout-ms', '30000'];
  const passed = await cli(args);
  assert.equal(passed.code, 0, passed.stderr);
  const receipt = JSON.parse(passed.stdout);
  assert.equal(receipt.origin, origin); assert.equal(receipt.release.source_commit, revision);
  assert.equal(receipt.assertions.length, 7);
  assert.ok(receipt.assertions.includes('invalidation terminally retires history')); assert.ok(receipt.module_urls.some(url => url.endsWith('/js/ui-ideal-client-profile.js')));
  mode = 'accepts-impossible-date';
  const contradiction = await cli([...args.slice(0, -1), '2000']);
  assert.equal(contradiction.code, 1, 'proof refuses renderer accepting February 31');
  assert.match(contradiction.stderr, /invalid evidence must not claim a completed win/);
  console.log(JSON.stringify({ scenario: mode, exit: contradiction.code, error: contradiction.stderr.trim() }));
  for (const failure of ['stale', 'protected-release', 'protected-module', 'missing-export', 'timeout']) {
    mode = failure;
    const result = await cli(failure === 'timeout' ? [...args.slice(0, -1), '200'] : args);
    assert.notEqual(result.code, 0, failure); assert.match(result.stderr, /Historical fit proof failed/);
  }
});
