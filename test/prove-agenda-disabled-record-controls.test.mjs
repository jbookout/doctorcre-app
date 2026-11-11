import { APP_RELEASE_PATH, readAppRelease } from '../scripts/app-release-reader.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
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
  const responses = new Map([...(mode === 'broken' ? broken : assets)].map(([path, body]) => ['/' + path, { body, contentType: 'text/javascript' }]));
  for (const [path, response] of responses) {
    if (mode === 'protected-asset' || mode === 'protected-chunk' && path.includes('ui-shared')) responses.set(path, { status: 403 });
    if (mode === 'missing-chunk' && path.includes('ui-shared')) responses.set(path, { status: 404 });
    if (mode === 'html-asset') responses.set(path, { contentType: 'text/html', body: '<h1>Sign in</h1>' });
    if (path === '/js/ui-agenda.generated.js') {
      if (mode === 'request-limit') responses.set(path, { ...response, body: Buffer.concat([Buffer.from('for(let i=0;i<100;i++) await import("./extra-"+i+".js");'), Buffer.from(response.body)]) });
      if (mode === 'write-attempt') responses.set(path, { ...response, body: Buffer.concat([Buffer.from('await fetch("/api/write", {method:"POST"}).catch(()=>{});'), Buffer.from(response.body)]) });
      if (mode === 'oversized') responses.set(path, { ...response, body: Buffer.alloc(5 * 1024 * 1024 + 1) });
    }
  }
  if (mode === 'request-limit') for (let i = 0; i < 100; i++) responses.set(`/js/extra-${i}.js`, { contentType: 'text/javascript', body: 'export {};' });
  const release = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: mode === 'missing-identity' ? undefined : 'a'.repeat(40), CF_VERSION_METADATA: { id: 'synthetic-provider-version' } });
  responses.set(APP_RELEASE_PATH, mode === 'protected-release' ? { status: 302, headers: { location: '/auth/login' } } : { contentType: 'application/json', body: mode === 'invalid-identity' ? 'null' : await release.text() });
  if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get requests() { return server.requests.map(req => ({ url: req.target, method: req.method })); } };
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
  const f = await fixture(t), origin = f.origin;
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
  const requests = f.requests;
  assert.ok(requests.every(request => request.method === 'GET' && (request.url === APP_RELEASE_PATH || request.url.startsWith('/js/'))));
});

for (const [mode, code] of [['broken', 1], ['protected-release', 78], ['missing-identity', 78], ['invalid-identity', 78], ['protected-asset', 78], ['protected-chunk', 78], ['html-asset', 78], ['missing-chunk', 1], ['write-attempt', 1], ['oversized', 1], ['request-limit', 1], ['timeout', 78]]) {
  test('CLI refuses ' + mode, async t => {
    const f = await fixture(t, mode), origin = f.origin;
    const result = await run(origin, mode === 'timeout' ? 100 : 30000);
    assert.equal(result.code, code, result.receipt.error);
    assert.equal(result.receipt.ok, false);
    const requests = f.requests;
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


test('fixture POST injection makes the agenda GET-only observation fail', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/write', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.throws(() => assert.ok(f.requests.every(request => request.method === 'GET')));
});
