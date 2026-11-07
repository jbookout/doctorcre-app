import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { resolverFixture, checkResolverFixture } from '../scripts/prove-call-review-decision-replay-key.mjs';
const script = 'scripts/prove-call-review-decision-replay-key.mjs';
function cli(origin, timeout = 30000) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, '--origin', origin, '--timeout-ms', String(timeout)]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
  });
}
test('exact proof CLI executes manifest-selected bytes and rejects invalid evidence', async t => {
  const root = resolve('.');
  const assets = await uiAssets(path => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new Error('Outside fixture root');
    return readFile(file, 'utf8');
  });
  for (const dir of ['js']) for (const name of await readdir(resolve(root, dir))) {
    if (/\.(js|mjs)$/.test(name) && !assets.has(dir + '/' + name)) assets.set(dir + '/' + name, await readFile(resolve(root, dir, name)));
  }
  let mode = 'valid', requests = 0, writes = 0;
  const release = { service: 'doctorcre-app', source_commit: 'a'.repeat(40) };
  const server = createServer((req, res) => {
    requests++; if (req.method !== 'GET') writes++;
    if (mode === 'timeout') return;
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (path === '/app-release') return res.end(JSON.stringify(mode === 'release' ? {} : release));
    const selected = new Map(assets);
    if (mode === 'adapter-hash') selected.set('js/live-client.js', Buffer.from('export function createLiveClient() {}'));
    if (mode === 'assertion') selected.set('js/ui-call.js', Buffer.from('export function mountCallReview() { return { refresh: async () => {}, dispose() {} }; }'));
    if (path === '/artifact-manifest.json') return res.end(JSON.stringify(mode === 'manifest' ? {} : {
      schema: 'doctorcre-static-artifact.v1', source_commit: release.source_commit,
      files: [...selected].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
    }));
    if (mode === 'missing') { res.writeHead(404); return res.end(); }
    const bytes = selected.get(path.slice(1));
    if (!bytes) { res.writeHead(404); return res.end(); }
    res.end(mode === 'hash' ? 'wrong asset' : bytes);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await cli(origin);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.release.source_commit, release.source_commit);
  assert.equal(receipt.assertions.length, 8);
  for (const resolver of ['resolve-candidate', 'resolve-post-call-candidate']) {
    assert.ok(receipt.assertions.includes(resolver + ':http-uncertainty-blocks-new-decisions'));
    assert.ok(receipt.assertions.includes(resolver + ':exact-original-decision-replay'));
  }
  assert.ok(receipt.assets['/js/ui-call.js']); assert.ok(requests <= 10);
  for (const [failure, code] of [['manifest', 1], ['adapter-hash', 1], ['hash', 1], ['assertion', 1], ['missing', 78], ['release', 78], ['timeout', 78]]) {
    mode = failure; requests = 0;
    const failed = await cli(origin, failure === 'timeout' ? 100 : 30000);
    assert.equal(failed.code, code, failure + ': ' + failed.stderr); assert.ok(requests <= 10);
  }
  assert.equal(writes, 0);
});

test('recorded resolver receipts reject fabricated or incompatible payloads', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  for (const accept of [true, false]) {
    assert.deepEqual(checkResolverFixture(resolverFixture(id, accept), id, accept), resolverFixture(id, accept));
    for (const payload of [{ ok: true }, {}, { ...resolverFixture(id, accept), candidate_id: 'wrong' }, resolverFixture(id, !accept)]) {
      assert.throws(() => checkResolverFixture(payload, id, accept), /Incompatible/);
    }
  }
});
