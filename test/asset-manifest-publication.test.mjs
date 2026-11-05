import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildArtifact } from '../scripts/artifact.mjs';
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
