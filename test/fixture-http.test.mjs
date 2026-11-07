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


test('explicit response headers preserve negative cache-policy scenarios', async t => {
  const fixture = await startFixture({ routes: new Map([['/manifest', {
    body: '{}', contentType: 'application/json', headers: { 'cache-control': 'public' },
  }]]) });
  t.after(() => fixture.close());
  const response = await raw(fixture.origin, '/manifest');
  assert.equal(response.headers['cache-control'], 'public');
  assert.equal(response.body, '{}');
});

test('fixed Worker seam routes POST through the real router and serves a copied asset snapshot', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  const assets = new Map([['/workspace.html', { body: 'admitted shell', contentType: 'text/html' }]]);
  const calls = [];
  const fixture = await startWorkerFixture({ assets, env: { CARR: { fetch: async request => {
    calls.push({path:new URL(request.url).pathname, method:request.method, body:request.method === 'POST' ? await request.text() : ''});
    return Response.json({ result: 'synthetic producer response' });
  } } } });
  t.after(() => fixture.close());
  assets.get('/workspace.html').body = 'changed after listen';
  assert.equal(await (await fetch(fixture.origin + '/?mode=live')).text(), 'admitted shell');
  const response = await fetch(fixture.origin + '/mcp', { method: 'POST', body: '{"method":"tools/call"}', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, 'synthetic producer response');
  assert.ok(calls.some(row => row.path === '/mcp' && row.method === 'POST' && row.body.includes('tools/call')));
  const before = calls.length;
  assert.equal((await raw(fixture.origin, '/..%2fprivate')).status, 400);
  assert.equal(calls.length, before);
  assert.equal((await fetch(fixture.origin + '/js/unlisted.js')).status, 404);
  await assert.rejects(startWorkerFixture({ assets, env: { ASSETS: { fetch() {} } } }), /Unknown fixture field/);
  await assert.rejects(startWorkerFixture({ listener() {} }), /Unknown fixture field/);
});

test('Worker seam bounds request bodies, preserves cookies and cancels pending bindings on close', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  let reads = 0, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const fixture = await startWorkerFixture({ limits: { body: 32 }, env: { CARR: { fetch: request => {
    reads++;
    if (new URL(request.url).pathname === '/auth/session') return new Response('{}', { headers: [
      ['set-cookie', 'one=1; Path=/'], ['set-cookie', 'two=2; Path=/'],
    ] });
    entered();
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  } } } });
  t.after(() => fixture.close());
  const oversized = await fetch(fixture.origin + '/mcp', { method: 'POST', body: 'x'.repeat(33) });
  assert.equal(oversized.status, 413);
  assert.equal(reads, 0);
  const session = await fetch(fixture.origin + '/auth/session');
  assert.deepEqual(session.headers.getSetCookie(), ['one=1; Path=/', 'two=2; Path=/']);
  const request = fetch(fixture.origin + '/mcp', { method: 'POST', body: '{}' });
  const refused = assert.rejects(request);
  await pending;
  await fixture.close();
  await refused;
  await fixture.close();
});

test('Worker seam refuses response streams beyond its body budget and executable asset scenarios', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  await assert.rejects(startWorkerFixture({assets:new Map([['/a.js',{body:'x',hold:'ignored'}]])}), /Unknown fixture field/);
  await assert.rejects(startWorkerFixture({assets:new Map([['/a.js',{sequence:[{body:'x'}]}]])}), /Unknown fixture field/);
  const fixture = await startWorkerFixture({limits:{body:4},env:{CARR:{fetch:async () => new Response('too long')}}});
  t.after(() => fixture.close());
  assert.equal((await fetch(fixture.origin + '/mcp',{method:'POST',body:'{}'})).status,502);
});

test('Worker route overrides are copied GET descriptors while POST still crosses the real router', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  const routes = new Map([['/mcp',{body:'finite document',contentType:'text/html'}]]);
  const fixture = await startWorkerFixture({routes,env:{CARR:{fetch:async () => Response.json({producer:true})}}});
  t.after(() => fixture.close());
  routes.clear();
  assert.equal(await (await fetch(fixture.origin + '/mcp')).text(),'finite document');
  assert.deepEqual(await (await fetch(fixture.origin + '/mcp',{method:'POST',body:'{}'})).json(),{producer:true});
});

