// Mock-only proof for the source-owned run budget. Every transport here is a
// stub or a loopback server this file starts; nothing leaves the machine, no
// model provider is loaded and no staging fixture is created.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  HOME_SMOKE, BudgetRefusal, createRunBudget, resumeRunBudget, requestOperatorStop, reauthorizeRunBudget, validateProfile,
} from '../../scripts/e2e-staging/run-budget.mjs';
import { homeSmoke, parseHomeSmokeArgs, installBudgetedRoute, READ_VERBS } from '../../scripts/e2e-staging/home-smoke.mjs';
import { stagingSession, STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { parseVmStat, portListening, LOCAL_MODEL_PORT } from '../../scripts/e2e-staging/host-headroom.mjs';
import { sweep } from '../../scripts/e2e-staging/sweep.mjs';
import { exploreAll } from '../../scripts/e2e-staging/explore.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// Stubbed host: no local model port, plenty of free memory.
const clearHost = { portOpen: async () => false, freeInactiveBytes: async () => 40 * GiB };
const budgetDir = () => mkdtemp(join(tmpdir(), 'doctorcre-run-budget-'));
const refusal = code => error => error instanceof BudgetRefusal && error.code === code;
const tiny = overrides => ({ ...HOME_SMOKE, ...overrides });
const readState = async dir => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));

function fakeClock(start = 1_700_000_000_000) {
  let now = start, sequence = 0;
  const timers = new Map();
  const schedule = (fn, ms, every) => { const id = ++sequence; timers.set(id, { at: now + ms, fn, every }); return id; };
  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => timers.delete(id),
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (!timers.has(id) || timer.at > now) continue;
        if (timer.every) timer.at = now + timer.every; else timers.delete(id);
        await timer.fn();
      }
    },
  };
}

// A stand-in for Playwright's APIRequestContext: it answers every preflight
// phase from memory and counts each call, so the real stagingSession code runs
// against the budget without any socket.
function fakePreflight({ status = {}, hold } = {}) {
  const calls = [];
  const reply = (path, code = 200) => {
    const body = path.endsWith('/app-release') ? { environment: 'staging', service: 'doctorcre-app', source_commit: 'a'.repeat(40) }
      : path.endsWith('/release') ? { env: { value: 'staging' }, git_sha: { value: 'c06bdf2788fb69daefb59364ea4fd798fa94f9a4' } }
      : path === '/auth/session' ? { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } : {};
    return { status: () => code, ok: () => code >= 200 && code < 300, json: async () => body };
  };
  const call = async (method, path) => {
    calls.push(method + ' ' + path);
    if (hold?.path === path) await hold.until;
    return reply(path, status[path]);
  };
  return {
    calls,
    factory: async () => ({
      get: path => call('GET', path),
      post: path => call('POST', path),
      storageState: async () => ({ cookies: [{ name: '__Host-dealroom_session', httpOnly: true, secure: true, value: 'x', domain: 'example.invalid', path: '/' }], origins: [] }),
      dispose: async () => {},
    }),
  };
}

