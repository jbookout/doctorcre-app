import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_LIMIT, EDGE_LIMIT, REPEAT_MS, createErrorGate, installErrorTracking, scrubError } from '../js/error-tracking.js';
import { createDoctorcreRequestHandler } from '../src/worker.js';

const PII = /Alice|example|diagnosis|private|9876543|1234567/;
const piiError = () => {
  const error = new TypeError('Cannot read properties of Alice alice@example.test diagnosis');
  error.stack = 'TypeError: Alice record:9876543:1234567\n at Alice (https://app/js/client.js?email=alice@example.test:12:3)';
  return error;
};

function browserHost(fetch) {
  const listeners = new Map();
  return {
    location: { pathname: '/clients/Alice' }, fetch,
    addEventListener: (type, listener) => listeners.set(type, [...listeners.get(type) || [], listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) || []).filter(row => row !== listener)),
    dispatch: (type, event) => (listeners.get(type) || []).forEach(listener => listener(event)),
    listeners,
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('scrubbing keeps only allowlisted types, message templates, static routes and stack positions', () => {
  const error = piiError();
  assert.deepEqual(scrubError({ type: error.name, message: error.message, stack: error.stack,
    route: '/clients/Alice/deals?email=alice@example.test#private', release_sha: 'a'.repeat(40) }), {
    type: 'TypeError', message: 'Cannot read properties of [redacted]', stack: 'asset:12:3',
    route: '/clients/:value/deals', release_sha: 'a'.repeat(40) });
  assert.deepEqual(scrubError({ type: 'Alice', message: 'Alice alice@example.test', route: 'Alice', release_sha: 'Alice' }, 'UnhandledRejection'),
    { type: 'UnhandledRejection', message: '[redacted]', stack: '', route: '/:value', release_sha: null });
  assert.equal(scrubError({ type: 'ReferenceError', message: 'aliceRecord is not defined' }).message, '[redacted] is not defined');
  assert.equal(scrubError({ type: 'HTTP5xx', message: 'Alice' }).message, 'HTTP 5xx response');
  assert.equal(scrubError({ message: 'Failed to fetch' }).message, 'Failed to fetch');
  for (const hostile of [null, undefined, 'Alice', 7, { route: { toString: () => 'Alice' }, stack: ['Alice:1:2'] }])
    assert.doesNotMatch(JSON.stringify(scrubError(hostile)), PII);
});

test('browser listeners send scrubbed evidence and leave other handlers in place', async () => {
  const sent = [];
  const host = browserHost(async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; });
  let appSaw = 0;
  host.addEventListener('error', () => appSaw++);
  const stop = installErrorTracking(host, 'a'.repeat(40));
  host.addEventListener('unhandledrejection', () => appSaw++);
  host.dispatch('error', { error: piiError(), message: 'Alice', lineno: 12, colno: 3 });
  host.dispatch('unhandledrejection', { reason: 'Alice alice@example.test diagnosis' });
  host.dispatch('error', { error: null, message: 'Script error.', lineno: 0, colno: 0 });
  await settle();
  assert.equal(appSaw, 3);
  assert.deepEqual(sent.map(row => row.body), [
    { type: 'TypeError', message: 'Cannot read properties of [redacted]', stack: 'asset:12:3', route: '/clients/:value', release_sha: 'a'.repeat(40) },
    { type: 'UnhandledRejection', message: '[redacted]', stack: '', route: '/clients/:value', release_sha: 'a'.repeat(40) },
    { type: 'Error', message: 'Script error.', stack: 'asset:0:0', route: '/clients/:value', release_sha: 'a'.repeat(40) },
  ]);
  assert.ok(sent.every(row => row.url === '/api/v1/runtime-errors' && row.options.credentials === 'same-origin' && row.options.keepalive));
  assert.doesNotMatch(JSON.stringify(sent), PII);
  stop();
  assert.deepEqual([...host.listeners.values()].map(rows => rows.length), [1, 1]);
});

