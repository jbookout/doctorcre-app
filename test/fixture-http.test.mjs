import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';

function raw(origin, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}
const asset = (body, contentType = 'text/javascript') => ({ body: Buffer.from(body), contentType });
async function fixture(t, options = {}) {
  const f = await startFixture({ assets: new Map([['/asset.js', asset('EXACT')]]), ...options });
  t.after(() => f.close());
  return f;
}

test('snapshot copies map and bytes before listening; GET and HEAD preserve MIME', async t => {
  const bytes = Buffer.from('EXACT');
  const assets = new Map([['/asset.js', { body: bytes, contentType: 'text/javascript' }]]);
  const f = await fixture(t, { assets });
  bytes.fill(0); assets.clear();
  const response = await raw(f.origin, '/asset.js?cache=1');
  assert.equal(response.body, 'EXACT');
  assert.equal(response.headers['content-type'], 'text/javascript');
  assert.equal(response.headers['cache-control'], 'no-store');
  const head = await raw(f.origin, '/asset.js', 'HEAD');
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '5');
  assert.equal((await raw(f.origin, '/missing.js')).status, 404);
  assert.equal((await raw(f.origin, '/asset.js', 'POST')).status, 405);
});

test('literal raw request targets never yield unlisted bytes', async t => {
  const f = await fixture(t);
  for (const path of ['/../asset.js', '/a/../asset.js', '/%2e%2e/asset.js', '/%252e%252e/asset.js', '/a%2fasset.js', '/a%5casset.js', '/%zz', '/%00', 'http://outside.invalid/asset.js', '//asset.js', '/a\\asset.js']) {
    const response = await raw(f.origin, path);
    assert.equal(response.status, 400, path);
    assert.notEqual(response.body, 'EXACT', path);
  }
  assert.equal((await raw(f.origin, '/asset.js-sibling')).status, 404);
});

test('release reader marker cannot be bypassed with a query', async t => {
  const f = await fixture(t, { routes: new Map([['/app-release', { body: 'release', contentType: 'application/json' }]]) });
  for (const path of ['/app-release', '/app-release?probe=1']) {
    assert.equal((await raw(f.origin, path)).status, 403);
    assert.equal((await raw(f.origin, path, 'GET', { 'x-doctorcre-release-reader': '1' })).body, 'release');
  }
});

test('descriptor sequences, delay and hold are finite and close destroys held requests', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal, routes: new Map([
    ['/sequence', { sequence: [{ status: 503, body: 'unavailable' }, { body: 'healthy' }] }],
    ['/delay', { delayMs: 5, body: 'later' }],
    ['/hold', { hold: 'gate', body: 'released' }],
  ]) });
  assert.equal((await raw(f.origin, '/sequence')).status, 503);
  assert.equal((await raw(f.origin, '/sequence')).body, 'healthy');
  assert.equal((await raw(f.origin, '/sequence')).body, 'healthy');
  assert.equal((await raw(f.origin, '/delay')).body, 'later');
  const held = raw(f.origin, '/hold');
  while (!f.requests.some(r => r.path === '/hold')) await new Promise(resolve => setImmediate(resolve));
  f.release('gate');
  assert.equal((await held).body, 'released');
  const abandoned = raw(f.origin, '/hold');
  const refused = assert.rejects(abandoned);
  while (f.requests.filter(r => r.path === '/hold').length < 2) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await refused;
  await f.close(); await f.close();
  await assert.rejects(raw(f.origin, '/asset.js'));
});

test('setup rejects executable descriptors, invalid keys, budgets and already aborted acquisition', async () => {
  for (const options of [
    { listener() {} }, { assets: () => new Map() }, { fallback() {} },
    { assets: new Map([['/../secret', asset('x')]]) },
    { assets: new Map([['/x', asset('x')]]), limits: { bytes: 0 } },
    { routes: new Map([['/x', { body: () => 'x' }]]) },
    { routes: new Map([['/x', { delayMs: Infinity }]]) },
    { limits: { unknown: 1 } },
    { routes: new Map([['/x', { sequence: [{}, {}] }]]), limits: { entries: 1 } },
    { routes: new Map([['/x', { headers: { 'bad\nname': 'value' } }]]) },
    { routes: new Map([['/x', { contentType: 'bad\nvalue' }]]) },
    { signal: AbortSignal.abort(Error('expired')) },
  ]) await assert.rejects(startFixture(options));
});

test('ten fixtures have isolated ephemeral ports, byte maps, observations and close', async t => {
  const fixtures = await Promise.all(Array.from({ length: 10 }, (_, n) => fixture(t, { assets: new Map([['/x', asset(String(n))]]) })));
  assert.equal(new Set(fixtures.map(f => f.origin)).size, 10);
  await fixtures[0].close();
  for (let n = 1; n < fixtures.length; n++) assert.equal((await raw(fixtures[n].origin, '/x')).body, String(n));
  assert.equal(fixtures[0].requests.length, 0);
});

test('manifest preload rejects symlinks and directories; no request rereads disk', async t => {
  const root = temporaryDirectory('fixture-assets-', t);
  await writeFile(root + '/admitted.js', 'ADMITTED');
  await writeFile(root + '/private.js', 'PRIVATE');
  await symlink(root + '/private.js', root + '/link.js');
  await mkdir(root + '/directory');
  await symlink(root, root + '/alias');
  for (const path of ['link.js', 'directory', '../outside.js', 'alias/admitted.js']) {
    await assert.rejects(loadFixtureAssets({ root, manifest: new Map([['/x', path]]) }), undefined, path);
  }
  const assets = await loadFixtureAssets({ root, manifest: new Map([['/asset.js', 'admitted.js']]) });
  const f = await fixture(t, { assets });
  await rm(root + '/admitted.js');
  assert.equal((await raw(f.origin, '/asset.js')).body, 'ADMITTED');
  assert.equal((await raw(f.origin, '/private.js')).status, 404);
});

test('request budgets refuse excess traffic and bound observations', async t => {
  const f = await fixture(t, { limits: { requests: 2, observations: 1 } });
  assert.equal((await raw(f.origin, '/asset.js')).status, 200);
  assert.equal((await raw(f.origin, '/asset.js')).status, 200);
  assert.equal((await raw(f.origin, '/asset.js')).status, 429);
  assert.equal(f.requests.length, 1);
});

test('aborting acquisition closes an asynchronously pending listener', async () => {
  const controller = new AbortController();
  const pending = startFixture({ signal: controller.signal });
  controller.abort(Error('setup deadline'));
  await assert.rejects(pending, /setup deadline|aborted/);
});

test('close cancels delayed response timers and idle held responses expire', async t => {
  const f = await fixture(t, { limits: { delayMs: 1000 }, routes: new Map([
    ['/delay', { delayMs: 1000, body: 'too late' }], ['/hold', { hold: 'never' }],
  ]) });
  const delayed = assert.rejects(raw(f.origin, '/delay'));
  while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
  await f.close();
  await delayed;
  const bounded = await fixture(t, { limits: { delayMs: 10 }, routes: new Map([['/hold', { hold: 'never' }]]) });
  await assert.rejects(raw(bounded.origin, '/hold'));
});

test('snapshot loader refuses oversized files before starting a fixture', async t => {
  const root = temporaryDirectory('fixture-assets-budget-', t);
  await writeFile(root + '/large.js', '12345');
  await assert.rejects(loadFixtureAssets({ root, manifest: new Map([['/large.js', 'large.js']]), limits: { bytes: 4 } }), RangeError);
});