// A loopback-only Home stand-in. It records every request it receives, so a
// test can prove each one was charged and that refused attempts never arrived.
async function loopbackHome({ controls = 12, homeStatus = () => 200, holdAsset } = {}) {
  const hits = [];
  const buttons = Array.from({ length: controls }, (_, index) => `<button id="b${index}">Control ${index}</button>`).join('');
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head>
    <body><main>${buttons}<a href="/deals">Deals</a></main></body></html>`;
  const server = createServer(async (request, response) => {
    hits.push(request.method + ' ' + request.url);
    if (request.url === '/') {
      const code = homeStatus();
      response.writeHead(code, { 'content-type': 'text/html' });
      return response.end(code === 200 ? html : 'unavailable');
    }
    if (request.url === '/style.css') { response.writeHead(200, { 'content-type': 'text/css' }); return response.end('main{display:block}'); }
    if (request.url === '/app.js') {
      if (holdAsset) await holdAsset;
      response.writeHead(200, { 'content-type': 'text/javascript' });
      return response.end("fetch('/api/read');");
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  server.unref();
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, allowed: url => url.origin === origin, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

const smokeSession = (budget, fake) => () => stagingSession(STAGING_ORIGIN, { budget, requestFactory: fake.factory, readSecret: async () => 's'.repeat(40) });

test('the default profile is exactly the proposed read-only Home smoke bound', () => {
  assert.deepEqual({ ...HOME_SMOKE }, {
    name: 'home-smoke.v1', deadlineMs: 120_000, requestTimeoutMs: 30_000, retries: 0, concurrency: 2,
    http: 200, preflight: 8, model: 0, mutation: 0, fixture: 0, target: 1, viewport: 2, context: 2,
    controlsPerViewport: 10, control: 20, ownerState: 0, screenshot: 5, screenshotBytes: 2 * MiB,
    file: 100, byte: 20 * MiB, logByte: 1 * MiB, memoryFloorBytes: 16 * GiB, trace: false, video: false, aiTrace: false,
  });
  assert.ok(Object.isFrozen(HOME_SMOKE));
  validateProfile(HOME_SMOKE);
});

test('profiles must be finite, integral and never looser than the approved Home smoke', async () => {
  for (const bad of [{ http: Infinity }, { http: Number.NaN }, { http: -1 }, { http: 1.5 }, { deadlineMs: undefined }, { trace: 'on' }])
    assert.throws(() => validateProfile(tiny(bad)), refusal('profile-invalid'));
  for (const looser of [{ http: 201 }, { preflight: 9 }, { deadlineMs: 120_001 }, { concurrency: 3 }, { retries: 1 }, { model: 1 }, { mutation: 1 }, { fixture: 1 }, { video: true }, { aiTrace: true }])
    await assert.rejects(createRunBudget({ dir: await budgetDir(), profile: tiny(looser) }), refusal('profile-exceeds-approved'));
});

test('N attempts are admitted, attempt N+1 is refused with zero transport and the stop is durable', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ http: 3 }) });
  let transport = 0;
  for (let index = 0; index < 3; index++) assert.equal(await budget.dispatch('http', async () => ++transport), index + 1);
  await assert.rejects(budget.dispatch('http', async () => ++transport), refusal('http-exhausted'));
  assert.equal(transport, 3);
  assert.equal(budget.signal.aborted, true);
  const state = await readState(dir);
  assert.equal(state.spent.http, 3);
  assert.equal(state.stopped.reason, 'http-exhausted');
  await assert.rejects(budget.dispatch('http', async () => ++transport), refusal('stopped'));
  assert.equal(transport, 3);
  await budget.close();
});

test('failed and cancelled attempts stay spent', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ http: 2 }) });
  await assert.rejects(budget.dispatch('http', async () => { throw new Error('transport reset'); }), /transport reset/);
  let cancel, sent;
  const started = new Promise(resolve => { sent = resolve; });
  const cancelled = budget.dispatch('http', () => new Promise((_, reject) => { cancel = () => reject(new Error('cancelled')); sent(); }));
  await started;
  cancel();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal((await readState(dir)).spent.http, 2);
  await assert.rejects(budget.dispatch('http', async () => 'late'), refusal('http-exhausted'));
  await budget.close();
});

test('concurrent requests cannot oversubscribe the count or exceed two in flight', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ http: 6 }) });
  let transport = 0, active = 0, peak = 0;
  const send = async () => { transport++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return 'ok'; };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.dispatch('http', send)));
  // Exhaustion stops the run, so the request still in flight then is abandoned too.
  assert.ok(results.filter(row => row.status === 'fulfilled').length >= 4);
  assert.ok(results.filter(row => row.status === 'rejected').every(row => ['http-exhausted', 'stopped'].includes(row.reason.code)));
  assert.equal(transport, 6);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
  assert.equal((await readState(dir)).spent.http, 6);
  await budget.close();
});

test('preflight attempts share the request count, never retry, and stop at eight', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ http: 5 }) });
  const fake = fakePreflight();
  await smokeSession(budget, fake)();
  assert.deepEqual(fake.calls, ['GET /app-release', 'GET https://carr-mcp-staging.joe-bookout-carr-us.workers.dev/release', 'POST /auth/e2e-session', 'GET /auth/session']);
  assert.deepEqual([(await readState(dir)).spent.http, (await readState(dir)).spent.preflight], [4, 4]);
  // A second preflight would need four more; the fifth request is the last one admitted.
  await assert.rejects(smokeSession(budget, fake)(), refusal('http-exhausted'));
  assert.equal(fake.calls.length, 5);
  await budget.close();

  const retryDir = await budgetDir();
  const noRetry = await createRunBudget({ dir: retryDir, profile: HOME_SMOKE });
  const unavailable = fakePreflight({ status: { '/app-release': 503 } });
  await assert.rejects(smokeSession(noRetry, unavailable)(), error => error.code === 'app-release-http-503');
  assert.deepEqual(unavailable.calls, ['GET /app-release']);
  await noRetry.close();

  const capDir = await budgetDir();
  const capped = await createRunBudget({ dir: capDir, profile: HOME_SMOKE });
  const many = fakePreflight();
  await smokeSession(capped, many)();
  await smokeSession(capped, many)();
  await assert.rejects(smokeSession(capped, many)(), refusal('preflight-exhausted'));
  assert.equal(many.calls.length, 8);
  assert.equal((await readState(capDir)).spent.http, 8);
  await capped.close();
});

test('model cap zero refuses exploration before the provider adapter or any setup loads', async () => {
  let loaded = 0, setup = 0;
  await assert.rejects(exploreAll({ loadExplorer: async () => { loaded++; }, prepareRecords: async () => { setup++; } }), refusal('model-not-budgeted'));
  assert.deepEqual([loaded, setup], [0, 0]);
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  await assert.rejects(budget.reserve('model'), refusal('model-exhausted'));
  assert.equal((await readState(dir)).stopped.reason, 'model-exhausted');
  await budget.close();
});

test('mutation and fixture caps zero refuse the sweep before setup and refuse write requests at the route', async () => {
  let setup = 0;
  await assert.rejects(sweep({ prepareRecords: async () => { setup++; } }), refusal('fixture-not-budgeted'));
  assert.equal(setup, 0);
  for (const verb of ['claim-lead', 'update-lead', 'link-lead-client', 'patch-deal-field', 'unknown-verb']) assert.equal(READ_VERBS.has(verb), false);
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await installBudgetedRoute(context, budget, { allowed: home.allowed });
    const page = await context.newPage();
    await page.goto(home.origin + '/');
    const outcome = await page.evaluate(async () => {
      const read = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deal-room-board', arguments: {} } }) });
      let write = 'sent';
      try { await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claim-lead', arguments: {} } }) }); }
      catch { write = 'refused'; }
      return { read: read.status, write };
    });
    assert.deepEqual(outcome, { read: 200, write: 'refused' });
    assert.equal(home.hits.filter(hit => hit === 'POST /mcp').length, 1);
    const state = await readState(dir);
    assert.equal(state.stopped.reason, 'mutation-exhausted');
    assert.equal(state.spent.mutation, 0);
    await context.close();
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('unsupported ingress refuses: websockets and other origins never dispatch', async () => {
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await installBudgetedRoute(context, budget, { allowed: home.allowed });
    const page = await context.newPage();
    await page.goto(home.origin + '/');
    await page.waitForLoadState('networkidle');
    const before = (await readState(dir)).spent.http;
    const result = await page.evaluate(origin => new Promise(resolve => {
      const socket = new WebSocket(origin.replace('http', 'ws') + '/socket');
      socket.onopen = () => resolve('open');
      socket.onclose = () => resolve('closed');
      socket.onerror = () => resolve('closed');
      fetch('http://127.0.0.2:9/elsewhere').catch(() => {});
    }), home.origin);
    assert.equal(result, 'closed');
    assert.equal((await readState(dir)).spent.http, before);
    assert.equal(home.hits.some(hit => hit.includes('socket')), false);
    await context.close();
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('global expiry during preflight persists stop, abandons the in-flight reply and starts no later phase', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  let release;
  const fake = fakePreflight({ hold: { path: '/auth/e2e-session', until: new Promise(resolve => { release = resolve; }) } });
  const pending = smokeSession(budget, fake)();
  await new Promise(resolve => setImmediate(resolve));
  while (!fake.calls.includes('POST /auth/e2e-session')) await new Promise(resolve => setImmediate(resolve));
  await clock.advance(HOME_SMOKE.deadlineMs);
  await assert.rejects(pending, refusal('deadline'));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.calls.includes('GET /auth/session'), false);
  assert.equal((await readState(dir)).stopped.reason, 'deadline');
  await budget.close();
});

test('global expiry while a dispatch waits rejects the late reply instead of qualifying it', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  let answer;
  const inflight = budget.dispatch('http', () => new Promise(resolve => { answer = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await clock.advance(HOME_SMOKE.deadlineMs + 1);
  answer('late success');
  await assert.rejects(inflight, refusal('deadline'));
  await assert.rejects(budget.reserve('control'), refusal('stopped'));
  await budget.close();
});

test('global expiry during the Home screen closes the context, never starts the next viewport and leaves a bounded stop receipt', async () => {
  let releaseAsset;
  const home = await loopbackHome({ holdAsset: new Promise(resolve => { releaseAsset = resolve; }) });
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  const browser = await chromium.launch();
  try {
    const run = homeSmoke({ budget, browser, origin: home.origin, allowed: home.allowed, host: clearHost, session: smokeSession(budget, fakePreflight()) });
    while (!home.hits.includes('GET /app.js')) await new Promise(resolve => setTimeout(resolve, 10));
    await clock.advance(HOME_SMOKE.deadlineMs);
    releaseAsset();
    const receipt = await run;
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.stopped.reason, 'deadline');
    assert.equal(receipt.viewports.length, 0);
    assert.equal(browser.contexts().length, 0);
    assert.equal(home.hits.filter(hit => hit === 'GET /').length, 1, 'the phone viewport never started');
    const stored = JSON.parse(await readFile(join(dir, 'evidence', 'home-smoke-receipt.json'), 'utf8'));
    assert.equal(stored.stopped.reason, 'deadline');
    assert.ok((await stat(join(dir, 'evidence', 'home-smoke-receipt.json'))).size < 64 * 1024);
  } finally { await browser.close(); await home.close(); }
});

test('global expiry during reporting keeps only the bounded stop receipt', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  await clock.advance(HOME_SMOKE.deadlineMs);
  await assert.rejects(budget.writeEvidence('late-report.json', '{}'), refusal('stopped'));
  await budget.finish({ schema: 'home-smoke-receipt.v1', qualified: true });
  const receipt = JSON.parse(await readFile(join(dir, 'evidence', 'home-smoke-receipt.json'), 'utf8'));
  assert.equal(receipt.qualified, false, 'a stopped run can never report qualified coverage');
  assert.deepEqual(await readdir(join(dir, 'evidence')), ['home-smoke-receipt.json']);
  assert.equal(budget.openWriters, 0);
});

test('the first infrastructure failure stops scheduling: a failed desktop Home never reaches the phone viewport', async () => {
  const home = await loopbackHome({ homeStatus: () => 503 });
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const browser = await chromium.launch();
  try {
    const receipt = await homeSmoke({ budget, browser, origin: home.origin, allowed: home.allowed, host: clearHost, session: smokeSession(budget, fakePreflight()) });
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.failure.code, 'home-response-refused');
    assert.match((await readState(dir)).stopped.reason, /^infrastructure-failure/);
    assert.equal(home.hits.filter(hit => hit === 'GET /').length, 1);
  } finally { await browser.close(); await home.close(); }
});

test('a restarted process keeps the same identity, spent counters, deadline and stop', async () => {
  const dir = await budgetDir();
  const module = new URL('../../scripts/e2e-staging/run-budget.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { createRunBudget } = await import(${JSON.stringify(module)});
    const budget = await createRunBudget({ dir: ${JSON.stringify(dir)} });
    for (let i = 0; i < 3; i++) await budget.dispatch('http', async () => 'stub');
    await budget.reserve('context');
    process.kill(process.pid, 'SIGKILL');`], { stdio: 'ignore' });
  await once(child, 'exit');
  const before = await readState(dir);
  const resumed = await resumeRunBudget({ dir });
  assert.equal(resumed.runId, before.run_id);
  assert.deepEqual([resumed.spent.http, resumed.spent.context], [3, 1]);
  assert.equal((await readState(dir)).deadline_at, before.deadline_at);
  await resumed.stop('operator');
  await resumed.close();
  await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  await assert.rejects(createRunBudget({ dir }), refusal('state-exists'));
});