test('a hostile rejection, a throwing send and a re-entrant failure never escape the listener', async () => {
  const hostile = { get name() { throw new Error('Alice'); }, get message() { throw new Error('Alice'); } };
  const attempts = [];
  const host = browserHost((_url, options) => { attempts.push(JSON.parse(options.body)); throw new Error('Alice'); });
  installErrorTracking(host, null, createErrorGate({ limit: Infinity, repeatMs: 0 }));
  assert.doesNotThrow(() => host.dispatch('unhandledrejection', { reason: hostile }));
  assert.doesNotThrow(() => host.dispatch('unhandledrejection', { get reason() { throw new Error('Alice'); } }));
  assert.doesNotThrow(() => host.dispatch('error', { error: piiError() }));
  assert.deepEqual(attempts.map(row => [row.type, row.message, row.route]), [
    ['UnhandledRejection', '[redacted]', '/clients/:value'], ['UnhandledRejection', '[redacted]', '/clients/:value'],
    ['TypeError', 'Cannot read properties of [redacted]', '/clients/:value']], 'unreadable failures are still reported, without their fields');

  const sent = [];
  const reentrant = browserHost(() => { sent.push(1); reentrant.dispatch('error', { error: new RangeError('again') }); return Promise.reject(new Error('Alice')); });
  installErrorTracking(reentrant, null);
  reentrant.dispatch('error', { error: piiError() });
  await settle();
  assert.equal(sent.length, 1, 'a failure raised while reporting is not reported again');
});

test('a repeating browser error reaches CARR once per repeat window and a storm stays under the page limit', async () => {
  let clock = 0;
  const sent = [];
  const host = browserHost(async (_url, options) => sent.push(JSON.parse(options.body)));
  installErrorTracking(host, null, createErrorGate({ limit: BROWSER_LIMIT, now: () => clock }));
  for (let index = 0; index < 100; index++) host.dispatch('error', { error: piiError() });
  assert.equal(sent.length, 1);
  clock = REPEAT_MS;
  host.dispatch('error', { error: piiError() });
  assert.equal(sent.length, 2, 'a sustained error is re-sent after the repeat window so CARR can see a spike');
  for (let index = 0; index < 100; index++) host.dispatch('error', { error: Object.assign(new Error('x'), { stack: `at f (/js/a.js:${index}:1)` }) });
  assert.equal(sent.length, BROWSER_LIMIT, 'distinct errors share the per-minute page limit');
  clock = 60_000;
  host.dispatch('error', { error: Object.assign(new Error('x'), { stack: 'at f (/js/a.js:999:1)' }) });
  assert.equal(sent.length, BROWSER_LIMIT + 1, 'the limit renews each minute');
  await settle();
});

test('the gate bounds its own memory while admitting new fingerprints', () => {
  let clock = 0;
  const gate = createErrorGate({ limit: Infinity, now: () => clock, maxKeys: 3 });
  const report = index => scrubError({ stack: `at f (/js/a.js:${index}:1)` });
  for (let index = 0; index < 4; index++) assert.equal(gate(report(index)), true);
  assert.equal(gate(report(3)), false);
  assert.equal(gate(report(0)), true, 'the oldest fingerprint is forgotten once the bound is reached');
  clock = 60_000;
  assert.equal(gate(report(3)), true);
});

function edgeHarness({ assets, carr } = {}) {
  const captures = [], forwarded = [], waits = [];
  const env = {
    GIT_SHA: 'b'.repeat(40),
    CARR_ERRORS: { capture: async input => { captures.push(input); return { ok: true }; } },
    ASSETS: { fetch: assets || (async () => new Response('ok')) },
    CARR: { fetch: async request => { forwarded.push({ headers: Object.fromEntries(request.headers), body: await request.text() }); return carr ? carr(request) : new Response('{"ok":true}', { status: 202 }); } },
  };
  const handle = createDoctorcreRequestHandler(undefined,
    { browser: createErrorGate({ limit: EDGE_LIMIT }), edge: createErrorGate({ limit: EDGE_LIMIT }) });
  const call = async (request, ctx = { waitUntil: promise => waits.push(promise) }) => {
    const response = await handle(request, env, ctx);
    await Promise.all(waits.splice(0));
    return response;
  };
  return { env, captures, forwarded, call };
}

test('the app Worker captures its own exceptions and 5xx once through the credentialless service seam', async () => {
  const thrown = edgeHarness({ assets: async () => { throw Object.assign(new TypeError('Alice alice@example.test'), { stack: piiError().stack }); } });
  for (let index = 0; index < 20; index++) {
    const response = await thrown.call(new Request('https://app/js/private.js?email=alice@example.test'));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  }
  assert.deepEqual(thrown.captures, [{ type: 'TypeError', message: '[redacted]', stack: 'asset:12:3',
    route: '/:value/:value', release_sha: 'b'.repeat(40) }], 'a repeating edge failure is captured once per repeat window');

  const failed = edgeHarness({ assets: async () => new Response('private', { status: 503 }) });
  const response = await failed.call(new Request('https://app/js/private.js'), {});
  assert.equal(response.status, 503, 'the primary response is preserved, and awaited when the runtime has no waitUntil');
  assert.deepEqual(failed.captures, [{ type: 'HTTP5xx', message: 'HTTP 5xx response', stack: '', route: '/:value/:value', release_sha: 'b'.repeat(40) }]);

  const hostile = edgeHarness({ assets: async () => { throw { get name() { throw new Error('Alice'); } }; } });
  assert.equal((await hostile.call(new Request('https://app/js/a.js'))).status, 500);
  assert.equal(hostile.captures.length, 1);
  assert.doesNotMatch(JSON.stringify([thrown.captures, failed.captures, hostile.captures]), PII);
});

