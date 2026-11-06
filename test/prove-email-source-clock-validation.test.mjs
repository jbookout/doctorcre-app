import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import worker from '../src/worker.js';
import { readAppRelease } from '../scripts/app-release-reader.mjs';

const root = resolve('.');
const source = await readFile('js/email-source-line.js');
const business = await readFile('js/business-date.js');
async function fixture(t, mode) {
  const seen = [], assets = new Map([[resolve(root, 'js/email-source-line.js'), source], [resolve(root, 'js/business-date.js'), business]]);
  if (mode === 'contradiction') assets.set(resolve(root, 'js/business-date.js'), Buffer.from(business.toString().replace('America/Chicago', 'UTC')));
  if (mode === 'foreign') assets.set(resolve(root, 'js/email-source-line.js'), Buffer.from('import "https://foreign.invalid/module.js";'));
  if (mode === 'cap') assets.set(resolve(root, 'js/email-source-line.js'), Buffer.from(Array.from({ length: 20 }, (_, i) => `import "./extra-${i}.js";`).join('\n')));
  let releaseReads = 0;
  const identity = async () => {
    const response = await worker.fetch(new Request('https://synthetic.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: (mode === 'changed' && ++releaseReads > 1 ? '2' : '1').repeat(40) });
    return response.json();
  };
  await readAppRelease('http://localhost', async () => ({ type: 'application/json', body: Buffer.from(JSON.stringify(await identity())) }));
  releaseReads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    seen.push([req.method, req.url]);
    if (mode === 'timeout') return;
    if (req.url === '/app-release') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(mode === 'identity' ? {} : await identity()));
    }
    let path;
    try { path = resolve(root, '.' + decodeURIComponent(req.url)); } catch { res.writeHead(400); return res.end(); }
    if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const bytes = assets.get(path);
    if (!bytes || mode === 'unavailable' || mode === 'auth') { res.writeHead(mode === 'auth' ? 401 : 404); return res.end(); }
    res.setHeader('content-type', mode === 'html' ? 'text/html' : 'text/javascript');
    res.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function cli(origin, flags = []) {
  const child = spawn(process.execPath, ['scripts/prove-email-source-clock-validation.mjs', '--origin', origin, '--timeout-ms', '30000', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('CLI executes exact deployed graph and emits identity hashes and named assertions', async t => {
  const f = await fixture(t);
  const { code, receipt } = await cli(f.origin);
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.service, 'doctorcre-app');
  assert.equal(receipt.environment, 'production');
  assert.equal(receipt.source_commit, '1'.repeat(40));
  assert.equal(receipt.status, 'passed');
  assert.ok(receipt.assertions.length > 50 && receipt.assertions.every(row => row.passed));
  assert.deepEqual(receipt.assets.map(row => row.sha256), [source, business].map(bytes => createHash('sha256').update(bytes).digest('hex')));
  assert.equal(receipt.requests, 4);
  assert.ok(f.seen.every(([method, path]) => method === 'GET' && ['/app-release', '/js/email-source-line.js', '/js/business-date.js'].includes(path)));
  console.log(JSON.stringify({ mode: 'pass', code, assertions: receipt.assertions.length, assets: receipt.assets }));
});
for (const [mode, expected] of [['contradiction', 1], ['identity', 78], ['unavailable', 78], ['auth', 78], ['html', 78], ['foreign', 78], ['cap', 78], ['changed', 1], ['timeout', 78]]) {
  test(`CLI refuses ${mode} with identical production flags`, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin);
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    assert.ok(f.seen.length <= 22);
    if (mode === 'contradiction') assert.ok(receipt.assertions.some(row => !row.passed && row.name.includes('absolute')));
    console.log(JSON.stringify({ mode, code, error: receipt.error, failed: receipt.assertions.filter(row => !row.passed) }));
  });
}
test('CLI rejects unsupported flags and invalid deadline', async t => {
  const f = await fixture(t);
  for (const flags of [['--unknown'], ['--timeout-ms', '30001']]) assert.equal((await cli(f.origin, flags)).code, 1);
  assert.equal(f.seen.length, 0);
});