test('missing or corrupt durable state fails closed before any dispatch', async () => {
  await assert.rejects(resumeRunBudget({ dir: await budgetDir() }), refusal('state-missing'));
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir });
  await budget.close();
  await writeFile(join(dir, 'state.json'), '{"schema":"e2e-run-budget.v1","spent":');
  await assert.rejects(resumeRunBudget({ dir }), refusal('state-corrupt'));
  const tampered = await budgetDir();
  const original = await createRunBudget({ dir: tampered });
  await original.close();
  const state = await readState(tampered);
  state.profile.http = 10_000;
  await writeFile(join(tampered, 'state.json'), JSON.stringify(state));
  await assert.rejects(resumeRunBudget({ dir: tampered }), refusal('state-corrupt'));
  await assert.rejects(createRunBudget({ dir: tampered }), refusal('state-exists'));
});

test('an operator stop works during flight, persists, and survives a restart', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  let answer;
  const inflight = budget.dispatch('http', () => new Promise(resolve => { answer = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await requestOperatorStop(dir, 'cost hold');
  await clock.advance(250);
  answer('late');
  await assert.rejects(inflight, refusal('operator-stop'));
  assert.equal((await readState(dir)).stopped.reason, 'operator-stop');
  await budget.close();
  await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  // A hold placed before the run starts is equally binding.
  const held = await budgetDir();
  await requestOperatorStop(held, 'hold before start');
  await assert.rejects(createRunBudget({ dir: held }), refusal('operator-stop'));
});

test('no CLI flag, environment variable, reset or new run id lifts a stop', async () => {
  for (const argv of [['--reset'], ['--profile', 'wide'], ['--http', '9999'], ['--resume'], ['anything']])
    assert.throws(() => parseHomeSmokeArgs(argv), refusal('arguments-refused'));
  assert.deepEqual(parseHomeSmokeArgs([]), {});
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir });
  await budget.stop('operator');
  await budget.close();
  const saved = { ...process.env };
  Object.assign(process.env, { E2E_RUN_BUDGET_RESET: '1', E2E_RUN_ID: 'fresh', E2E_HTTP_LIMIT: '100000', CI: '1' });
  try {
    await assert.rejects(createRunBudget({ dir }), refusal('state-exists'));
    await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  } finally { process.env = saved; }
  assert.throws(() => reauthorizeRunBudget(dir), refusal('reauthorization-required'));
  for (const file of ['run-budget.mjs', 'home-smoke.mjs']) {
    const source = await readFile(new URL('../../scripts/e2e-staging/' + file, import.meta.url), 'utf8');
    assert.equal(/process\.env/.test(source), false, `${file} must not read the environment`);
  }
});

