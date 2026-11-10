import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import worker from '../src/worker.js';
import { readAppRelease } from '../scripts/app-release-reader.mjs';

const root = resolve('.');
const source = await readFile('js/email-source-line.js');
const business = await readFile('js/business-date.js');
async function fixture(t, mode) {
  const assets = new Map([[resolve(root, 'js/email-source-line.js'), source], [resolve(root, 'js/business-date.js'), business]]);
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
  const responses = new Map([...assets].map(([path, body]) => ['/' + path.slice(root.length + 1),
    mode === 'unavailable' || mode === 'auth' ? { status: mode === 'auth' ? 401 : 404 } : { body, contentType: mode === 'html' ? 'text/html' : 'text/javascript' }]));
  const first = { contentType: 'application/json', body: JSON.stringify(mode === 'identity' ? {} : await identity()) };
  const second = { contentType: 'application/json', body: JSON.stringify(mode === 'identity' ? {} : await identity()) };
  responses.set('/app-release', { sequence: [first, second] });
  if (mode === 'timeout') {
    for (const [path, response] of responses) if (path !== '/app-release') responses.set(path, { ...response, hold: 'timeout' });
    responses.set('/app-release', { ...first, hold: 'timeout' });
  }
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests.map(req => [req.method, req.target]); } };
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