test('CARR-originated 5xx stay CARR captures and a failed capture only leaves a scrubbed log', async () => {
  const upstream = edgeHarness({ carr: async () => new Response('{}', { status: 502 }) });
  assert.equal((await upstream.call(new Request('https://app/api/v1/deals'))).status, 502);
  assert.deepEqual(upstream.captures, []);

  const broken = edgeHarness({ assets: async () => { throw new Error('Alice alice@example.test'); } });
  broken.env.CARR_ERRORS.capture = async () => { throw new Error('carr down'); };
  const logs = [];
  const original = console.error;
  console.error = line => logs.push(line);
  try { assert.equal((await broken.call(new Request('https://app/js/a.js'))).status, 500); }
  finally { console.error = original; }
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).event, 'runtime_error_capture_failed');
  assert.doesNotMatch(logs[0], PII);

  delete broken.env.CARR_ERRORS;
  assert.equal((await broken.call(new Request('https://app/js/b.js'))).status, 500);
});

const report = (body, headers = {}) => new Request('https://app/api/v1/runtime-errors', { method: 'POST',
  headers: { origin: 'https://app', 'content-type': 'application/json', cookie: 'session=synthetic', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the edge re-scrubs browser reports and forwards one per fingerprint to signed-in CARR ingress', async () => {
  const edge = edgeHarness();
  const untrusted = { type: 'TypeError', message: 'Cannot read properties of Alice', stack: 'at f (https://app/js/a.js?email=alice@example.test:9:4)\nAlice diagnosis',
    route: '/clients/Alice', release_sha: 'c'.repeat(40), name: 'Alice', email: 'alice@example.test' };
  const first = await edge.call(report(untrusted));
  assert.equal(first.status, 202);
  assert.equal(edge.forwarded.length, 1);
  assert.deepEqual(JSON.parse(edge.forwarded[0].body), { type: 'TypeError', message: 'Cannot read properties of [redacted]',
    stack: 'asset:9:4', route: '/clients/:value', release_sha: 'c'.repeat(40) });
  assert.equal(edge.forwarded[0].headers.cookie, 'session=synthetic', 'CARR still authenticates the partner session');
  assert.doesNotMatch(edge.forwarded[0].body, PII);

  for (let index = 0; index < 50; index++) {
    const repeat = await edge.call(report(untrusted));
    assert.equal(repeat.status, 202);
    assert.deepEqual(await repeat.json(), { ok: true, deduplicated: true });
  }
  assert.equal(edge.forwarded.length, 1, 'repeats are answered at the edge without waking CARR');
  assert.deepEqual(edge.captures, []);
});

test('the edge refuses cross-origin, non-JSON, malformed and oversized reports without contacting CARR', async () => {
  const edge = edgeHarness();
  const cases = [
    [report({}, { origin: 'https://elsewhere' }), 403],
    [report({}, { 'content-type': 'text/plain' }), 415],
    [report('{'), 400],
    [report('[]'), 400],
    [report({ stack: 'x'.repeat(13000) }), 413],
  ];
  for (const [request, status] of cases) assert.equal((await edge.call(request)).status, status);
  assert.equal(edge.forwarded.length, 0);
  assert.equal(edge.captures.length, 0);
});

test('a browser report flood cannot silence edge capture, and a browser cannot claim an HTTP 5xx', async () => {
  const edge = edgeHarness({ assets: async () => { throw Object.assign(new TypeError('x'), { stack: piiError().stack }); } });
  for (let index = 0; index < EDGE_LIMIT + 5; index++)
    await edge.call(report({ type: 'Error', stack: `at f (/js/a.js:${index}:1)` }));
  assert.equal(edge.forwarded.length, EDGE_LIMIT, 'browser reports keep their own per-minute limit');
  assert.equal((await edge.call(new Request('https://app/js/a.js'))).status, 500);
  assert.equal(edge.captures.length, 1, 'the edge still captures its own failure after the browser limit is spent');

  const claim = edgeHarness();
  await claim.call(report({ type: 'HTTP5xx', message: 'HTTP 5xx response', route: '/deals' }));
  assert.deepEqual(JSON.parse(claim.forwarded[0].body), { type: 'Error', message: '[redacted]', stack: '', route: '/deals', release_sha: null });
});