test('evidence limits refuse oversize output before writing and count copies, files and logs', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ byte: 4096, file: 3, logByte: 64 }) });
  await budget.writeEvidence('a.json', 'x'.repeat(1000));
  await assert.rejects(budget.writeEvidence('big.json', 'x'.repeat(5000)), refusal('byte-exhausted'));
  assert.deepEqual((await readdir(join(dir, 'evidence'))).sort(), ['a.json']);
  // One file and a quarter of the bytes stay held back for the bounded receipt.
  const second = await createRunBudget({ dir: await budgetDir(), profile: tiny({ byte: 4096, file: 3 }) });
  await second.writeEvidence('a.json', 'x'.repeat(1500));
  await second.copyEvidence('a.json', 'copy.json');
  assert.equal(second.spent.byte, 3000);
  await assert.rejects(second.copyEvidence('a.json', 'copy-2.json'), refusal('file-exhausted'));
  await second.close();
  const logs = await createRunBudget({ dir: await budgetDir(), profile: tiny({ logByte: 64 }) });
  await logs.log('x'.repeat(40));
  await assert.rejects(logs.log('y'.repeat(40)), refusal('logByte-exhausted'));
  await logs.finish({ schema: 'home-smoke-receipt.v1' });
  assert.equal(logs.openWriters, 0);
  await budget.close();
});

