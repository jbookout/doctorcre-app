import { APP_RELEASE_PATH, readAppRelease } from '../scripts/app-release-reader.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const exec = promisify(execFile);
const assets = await uiAssets(path => readFile(path));
const broken = await uiAssets(async path => {
  const bytes = await readFile(path);
  return path === 'src/ui/deal-room-agenda.tsx' ? bytes.toString().replaceAll('disabled={disabled}', '') : bytes;
});

async function fixture(t, mode = 'success') {
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    requests.push({ url: req.url, method: req.method });
    if (mode === 'timeout') return;
    if (req.url === APP_RELEASE_PATH) {
      if (mode === 'protected-release') { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      if (mode === 'invalid-identity') { res.end('null'); return; }
      const response = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: mode === 'missing-identity' ? undefined : 'a'.repeat(40), CF_VERSION_METADATA: { id: 'synthetic-provider-version' } });
      res.end(await response.text());
      return;
    }
    if (mode === 'protected-asset' || (mode === 'protected-chunk' && req.url.includes('ui-shared'))) { res.writeHead(403); res.end(); return; }
    if (mode === 'missing-chunk' && req.url.includes('ui-shared')) { res.writeHead(404); res.end(); return; }
    const bytes = req.url.startsWith('/js/extra-') ? Buffer.from('export {};') : (mode === 'broken' ? broken : assets).get(req.url.slice(1));
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/javascript');
    if (mode === 'html-asset') { res.setHeader('content-type', 'text/html'); res.end('<h1>Sign in</h1>'); return; }
    if (mode === 'request-limit' && req.url === '/js/ui-agenda.js') res.write('for(let i=0;i<100;i++) await import("./extra-"+i+".js");');
    if (mode === 'write-attempt' && req.url === '/js/ui-agenda.js') res.write('await fetch("/api/write", {method:"POST"}).catch(()=>{});');
    if (mode === 'oversized') res.end(Buffer.alloc(5 * 1024 * 1024 + 1));
    else res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: 'http://127.0.0.1:' + server.address().port, requests };
}

async function run(origin, timeout = 30000) {
  try {
    const result = await exec(process.execPath, ['scripts/prove-agenda-disabled-record-controls.mjs', '--origin', origin, '--timeout-ms', String(timeout)], { timeout: 40000 });
    return { code: 0, receipt: JSON.parse(result.stdout) };
  } catch (error) {
    assert.ok(error.stdout, error.message);
    return { code: error.code, receipt: JSON.parse(error.stdout) };
  }
}

test('CLI imports the real fixture bundle and chunks with production flags', async t => {
  const { origin, requests } = await fixture(t);
  const { code, receipt } = await run(origin);
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.origin, origin);
  assert.equal(receipt.release.source_commit, 'a'.repeat(40));
  assert.deepEqual(receipt.activations, { open: 6, step: 6 });
  assert.ok(receipt.assertions > 40);
  assert.ok(receipt.assets.some(asset => asset.url.includes('ui-shared')));
  for (const asset of receipt.assets) {
    assert.equal(asset.sha256, createHash('sha256').update(assets.get(new URL(asset.url).pathname.slice(1))).digest('hex'));
  }
  assert.ok(requests.every(request => request.method === 'GET' && (request.url === APP_RELEASE_PATH || request.url.startsWith('/js/'))));
});

for (const [mode, code] of [['broken', 1], ['protected-release', 78], ['missing-identity', 78], ['invalid-identity', 78], ['protected-asset', 78], ['protected-chunk', 78], ['html-asset', 78], ['missing-chunk', 1], ['write-attempt', 1], ['oversized', 1], ['request-limit', 1], ['timeout', 78]]) {
  test('CLI refuses ' + mode, async t => {
    const { origin, requests } = await fixture(t, mode);
    const result = await run(origin, mode === 'timeout' ? 100 : 30000);
    assert.equal(result.code, code, result.receipt.error);
    assert.equal(result.receipt.ok, false);
    assert.ok(requests.every(request => request.method === 'GET'));
    if (mode === 'write-attempt') assert.ok(requests.every(request => !request.url.startsWith('/api/')));
    if (mode === 'request-limit') assert.equal(requests.length, 65);
  });
}

test('shared release reader uses the real Worker route and response contract', async () => {
  const origin = 'https://fixture.invalid';
  const env = { APP_ENV: 'production', GIT_SHA: 'a'.repeat(40), CF_VERSION_METADATA: { id: 'synthetic-provider-version' } };
  const response = await handleDoctorcreRequest(new Request(new URL(APP_RELEASE_PATH, origin)), env);
  assert.equal(response.status, 200, 'proof release path must be served by the Worker');
  const body = Buffer.from(await response.text()), type = response.headers.get('content-type');
  const actual = JSON.parse(body);
  assert.deepEqual(await readAppRelease(origin, async url => {
    assert.equal(url.pathname, APP_RELEASE_PATH);
    return { body, type };
  }), actual);
  for (const value of [null, {}, { git_sha: env.GIT_SHA },
    { ...actual, service: 'carr' }, { ...actual, environment: 'staging' },
    { ...actual, source_commit: '0'.repeat(40) }, { ...actual, source_commit: 123 },
    { ...actual, source_commit: 'bad' }]) {
    await assert.rejects(readAppRelease(origin, async () => ({ body: Buffer.from(JSON.stringify(value)), type })), { exitCode: 78 });
  }
  for (const invalid of [{ body: Buffer.from('{'), type }, { body, type: 'text/html' }]) {
    await assert.rejects(readAppRelease(origin, async () => invalid), { exitCode: 78 });
  }
});
