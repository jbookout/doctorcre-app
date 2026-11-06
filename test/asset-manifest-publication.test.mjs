import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from './proof-fixture-server.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { buildArtifact, verifyArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = '1'.repeat(40);

test('the public manifest identifies the built commit and every deployed payload byte', async t => {
  const outDir = temporaryDirectory('doctorcre-public-manifest-', t);
  await buildArtifact({ root, outDir, commit });
  const bytes = await readFile(join(outDir, 'site/artifact-manifest.json'));
  assert.deepEqual(bytes, await readFile(join(outDir, 'doctorcre-app.manifest.json')));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 'doctorcre-static-artifact.v1');
  assert.equal(manifest.source_commit, commit);
  for (const file of manifest.files) {
    assert.ok(!file.path.endsWith('.map'), 'no source maps in the deployed inventory');
    const payload = await readFile(join(outDir, 'site', file.path));
    assert.equal(payload.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(payload).digest('hex'), file.sha256, file.path);
  }
  const response = await handleDoctorcreRequest(new Request('https://app.example/artifact-manifest.json'), {
    ASSETS: { fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/artifact-manifest.json');
      assert.equal(request.headers.get('cookie'), null);
      return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    } },
    CARR: { fetch() { throw new Error('public build metadata must not require CARR'); } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('manifest access is read-only and preserves HEAD, missing binding and missing file responses', async () => {
  const url = 'https://app.example/artifact-manifest.json';
  let calls = 0;
  const env = { ASSETS: { fetch: async request => {
    calls++;
    assert.equal(request.method, 'HEAD');
    return new Response(null, { status: 404 });
  } } };
  assert.equal((await handleDoctorcreRequest(new Request(url, { method: 'HEAD' }), env)).status, 404);
  assert.equal((await handleDoctorcreRequest(new Request(url, { method: 'POST' }), env)).status, 405);
  assert.equal(calls, 1);
  assert.equal((await handleDoctorcreRequest(new Request(url), {})).status, 503);
});


test('declared production proof follows built and renamed assets and refuses conflicting evidence', async t => {
  const outDir = temporaryDirectory('doctorcre-manifest-proof-', t);
  const built = await buildArtifact({ root, outDir, commit });
  const verified = await verifyArtifact(built.archive);
  assert.deepEqual(verified.manifest, built.manifest);
  const requirement = JSON.parse(await readFile(join(root, 'proofs/requirements/asset-manifest-publication.json')));
  assert.ok(requirement.assertions[0].predicate.includes('scripts/prove-asset-manifest-publication.mjs'));
  const payload = new Map(await Promise.all(built.manifest.files.map(async row => [row.path, await readFile(join(outDir, 'site', row.path))])));
  for (const mode of ['built', 'renamed', 'identity', 'corrupt', 'digest', 'missing', 'redirect', 'cache', 'unsafe', 'timeout']) await t.test(mode, async t => {
    const manifest = structuredClone(built.manifest), files = new Map(payload), seen = [];
    if (mode === 'renamed') for (const row of manifest.files.filter(row => row.path.startsWith('js/') && row.path.endsWith('.js'))) {
      const next = row.path.replace('js/', 'js/renamed-');
      files.set(next, files.get(row.path)); files.delete(row.path); row.path = next;
    }
    if (mode === 'identity') manifest.source_commit = '2'.repeat(40);
    if (mode === 'unsafe') manifest.files[0].path = '../private.js';
    const siteRoot = resolve(outDir, 'site');
    const server = createServer(async (req, res) => {
      seen.push({ method: req.method, path: req.url });
      let path;
      try { path = resolve(siteRoot, '.' + decodeURIComponent(req.url.split('?')[0])); } catch { res.writeHead(400); return res.end(); }
      if (!path.startsWith(siteRoot + sep)) { res.writeHead(403); return res.end(); }
      if (mode === 'timeout') return;
      const response = await handleDoctorcreRequest(new Request('https://app.example' + req.url), {
        GIT_SHA: commit, APP_ENV: 'production',
        ASSETS: { fetch: async request => {
          const name = new URL(request.url).pathname.slice(1);
          if (name === 'artifact-manifest.json') return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
          if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: '/business' } });
          const data = files.get(name);
          if (!data || mode === 'missing') return new Response(null, { status: 404 });
          const content = Buffer.from(data);
          if (mode === 'digest') content[0] ^= 1;
          return new Response(mode === 'corrupt' ? Buffer.from('corrupt') : content);
        } },
      });
      res.writeHead(response.status, mode === 'cache' ? { ...Object.fromEntries(response.headers), 'cache-control': 'public' } : Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const child = spawn(process.execPath, ['scripts/prove-asset-manifest-publication.mjs', '--origin', `http://127.0.0.1:${server.address().port}`, '--commit', commit, '--timeout-ms', mode === 'timeout' ? '100' : '30000'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, ['built', 'renamed'].includes(mode) ? 0 : mode === 'timeout' ? 78 : 1, stdout + stderr);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.status, code === 0 ? 'passed' : 'failed');
    if (!code) {
      assert.equal(receipt.assets.length, 2);
      assert.deepEqual(receipt.assets.map(row => row.path), manifest.files.map(row => row.path).filter(path => /^js\/.*\.js$/.test(path)).sort().slice(0, 2));
      assert.equal(receipt.release.source_commit, commit);
      assert.equal(seen.length, requirement.safety.max_requests);
    }
    assert.ok(seen.length <= requirement.safety.max_requests);
    assert.ok(seen.every(row => row.method === 'GET' && row.path !== '/business'));
    if (mode === 'built') assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/%2e%2e%2fprivate`)).status, 403);
  });
});