test('screenshots reserve their worst-case bytes first and an oversized capture is never written', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ screenshotBytes: 1024 }) });
  const page = { screenshot: async () => Buffer.alloc(4096) };
  await assert.rejects(budget.captureScreenshot(page, 'home.jpg'), refusal('screenshot-oversize'));
  assert.deepEqual(await readdir(join(dir, 'evidence')).catch(() => []), []);
  assert.deepEqual([budget.spent.screenshot, budget.spent.byte], [1, 1024]);
  await budget.close();
  const counted = await createRunBudget({ dir: await budgetDir(), profile: tiny({ screenshot: 1 }) });
  await counted.captureScreenshot({ screenshot: async () => Buffer.alloc(10) }, 'one.jpg');
  let captured = 0;
  await assert.rejects(counted.captureScreenshot({ screenshot: async () => { captured++; return Buffer.alloc(10); } }, 'two.jpg'), refusal('screenshot-exhausted'));
  assert.equal(captured, 0);
  await counted.close();
});

test('the context cap refuses before a third browser context is created', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  await budget.reserve('context');
  await budget.reserve('context');
  await assert.rejects(budget.reserve('context'), refusal('context-exhausted'));
  await budget.close();
});

test('the read-only Home smoke charges every request to one count and measures at most ten controls per viewport', async () => {
  const home = await loopbackHome({ controls: 14 });
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const preflight = fakePreflight();
  const browser = await chromium.launch();
  try {
    const receipt = await homeSmoke({ budget, browser, origin: home.origin, allowed: home.allowed, host: clearHost, session: smokeSession(budget, preflight) });
    assert.equal(receipt.qualified, true, JSON.stringify(receipt.failure));
    assert.deepEqual(receipt.viewports.map(row => [row.viewport, row.controls.length, row.visible_controls]), [['desktop', 10, 15], ['phone', 10, 15]]);
    const state = await readState(dir);
    assert.equal(state.spent.http, preflight.calls.length + home.hits.length, 'every dispatched request was charged exactly once');
    assert.equal(state.spent.preflight, preflight.calls.length);
    assert.deepEqual([state.spent.model, state.spent.mutation, state.spent.fixture, state.spent.ownerState], [0, 0, 0, 0]);
    assert.deepEqual([state.spent.context, state.spent.viewport, state.spent.screenshot], [2, 2, 2]);
    assert.equal(state.stopped.reason, 'completed');
    const files = await readdir(join(dir, 'evidence'));
    assert.deepEqual(files.sort(), ['home-desktop.jpg', 'home-phone.jpg', 'home-smoke-receipt.json']);
    assert.equal(files.some(file => /trace|video|\.zip|\.webm/.test(file)), false);
    await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  } finally { await browser.close(); await home.close(); }
});