test('Worker integration can bind the explicit loopback port its companion contract requires', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  const reserved = await startFixture();
  const port = Number(new URL(reserved.origin).port);
  await reserved.close();
  const fixture = await startWorkerFixture({port});
  t.after(() => fixture.close());
  assert.equal(Number(new URL(fixture.origin).port),port);
  await assert.rejects(startWorkerFixture({port:-1}),/port/);
  await assert.rejects(startFixture({port}),/Unknown fixture field/);
});

test('demo profile preserves outage controls without replacing the Worker asset router', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  const fixture = await startWorkerFixture({demo:true,assets:new Map([['/workspace.html',{body:'demo shell',contentType:'text/html'}]]),
    env:{APP_ENV:'fixture',GIT_SHA:'0'.repeat(40),CARR:{fetch:async () => new Response(null)}}});
  t.after(() => fixture.close());
  assert.equal(await (await fetch(fixture.origin + '/')).text(),'demo shell');
  const release = await fetch(fixture.origin + '/app-release');
  assert.equal((await release.json()).environment,'fixture');
  const outage = await fetch(fixture.origin + '/app-release?outage=release');
  assert.equal(outage.status,503);
  assert.equal(outage.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(fixture.origin + '/api/v1/work-inventory')).status,200);
  assert.equal((await fetch(fixture.origin + '/api/v1/atlas-graph')).status,200);
});

test('Worker admits encoded identifiers only through declared application routes', async t => {
  const { startWorkerFixture } = await import('../scripts/fixture-http.mjs');
  const fixture = await startWorkerFixture({assets:new Map([['/inbox.html',{body:'admitted inbox',contentType:'text/html'}]]),
    env:{CARR:{fetch:async () => new Response(null)}}});
  t.after(() => fixture.close());
  assert.equal(await (await fetch(fixture.origin + '/inbox/card/next_action%3At1')).text(),'admitted inbox');
  for (const path of ['/js/module%3Aprivate.js','/inbox/card/%2e%2e','/inbox/card/next%2Faction','/inbox/card/next%252Faction','/inbox/card/next%5caction','/inbox/card/%00','/inbox/card/%zz'])
    assert.equal((await raw(fixture.origin,path)).status,400,path);
  const proof = await startFixture();
  t.after(() => proof.close());
  assert.equal((await raw(proof.origin,'/inbox/card/next_action%3At1')).status,400);
});


test('descriptor admission separates probes and diagnoses undeclared traffic without hiding real requests', async t => {
  const f = await fixture(t, { routes: new Map([['/failure', { status: 404 }]]) });
  const probe = await raw(f.origin, '/');
  assert.equal(probe.status, 404);
  assert.equal(probe.body, 'Undeclared fixture path: /');
  assert.deepEqual(f.requests, []);
  assert.equal((await raw(f.origin, '/asset.js?revision=1')).status, 200);
  assert.equal((await raw(f.origin, '/asset.js', 'HEAD')).status, 200);
  assert.equal((await raw(f.origin, '/failure')).status, 404);
  assert.equal((await raw(f.origin, '/asset.js', 'POST')).status, 405);
  assert.equal((await raw(f.origin, '/typo')).body, 'Undeclared fixture path: /typo');
  assert.deepEqual(f.requests.map(r => [r.method, r.target]), [
    ['GET', '/asset.js?revision=1'], ['HEAD', '/asset.js'], ['GET', '/failure'], ['POST', '/asset.js'],
  ]);
  assert.deepEqual(f.rejectedRequests.map(r => r.target), ['/', '/typo']);
  f.rejectedRequests.length = 0;
  assert.equal(f.rejectedRequests.length, 2);
});

test('declared root is real fixture traffic and rejected observations remain bounded', async t => {
  const f = await fixture(t, { routes: new Map([['/', { body: 'declared root' }]]), limits: { observations: 1 } });
  assert.equal((await raw(f.origin, '/')).body, 'declared root');
  await raw(f.origin, '/missing-one');
  await raw(f.origin, '/missing-two');
  assert.deepEqual(f.requests.map(r => r.path), ['/']);
  assert.deepEqual(f.rejectedRequests.map(r => r.path), ['/missing-one']);
});