test('a resident local model refuses the run before any dispatch and leaves a durable stop receipt', async () => {
  for (const [host, cause] of [
    [{ portOpen: async () => true, freeInactiveBytes: async () => 40 * GiB }, 'local-model-port-listening'],
    [{ portOpen: async () => false, freeInactiveBytes: async () => 8 * GiB }, 'memory-below-floor'],
    [{ portOpen: async () => false, freeInactiveBytes: async () => { throw new Error('vm_stat unavailable'); } }, 'memory-unreadable'],
  ]) {
    const dir = await budgetDir();
    const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
    let sessions = 0, contexts = 0;
    const browser = { newContext: async () => { contexts++; throw new Error('no browser should start'); } };
    const receipt = await homeSmoke({ budget, browser, origin: STAGING_ORIGIN, host, session: async () => { sessions++; throw new Error('no preflight should start'); } });
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.stopped.reason, 'local_model_resident');
    assert.equal(receipt.failure.cause, cause);
    assert.deepEqual([sessions, contexts], [0, 0]);
    const state = await readState(dir);
    assert.deepEqual([state.spent.http, state.spent.preflight, state.spent.target, state.spent.context], [0, 0, 0, 0]);
    assert.equal(state.stopped.reason, 'local_model_resident');
    const stored = JSON.parse(await readFile(join(dir, 'evidence', 'home-smoke-receipt.json'), 'utf8'));
    assert.equal(stored.failure.cause, cause);
    await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  }
});

test('memory exactly at the floor with no local model port lets the preflight start', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  let sessions = 0;
  const receipt = await homeSmoke({ budget, browser: {}, origin: STAGING_ORIGIN,
    host: { portOpen: async () => false, freeInactiveBytes: async () => 16 * GiB },
    session: async () => { sessions++; throw Object.assign(new Error('stub preflight refused'), { code: 'stub-refused' }); } });
  assert.equal(sessions, 1);
  assert.equal(receipt.failure.code, 'stub-refused');
});

test('the memory floor is a profile bound that may only be raised', async () => {
  await assert.rejects(createRunBudget({ dir: await budgetDir(), profile: tiny({ memoryFloorBytes: 8 * GiB }) }), refusal('profile-exceeds-approved'));
  const stricter = await createRunBudget({ dir: await budgetDir(), profile: tiny({ memoryFloorBytes: 32 * GiB }) });
  assert.equal(stricter.profile.memoryFloorBytes, 32 * GiB);
  await stricter.close();
});

test('host probes read free plus inactive memory from vm_stat and detect a listening loopback port', async () => {
  const sample = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               100000.\nPages active:                             900000.\nPages inactive:                           50000.\nPages speculative:                        1000.\n';
  assert.equal(parseVmStat(sample), (100000 + 50000) * 16384);
  assert.throws(() => parseVmStat('garbage'), /vm_stat/);
  assert.equal(LOCAL_MODEL_PORT, 8000);
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  assert.equal(await portListening(port), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await portListening(port), false);
});
