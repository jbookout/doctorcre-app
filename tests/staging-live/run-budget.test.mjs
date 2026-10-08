// Mock-only proof for the source-owned run budget. Every transport here is a
// stub or a loopback server this file starts; nothing leaves the machine, no
// model provider is loaded and no staging fixture is created.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, stat, unlink, mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  HOME_SMOKE, SWEEP_EXPLORE, BUDGET_DIR, BudgetRefusal, authorizeRun, openRunBudget, requestOperatorStop, validateProfile,
  parseBudgetCommand, describeAuthorization, canonicalJSON, setActiveBudget,
} from '../../scripts/e2e-staging/run-budget.mjs';
import { homeSmoke, parseHomeSmokeArgs, runHomeSmoke } from '../../scripts/e2e-staging/home-smoke.mjs';
import { installBudgetedRoute, READ_VERBS, streamingFetch } from '../../scripts/e2e-staging/budgeted-route.mjs';
import { budgetedModel } from '../../scripts/e2e-staging/budgeted-model.mjs';
import { prepareStagingRecords, cleanupStagingRecords, REMOVAL_VERBS } from '../../scripts/e2e-staging/records.mjs';
import { readMetered, stagingSession, STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { parseVmStat, portListening, localModelPortStatus, localModelHeadroom, LOCAL_MODEL_PORT } from '../../scripts/e2e-staging/host-headroom.mjs';
import { sweep } from '../../scripts/e2e-staging/sweep.mjs';
import { exploreAll } from '../../scripts/e2e-staging/explore.mjs';
import { stagingRequestAllowed } from '../../scripts/e2e-staging/engine.mjs';
import { stagingTargets } from '../../scripts/e2e-staging/screens.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// Stubbed host: no local model port, plenty of free memory.
const clearHost = { portOpen: async () => false, freeInactiveBytes: async () => 40 * GiB };
const crowdedHost = { portOpen: async () => true, freeInactiveBytes: async () => 40 * GiB };
const budgetDir = () => mkdtemp(join(tmpdir(), 'doctorcre-run-budget-'));
const refusal = code => error => error instanceof BudgetRefusal && error.code === code;
const tiny = overrides => ({ ...HOME_SMOKE, ...overrides });
const tinySweep = overrides => ({ ...SWEEP_EXPLORE, ...overrides });
const readState = async dir => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
const readLedger = async dir => (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };

// The only way a run starts: an explicit authorization, then an open of that
// authorized profile. Tests do both against a private temporary directory.
async function createRunBudget({ dir, profile = HOME_SMOKE, clock } = {}) {
  await authorizeRun({ dir, profile, reason: 'mock-only test' });
  return openRunBudget({ dir, profile: profile.name, clock });
}
const resumeRunBudget = ({ dir, clock, profile = HOME_SMOKE.name }) => openRunBudget({ dir, profile, clock });

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
function fakePreflight({ status = {}, hold, declared = {} } = {}) {
  const calls = [];
  const reply = (path, code = 200) => {
    const body = path.endsWith('/app-release') ? { environment: 'staging', service: 'doctorcre-app', source_commit: 'a'.repeat(40) }
      : path.endsWith('/release') ? { env: { value: 'staging' }, git_sha: { value: 'c06bdf2788fb69daefb59364ea4fd798fa94f9a4' } }
      : path === '/auth/session' ? { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } : {};
    const bytes = Buffer.from(JSON.stringify(body));
    return { status: () => code, ok: () => code >= 200 && code < 300, json: async () => body, body: async () => bytes,
      headers: () => ({ 'content-length': String(declared[path] ?? bytes.length) }) };
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
  let upgrades = 0, connections = 0;
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
    if (request.url === '/redirect') { response.writeHead(302, { location: '/target' }); return response.end(); }
    if (request.url === '/declared-large') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(200 * 1024) });
      return response.end(Buffer.alloc(200 * 1024));
    }
    if (request.url === '/streamed-large') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let index = 0; index < 50; index++) response.write(Buffer.alloc(4096));
      return response.end();
    }
    if (request.url.startsWith('/kilobytes')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      return response.end(Buffer.alloc(Number(new URL(request.url, 'http://x').searchParams.get('size')) * 1024));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.on('connection', () => { connections++; });
  // A real RFC 6455 handshake, so an unrouted WebSocket would open.
  server.on('upgrade', (request, socket) => {
    upgrades++;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1');
  server.unref();
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, upgrades: () => upgrades, connections: () => connections, allowed: url => url.origin === origin,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

const smokeSession = (budget, fake) => () => stagingSession(STAGING_ORIGIN, { budget, requestFactory: fake.factory, readSecret: async () => 's'.repeat(40) });

test('the default profile is exactly the proposed read-only Home smoke bound', () => {
  assert.deepEqual({ ...HOME_SMOKE }, {
    name: 'home-smoke.v1', deadlineMs: 120_000, requestTimeoutMs: 30_000, retries: 0, concurrency: 2,
    http: 200, preflight: 8, model: 0, modelOutputTokens: 0, modelTimeoutMs: 0, mutation: 0, fixture: 0, target: 1, viewport: 2, context: 2,
    controlsPerViewport: 10, control: 20, ownerState: 0, screenshot: 5, screenshotBytes: 2 * MiB,
    file: 100, byte: 20 * MiB, logByte: 1 * MiB, ingress: 50 * MiB, responseBytes: 10 * MiB, memoryFloorBytes: 16 * GiB, trace: false, video: false, aiTrace: false,
  });
  assert.ok(Object.isFrozen(HOME_SMOKE));
  validateProfile(HOME_SMOKE);
});

test('the sweep-explore profile is exactly the bound Joe approved on 2026-10-08', () => {
  assert.deepEqual({ ...SWEEP_EXPLORE }, {
    name: 'sweep-explore.v1', deadlineMs: 600_000, requestTimeoutMs: 30_000, retries: 0, concurrency: 2,
    http: 400, preflight: 8, model: 20, modelOutputTokens: 4096, modelTimeoutMs: 60_000, mutation: 25, fixture: 25,
    target: 4, viewport: 4, context: 400, controlsPerViewport: 400, control: 400, ownerState: 100,
    screenshot: 20, screenshotBytes: 2 * MiB, file: 200, byte: 50 * MiB, logByte: 1 * MiB, ingress: 200 * MiB, responseBytes: 10 * MiB, memoryFloorBytes: 16 * GiB,
    trace: false, video: false, aiTrace: false,
  });
  assert.ok(Object.isFrozen(SWEEP_EXPLORE));
});

test('run state lives at one fixed per-user location that no cwd, HOME or clone can move', async () => {
  assert.equal(BUDGET_DIR, join(userInfo().homedir, '.local', 'state', 'doctorcre-e2e'));
  const module = new URL('../../scripts/e2e-staging/run-budget.mjs', import.meta.url).href;
  const elsewhere = await budgetDir();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `const { BUDGET_DIR } = await import(${JSON.stringify(module)}); process.stdout.write(BUDGET_DIR);`],
    { cwd: elsewhere, env: { ...process.env, HOME: elsewhere, XDG_STATE_HOME: elsewhere }, stdio: ['ignore', 'pipe', 'inherit'] });
  let printed = '';
  child.stdout.on('data', chunk => { printed += chunk; });
  await once(child, 'exit');
  assert.equal(printed, BUDGET_DIR);
});

test('a fixed location that was never authorized refuses; a state that existed and vanished refuses differently', async () => {
  await assert.rejects(openRunBudget({ dir: join(await budgetDir(), 'absent'), profile: HOME_SMOKE.name }), refusal('not-authorized'));
  await assert.rejects(openRunBudget({ dir: await budgetDir(), profile: HOME_SMOKE.name }), refusal('not-authorized'));
  const vanished = await budgetDir();
  await authorizeRun({ dir: vanished, profile: HOME_SMOKE, reason: 'mock-only test' });
  await unlink(join(vanished, 'state.json'));
  await assert.rejects(openRunBudget({ dir: vanished, profile: HOME_SMOKE.name }), refusal('state-missing'));
  await assert.rejects(authorizeRun({ dir: vanished, profile: HOME_SMOKE, reason: 'again' }), refusal('state-missing'));
  const unledgered = await budgetDir();
  await authorizeRun({ dir: unledgered, profile: HOME_SMOKE, reason: 'mock-only test' });
  await unlink(join(unledgered, 'ledger.jsonl'));
  await assert.rejects(openRunBudget({ dir: unledgered, profile: HOME_SMOKE.name }), refusal('ledger-missing'));
});

test('only an explicit authorization with a reason starts a run, and it is recorded in the ledger', async () => {
  const dir = await budgetDir();
  await assert.rejects(authorizeRun({ dir, profile: HOME_SMOKE, reason: '' }), refusal('reason-required'));
  await assert.rejects(authorizeRun({ dir, profile: 'wide-open', reason: 'x' }), refusal('profile-unknown'));
  const first = await authorizeRun({ dir, profile: 'home-smoke', reason: 'Joe approved one Home smoke' });
  assert.equal(first.profile, 'home-smoke.v1');
  await assert.rejects(authorizeRun({ dir, profile: HOME_SMOKE, reason: 'stack another' }), refusal('run-active'));
  const budget = await openRunBudget({ dir, profile: HOME_SMOKE.name });
  assert.equal(budget.runId, first.run_id);
  await budget.finish({ schema: 'home-smoke-receipt.v1' });
  await assert.rejects(openRunBudget({ dir, profile: HOME_SMOKE.name }), refusal('stopped'));
  const second = await authorizeRun({ dir, profile: SWEEP_EXPLORE, reason: 'Joe approved one sweep' });
  assert.notEqual(second.run_id, first.run_id);
  const authorizations = (await readLedger(dir)).filter(entry => entry.type === 'authorized');
  assert.deepEqual(authorizations.map(entry => [entry.run_id, entry.profile.name, entry.reason]),
    [[first.run_id, 'home-smoke.v1', 'Joe approved one Home smoke'], [second.run_id, 'sweep-explore.v1', 'Joe approved one sweep']]);
  await assert.rejects(openRunBudget({ dir, profile: HOME_SMOKE.name }), refusal('profile-mismatch'));
});

test('the tamper key is private, generated once, and never printed', async () => {
  const dir = await budgetDir();
  const result = await authorizeRun({ dir, profile: HOME_SMOKE, reason: 'mock-only test' });
  const key = await readFile(join(dir, 'key'), 'utf8');
  assert.equal((await stat(join(dir, 'key'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const summary = describeAuthorization(result) + JSON.stringify(result);
  assert.equal(summary.includes(key.trim()), false);
  const budget = await openRunBudget({ dir, profile: HOME_SMOKE.name });
  await budget.finish({ schema: 'home-smoke-receipt.v1' });
  await authorizeRun({ dir, profile: HOME_SMOKE, reason: 'second run' });
  assert.equal(await readFile(join(dir, 'key'), 'utf8'), key, 'the key is generated once');
});

test('the CLI accepts only authorize --profile --reason and stop', () => {
  assert.deepEqual(parseBudgetCommand(['authorize', '--profile', 'sweep-explore', '--reason', 'Joe 2026-10-08']),
    { command: 'authorize', profile: 'sweep-explore', reason: 'Joe 2026-10-08' });
  assert.deepEqual(parseBudgetCommand(['stop', 'cost', 'hold']), { command: 'stop', reason: 'cost hold' });
  for (const argv of [[], ['reset'], ['authorize', '--profile', 'home-smoke'], ['authorize', '--reason', 'x'],
    ['authorize', '--profile', 'home-smoke', '--reason', 'x', '--http', '999'], ['authorize', '--profile', 'home-smoke', '--reason', 'x', '--dir', '/tmp/fresh']])
    assert.throws(() => parseBudgetCommand(argv), refusal('arguments-refused'));
});

test('a bad MAC, a missing key, an edited ledger or counters that went backwards all refuse', async () => {
  const run = async () => {
    const dir = await budgetDir();
    const budget = await createRunBudget({ dir });
    for (let index = 0; index < 3; index++) await budget.dispatch('http', async () => 'stub');
    await budget.close();
    return dir;
  };
  const edited = await run();
  const state = await readState(edited);
  state.profile.http = 10_000;
  await writeFile(join(edited, 'state.json'), JSON.stringify(state));
  await assert.rejects(resumeRunBudget({ dir: edited }), refusal('state-tampered'));
  await assert.rejects(authorizeRun({ dir: edited, profile: HOME_SMOKE, reason: 'over a tampered run' }), refusal('state-tampered'));

  const keyless = await run();
  await unlink(join(keyless, 'key'));
  await assert.rejects(resumeRunBudget({ dir: keyless }), refusal('key-missing'));

  const rewritten = await run();
  const lines = (await readFile(join(rewritten, 'ledger.jsonl'), 'utf8')).split('\n');
  lines[0] = lines[0].replace('mock-only test', 'mock-only tesT');
  await writeFile(join(rewritten, 'ledger.jsonl'), lines.join('\n'));
  await assert.rejects(resumeRunBudget({ dir: rewritten }), refusal('ledger-tampered'));

  // Even a correctly re-signed state cannot spend less than the ledger recorded.
  const rolledBack = await run();
  const key = (await readFile(join(rolledBack, 'key'), 'utf8')).trim();
  const lowered = await readState(rolledBack);
  delete lowered.mac;
  lowered.spent.http = 0;
  lowered.mac = createHmac('sha256', Buffer.from(key, 'hex')).update(canonicalJSON(lowered)).digest('hex');
  await writeFile(join(rolledBack, 'state.json'), JSON.stringify(lowered));
  await assert.rejects(resumeRunBudget({ dir: rolledBack }), refusal('counter-regressed'));
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

test('exploration refuses before the provider adapter or any setup loads unless sweep-explore is authorized', async () => {
  let loaded = 0, setup = 0;
  const stubs = { loadExplorer: async () => { loaded++; }, prepareRecords: async () => { setup++; }, host: clearHost };
  await assert.rejects(exploreAll({ ...stubs, budgetDir: await budgetDir() }), refusal('not-authorized'));
  const home = await budgetDir();
  await authorizeRun({ dir: home, profile: HOME_SMOKE, reason: 'mock-only test' });
  await assert.rejects(exploreAll({ ...stubs, budgetDir: home }), refusal('profile-mismatch'));
  assert.deepEqual([loaded, setup], [0, 0]);
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  await assert.rejects(budget.reserve('model'), refusal('model-exhausted'));
  assert.equal((await readState(dir)).stopped.reason, 'model-exhausted');
  await budget.close();
});

test('the sweep refuses before setup unless sweep-explore is authorized, and the Home route refuses every write', async () => {
  let setup = 0;
  await assert.rejects(sweep({ budgetDir: await budgetDir(), host: clearHost, prepareRecords: async () => { setup++; } }), refusal('not-authorized'));
  const homeOnly = await budgetDir();
  await authorizeRun({ dir: homeOnly, profile: HOME_SMOKE, reason: 'mock-only test' });
  await assert.rejects(sweep({ budgetDir: homeOnly, host: clearHost, prepareRecords: async () => { setup++; } }), refusal('profile-mismatch'));
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

test('an authorized sweep runs past setup through a routed control and a completed receipt', async () => {
  const dir = await budgetDir();
  const output = await budgetDir();
  await authorizeRun({ dir, profile: SWEEP_EXPLORE, reason: 'mock-only test' });
  const target = { name: 'staging-live', surface: 'app', viewport: { width: 800, height: 600 } };
  const screen = { path: '/', name: 'Mock Home', surface: 'app' };
  let loadedScreens = 0, setup = 0, sessions = 0, releaseChecks = 0, routed = 0, contexts = 0, controls = 0;
  let currentURL = STAGING_ORIGIN;
  const context = {
    routeWebSocket: async () => { routed++; },
    route: async () => { routed++; },
    addInitScript: async () => { routed++; },
    newPage: async () => ({
      goto: async url => { currentURL = url; return { ok: () => true }; },
      waitForLoadState: async () => {},
      url: () => currentURL,
      context: () => context,
    }),
    close: async () => {},
  };
  const browser = { newContext: async () => { contexts++; return context; }, close: async () => {} };
  const runtime = {
    targets: [target],
    screens: async () => { loadedScreens++; return [screen]; },
    session: async (origin, { budget }) => {
      sessions++;
      assert.equal(origin, STAGING_ORIGIN);
      return budget.dispatch('preflight', async () => ({ release, state: { cookies: [], origins: [] } }));
    },
    checkRelease: async budget => {
      releaseChecks++;
      return budget.dispatch('http', async () => release);
    },
    sweepScreen: async ({ freshPage, screen: planned, target: targetName }) => {
      controls++;
      const page = await freshPage();
      assert.equal(page.url(), STAGING_ORIGIN + '/');
      await page.context().close();
      return {
        ...planned, target: targetName, reached: true,
        controls: [{
          target: targetName, path: planned.path, screen: planned.name,
          key: `${targetName}/${planned.path}/0123456789abcdef`, status: 'OBSERVED', selector: '#mock-control',
          openers: [], signals: ['main DOM mutation'], evidence_path: 'mock/observed.png',
        }],
      };
    },
    sweepOwnerStates: async ({ run }) => run.snapshot().stateObligations,
    readAllowlist: async () => [],
  };
  const receipt = await sweep({
    budgetDir: dir, output, host: clearHost, runtime, launch: async () => browser,
    prepareRecords: async () => {
      setup++;
      assert.equal(loadedScreens, 1, 'the injected mock runtime must be active before setup');
      return { release, complete: true, records: {}, needs_restore: [], findings: [] };
    },
  });
  assert.equal(receipt.qualified, true);
  assert.deepEqual([loadedScreens, setup, sessions, releaseChecks, routed, contexts, controls], [1, 1, 1, 1, 3, 1, 1]);
  const state = await readState(dir);
  assert.deepEqual([state.spent.target, state.spent.viewport, state.spent.context, state.spent.preflight, state.spent.http], [1, 1, 1, 1, 2]);
  assert.equal(state.stopped.reason, 'completed');
});

function capturedRouteContext() {
  const captured = { websocket: null, route: null };
  return {
    captured,
    routeWebSocket: async (_matches, handle) => { captured.websocket = handle; },
    route: async (_matches, handle) => { captured.route = handle; },
    addInitScript: async () => {},
  };
}

function stubRouteRequest({ url, method = 'GET', body } = {}) {
  return {
    url: () => url,
    method: () => method,
    postDataJSON: () => body,
    postDataBuffer: () => body === undefined ? null : Buffer.from(JSON.stringify(body)),
    allHeaders: async () => body === undefined ? {} : { 'content-type': 'application/json' },
  };
}

function stubRouteBudget({ mutation = 0, fixtureIds = new Set() } = {}) {
  const calls = { dispatch: 0, stops: [] };
  return {
    calls, fixtureIds, profile: { mutation },
    dispatch: async (_kind, send) => { calls.dispatch++; return send(new AbortController().signal); },
    stop: async reason => { calls.stops.push(reason); },
  };
}

test('the budgeted route registers a WebSocket guard and closes the socket without a browser', async () => {
  const context = capturedRouteContext();
  await installBudgetedRoute(context, stubRouteBudget());
  assert.equal(typeof context.captured.websocket, 'function');
  let closed = 0;
  context.captured.websocket({ close: () => { closed++; } });
  assert.equal(closed, 1);
});

test('the budgeted route aborts a disallowed origin without dispatching', async () => {
  const context = capturedRouteContext();
  const budget = stubRouteBudget();
  await installBudgetedRoute(context, budget, {
    allowed: url => url.origin === 'https://allowed.example',
    transport: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
  });
  let aborted = 0, fulfilled = 0;
  await context.captured.route({
    request: () => stubRouteRequest({ url: 'https://blocked.example/read' }),
    abort: async () => { aborted++; },
    fulfill: async () => { fulfilled++; },
  });
  assert.deepEqual([aborted, fulfilled, budget.calls.dispatch], [1, 0, 0]);
});

test('the streaming transport dead-ends redirects and enforces declared, streamed, and total byte limits', async () => {
  const home = await loopbackHome();
  const context = { cookies: async () => [] };
  const request = path => stubRouteRequest({ url: home.origin + path });
  const send = (path, budget) => streamingFetch(context, request(path), budget, new AbortController().signal);
  try {
    const redirect = await createRunBudget({ dir: await budgetDir(), profile: HOME_SMOKE });
    const redirected = await send('/redirect', redirect);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.location, undefined);
    assert.deepEqual(home.hits, ['GET /redirect']);
    await redirect.close();

    const declared = await createRunBudget({ dir: await budgetDir(), profile: tiny({ responseBytes: 64 * 1024 }) });
    let readers = 0;
    await assert.rejects(readMetered({
      headers: { get: () => String(200 * 1024) },
      body: { getReader: () => { readers++; return { read: async () => ({ done: true }), cancel: async () => {} }; } },
    }, declared.ingressMeter()), refusal('response-oversize'));
    assert.equal(readers, 0, 'a declared oversize refuses before the body reader opens');
    await declared.close();

    for (const path of ['/declared-large', '/streamed-large']) {
      const limited = await createRunBudget({ dir: await budgetDir(), profile: tiny({ responseBytes: 64 * 1024 }) });
      await assert.rejects(send(path, limited), refusal('response-oversize'));
      await limited.close();
    }

    const coalescedDir = await budgetDir();
    const coalesced = await createRunBudget({ dir: coalescedDir, profile: tiny({ responseBytes: 64 * 1024 }) });
    let read = false;
    await assert.rejects(readMetered({
      headers: { get: () => null },
      body: { getReader: () => ({
        read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.alloc(80 * 1024) }),
        cancel: async () => {},
      }) },
    }, coalesced.ingressMeter()), refusal('response-oversize'));
    assert.equal((await readState(coalescedDir)).spent.ingress, 64 * 1024,
      'the bounded portion of a coalesced chunk that already arrived is charged');
    await coalesced.close();

    const total = await createRunBudget({ dir: await budgetDir(), profile: tiny({ ingress: 64 * 1024, responseBytes: 64 * 1024 }) });
    const first = total.ingressMeter();
    await first.take(40 * 1024);
    await first.settle();
    const second = total.ingressMeter();
    await second.take(20 * 1024);
    await assert.rejects(second.take(8 * 1024), refusal('ingress-exhausted'));
    await second.settle().catch(() => {});
    await total.close();
  } finally { await home.close(); }
});

test('a dispatch does not surface a response stop before arrived ingress is durable', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ responseBytes: 64 * 1024 }) });
  let read = false;
  const response = {
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.alloc(80 * 1024) }),
      cancel: async () => {},
    }) },
  };

  await assert.rejects(
    budget.dispatch('http', () => readMetered(response, budget.ingressMeter())),
    refusal('response-oversize'),
  );
  assert.equal((await readState(dir)).spent.ingress, 64 * 1024);
  await budget.close();
});

test('the budgeted route refuses an untagged write without dispatching', async () => {
  const context = capturedRouteContext();
  const fixtureId = '11111111-1111-4111-8111-111111111111';
  const budget = stubRouteBudget({ mutation: 2, fixtureIds: new Set([fixtureId]) });
  await installBudgetedRoute(context, budget, {
    allowed: url => url.origin === 'https://allowed.example',
    transport: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
  });
  let aborted = 0, fulfilled = 0;
  await context.captured.route({
    request: () => stubRouteRequest({
      url: 'https://allowed.example/mcp', method: 'POST',
      body: { method: 'tools/call', params: { name: 'update-deal', arguments: { id: '22222222-2222-4222-8222-222222222222' } } },
    }),
    abort: async () => { aborted++; },
    fulfill: async () => { fulfilled++; },
  });
  assert.deepEqual([aborted, fulfilled, budget.calls.dispatch], [1, 0, 0]);
  assert.deepEqual(budget.calls.stops, ['mutation-untagged']);
});

// A routed page under one budget, for the ingress tests below.
async function routedPage(home, budget, options = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await installBudgetedRoute(context, budget, { allowed: home.allowed, ...options });
  const page = await context.newPage();
  await page.goto(home.origin + '/');
  await page.waitForLoadState('networkidle');
  return { browser, page };
}

test('a WebSocket is closed before connecting, although the server really accepts upgrades', async () => {
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const { browser, page } = await routedPage(home, budget, { allowed: url => url.host === new URL(home.origin).host });
  try {
    const before = (await readState(dir)).spent.http;
    const result = await page.evaluate(origin => new Promise(resolve => {
      const socket = new WebSocket(origin.replace('http', 'ws') + '/socket');
      socket.onopen = () => resolve('open');
      socket.onclose = () => resolve('closed');
      socket.onerror = () => resolve('closed');
      setTimeout(() => resolve('pending'), 3000);
    }), home.origin);
    assert.equal(result, 'closed');
    assert.equal(home.upgrades(), 0, 'no upgrade request reached the server');
    assert.equal((await readState(dir)).spent.http, before);
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('a request to a disallowed origin is aborted locally and never opens a connection', async () => {
  const home = await loopbackHome();
  const other = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const { browser, page } = await routedPage(home, budget);
  try {
    const before = (await readState(dir)).spent.http;
    const result = await page.evaluate(url => Promise.race([
      fetch(url).then(response => 'answered ' + response.status, () => 'refused'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
    ]), other.origin + '/elsewhere');
    assert.equal(result, 'refused');
    assert.equal(other.connections(), 0, 'no connection reached the disallowed port');
    assert.equal((await readState(dir)).spent.http, before);
  } finally { await browser.close(); await budget.close(); await home.close(); await other.close(); }
});

// Chromium follows a fulfilled redirect without routing the next hop, so a
// followed hop would be uncharged and never checked against the allowlist.
test('a redirect is never followed, by the transport or by the browser: its target is neither sent nor charged', async () => {
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const { browser, page } = await routedPage(home, budget);
  try {
    const before = (await readState(dir)).spent.http;
    const hitsBefore = home.hits.length;
    const status = await page.evaluate(() => fetch('/redirect').then(response => response.status, () => 'refused'));
    assert.equal(status, 302);
    const navigation = await page.goto(home.origin + '/redirect');
    assert.equal(navigation.status(), 302);
    assert.equal(new URL(page.url()).pathname, '/redirect');
    assert.deepEqual(home.hits.slice(hitsBefore), ['GET /redirect', 'GET /redirect'], 'the redirect target was never requested');
    assert.equal((await readState(dir)).spent.http - before, home.hits.length - hitsBefore, 'every request that reached the server was charged');
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('response bytes are capped per response by declared length and by streamed size, and in total', async () => {
  const home = await loopbackHome();
  // A declared oversize is refused before any body byte is read; an
  // undeclared one is cut off as it streams, and what arrived is charged.
  for (const [path, charged] of [['/declared-large', delta => delta === 0], ['/streamed-large', delta => delta > 0 && delta <= 64 * 1024]]) {
    const dir = await budgetDir();
    const budget = await createRunBudget({ dir, profile: tiny({ responseBytes: 64 * 1024 }) });
    const { browser, page } = await routedPage(home, budget);
    try {
      const before = (await readState(dir)).spent.ingress;
      const result = await page.evaluate(path => fetch(path).then(response => response.arrayBuffer()).then(body => body.byteLength, () => 'refused'), path);
      assert.equal(result, 'refused');
      const state = await readState(dir);
      assert.equal(state.stopped.reason, 'response-oversize');
      assert.ok(charged(state.spent.ingress - before), `${path} charged ${state.spent.ingress - before}`);
    } finally { await browser.close(); await budget.close(); }
  }
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ ingress: 64 * 1024 }) });
  const { browser, page } = await routedPage(home, budget);
  try {
    const sizes = await page.evaluate(async () => {
      const out = [];
      for (let index = 0; index < 3; index++) out.push(await fetch('/kilobytes?size=40&n=' + index).then(response => response.arrayBuffer()).then(body => body.byteLength, () => 'refused'));
      return out;
    });
    assert.deepEqual(sizes, [40 * 1024, 'refused', 'refused']);
    const state = await readState(dir);
    assert.equal(state.stopped.reason, 'ingress-exhausted');
    assert.ok(state.spent.ingress <= 64 * 1024);
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('preflight responses are charged as ingress and an oversized one refuses', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  const fake = fakePreflight();
  await smokeSession(budget, fake)();
  assert.ok((await readState(dir)).spent.ingress > 0);
  await budget.close();
  const big = await budgetDir();
  const oversized = await createRunBudget({ dir: big, profile: HOME_SMOKE });
  await assert.rejects(smokeSession(oversized, fakePreflight({ declared: { '/app-release': 11 * MiB } }))(), refusal('response-oversize'));
  assert.equal((await readState(big)).stopped.reason, 'response-oversize');
  await oversized.close();
});

test('staging font hosts are refused like any other third party', () => {
  for (const url of ['https://fonts.googleapis.com/css2?family=Inter', 'https://fonts.gstatic.com/s/inter.woff2', 'https://example.com/'])
    assert.equal(stagingRequestAllowed(new URL(url)), false, url);
  assert.equal(stagingRequestAllowed(new URL(STAGING_ORIGIN + '/app.js')), true);
});

test('a STOP placed while the poll cannot run is still honored by the next reservation', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock: fakeClock() });
  await requestOperatorStop(dir, 'held before poll');
  let sent = 0;
  await assert.rejects(budget.dispatch('http', async () => ++sent), refusal('operator-stop'));
  assert.equal(sent, 0);
  assert.equal((await readState(dir)).stopped.reason, 'operator-stop');
  await budget.close();
});

test('a stop still aborts when the disk refuses to record it, and a timer stop never rejects unhandled', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  await chmod(dir, 0o500);
  try {
    await assert.rejects(budget.stop('disk-check'), error => error.code === 'EACCES');
    assert.equal(budget.signal.aborted, true);
  } finally { await chmod(dir, 0o700); }
  await budget.close();
  const second = await budgetDir();
  const timed = await createRunBudget({ dir: second, profile: HOME_SMOKE, clock });
  await chmod(second, 0o500);
  try {
    await clock.advance(HOME_SMOKE.deadlineMs);
    assert.equal(timed.signal.aborted, true);
  } finally { await chmod(second, 0o700); }
  await timed.close();
});

test('live staging targets refuse outside a sweep-explore budget, and so does the e2e config', async () => {
  setActiveBudget(null);
  assert.throws(() => stagingTargets(), refusal('staging-not-budgeted'));
  const home = await createRunBudget({ dir: await budgetDir(), profile: HOME_SMOKE });
  setActiveBudget(home);
  try { assert.throws(() => stagingTargets(), refusal('staging-not-budgeted')); }
  finally { setActiveBudget(null); await home.close(); }
  const sweepBudget = await createRunBudget({ dir: await budgetDir(), profile: SWEEP_EXPLORE });
  setActiveBudget(sweepBudget);
  try { assert.equal(stagingTargets().length, 4); }
  finally { setActiveBudget(null); await sweepBudget.close(); }
  const config = new URL('../../e2e.config.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(config)});`],
    { cwd: new URL('../../', import.meta.url), env: { ...process.env, E2E_TARGET: 'staging-live' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(stderr, /staging-not-budgeted/);
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
  while (!answer) await new Promise(resolve => setImmediate(resolve));
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
    const stored = JSON.parse(await readFile(join(dir, 'evidence', budget.runId, 'home-smoke-receipt.json'), 'utf8'));
    assert.equal(stored.stopped.reason, 'deadline');
    assert.ok((await stat(join(dir, 'evidence', budget.runId, 'home-smoke-receipt.json'))).size < 64 * 1024);
  } finally { await browser.close(); await home.close(); }
});

test('global expiry during reporting keeps only the bounded stop receipt', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  await clock.advance(HOME_SMOKE.deadlineMs);
  await assert.rejects(budget.writeEvidence('late-report.json', '{}'), refusal('stopped'));
  await budget.finish({ schema: 'home-smoke-receipt.v1', qualified: true });
  const receipt = JSON.parse(await readFile(join(dir, 'evidence', budget.runId, 'home-smoke-receipt.json'), 'utf8'));
  assert.equal(receipt.qualified, false, 'a stopped run can never report qualified coverage');
  assert.deepEqual(await readdir(join(dir, 'evidence', budget.runId)), ['home-smoke-receipt.json']);
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
  await authorizeRun({ dir, profile: HOME_SMOKE, reason: 'mock-only test' });
  const module = new URL('../../scripts/e2e-staging/run-budget.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { openRunBudget } = await import(${JSON.stringify(module)});
    const budget = await openRunBudget({ dir: ${JSON.stringify(dir)}, profile: 'home-smoke.v1' });
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
  // Only a new explicit authorization starts again, under a new run id.
  const next = await authorizeRun({ dir, profile: HOME_SMOKE, reason: 'reviewed reauthorization' });
  assert.notEqual(next.run_id, before.run_id);
});

test('corrupt durable state fails closed before any dispatch', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir });
  await budget.close();
  await writeFile(join(dir, 'state.json'), '{"schema":"e2e-run-budget.v2","spent":');
  await assert.rejects(resumeRunBudget({ dir }), refusal('state-corrupt'));
  await assert.rejects(authorizeRun({ dir, profile: HOME_SMOKE, reason: 'over corrupt state' }), refusal('state-corrupt'));
});

test('an operator stop works during flight, persists, and survives a restart', async () => {
  const dir = await budgetDir();
  const clock = fakeClock();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE, clock });
  let answer;
  const inflight = budget.dispatch('http', () => new Promise(resolve => { answer = resolve; }));
  while (!answer) await new Promise(resolve => setImmediate(resolve));
  await requestOperatorStop(dir, 'cost hold');
  await clock.advance(250);
  answer('late');
  await assert.rejects(inflight, refusal('operator-stop'));
  assert.equal((await readState(dir)).stopped.reason, 'operator-stop');
  await budget.close();
  await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  // A hold is equally binding before a run is authorized, and authorization cannot clear it.
  const held = await budgetDir();
  await requestOperatorStop(held, 'hold before start');
  await assert.rejects(authorizeRun({ dir: held, profile: HOME_SMOKE, reason: 'try anyway' }), refusal('operator-stop'));
  await assert.rejects(authorizeRun({ dir, profile: HOME_SMOKE, reason: 'try anyway' }), refusal('operator-stop'));
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
  Object.assign(process.env, { E2E_RUN_BUDGET_RESET: '1', E2E_RUN_ID: 'fresh', E2E_HTTP_LIMIT: '100000', CI: '1', HOME: await budgetDir() });
  try {
    await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
    await assert.rejects(openRunBudget({ dir, profile: SWEEP_EXPLORE.name }), refusal('stopped'));
  } finally { process.env = saved; }
  for (const file of ['run-budget.mjs', 'home-smoke.mjs', 'budgeted-route.mjs', 'budgeted-model.mjs']) {
    const source = await readFile(new URL('../../scripts/e2e-staging/' + file, import.meta.url), 'utf8');
    assert.equal(/process\.env/.test(source), false, `${file} must not read the environment`);
  }
});

test('profiles are tighten-only against their own approved base', async () => {
  for (const looser of [{ http: 401 }, { model: 21 }, { modelOutputTokens: 4097 }, { modelTimeoutMs: 60_001 }, { mutation: 26 }, { deadlineMs: 600_001 }, { byte: 51 * MiB }, { trace: true }])
    await assert.rejects(authorizeRun({ dir: await budgetDir(), profile: tinySweep(looser), reason: 'x' }), refusal('profile-exceeds-approved'));
  const tight = await authorizeRun({ dir: await budgetDir(), profile: tinySweep({ http: 10, model: 1 }), reason: 'x' });
  assert.equal(tight.profile, 'sweep-explore.v1');
  // Relabelling the wider profile as the narrower one loosens it, so it refuses.
  await assert.rejects(authorizeRun({ dir: await budgetDir(), profile: { ...SWEEP_EXPLORE, name: 'home-smoke.v1' }, reason: 'x' }), refusal('profile-exceeds-approved'));
});

test('every model call is charged, bounded to 4k output tokens and a hard timeout, and refused without a sweep-explore budget', async () => {
  const calls = [];
  const inner = {
    specificationVersion: 'v4', provider: 'stub', modelId: 'stub-model', supportedUrls: {},
    doGenerate: async options => { calls.push(options); return { content: [], finishReason: 'stop', usage: {} }; },
    doStream: async options => { calls.push(options); return { stream: new ReadableStream() }; },
  };
  const model = budgetedModel(inner);
  assert.equal(model.modelId, 'stub-model');
  setActiveBudget(null);
  await assert.rejects(model.doGenerate({ prompt: [] }), refusal('model-not-budgeted'));
  const home = await createRunBudget({ dir: await budgetDir() });
  setActiveBudget(home);
  await assert.rejects(model.doGenerate({ prompt: [] }), refusal('model-exhausted'));
  assert.equal(calls.length, 0);
  const budget = await createRunBudget({ dir: await budgetDir(), profile: tinySweep({ model: 3, modelTimeoutMs: 50 }) });
  setActiveBudget(budget);
  try {
    await model.doGenerate({ prompt: [], maxOutputTokens: 100_000 });
    await model.doStream({ prompt: [] });
    assert.deepEqual(calls.map(call => call.maxOutputTokens), [4096, 4096]);
    assert.ok(calls.every(call => call.abortSignal instanceof AbortSignal));
    const hung = budgetedModel({ ...inner, doGenerate: () => new Promise(() => {}) });
    await assert.rejects(hung.doGenerate({ prompt: [] }), refusal('model-timeout'));
    await assert.rejects(model.doGenerate({ prompt: [] }), refusal('model-exhausted'));
    assert.equal(calls.length, 2, 'the refused fourth call never reached the provider');
    assert.equal(budget.spent.model, 3);
  } finally { setActiveBudget(null); }
});

test('a hung model call keeps the process alive until its hard timeout fires', async () => {
  const dir = await budgetDir();
  const profile = tinySweep({ model: 1, modelTimeoutMs: 50 });
  await authorizeRun({ dir, profile, reason: 'mock-only timeout proof' });
  const budgetModule = new URL('../../scripts/e2e-staging/run-budget.mjs', import.meta.url).href;
  const modelModule = new URL('../../scripts/e2e-staging/budgeted-model.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { openRunBudget, setActiveBudget } = await import(${JSON.stringify(budgetModule)});
    const { budgetedModel } = await import(${JSON.stringify(modelModule)});
    const budget = await openRunBudget({ dir: ${JSON.stringify(dir)}, profile: 'sweep-explore.v1' });
    setActiveBudget(budget);
    const model = budgetedModel({ modelId: 'hung', doGenerate: () => new Promise(() => {}) });
    try { await model.doGenerate({ prompt: [] }); }
    catch (error) { process.stdout.write(error.code); }
    finally { setActiveBudget(null); await budget.close(); }`],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'model-timeout');
});

test('the sweep-explore route forwards a charged write only for a fixture-tagged record and stops on any other write', async () => {
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tinySweep({ mutation: 2 }) });
  const fixtureId = '11111111-1111-4111-8111-111111111111';
  const browser = await chromium.launch();
  const write = (name, args) => fetch => fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) });
  try {
    const context = await browser.newContext();
    await installBudgetedRoute(context, budget, { allowed: home.allowed, fixtureIds: new Set([fixtureId]) });
    const page = await context.newPage();
    await page.goto(home.origin + '/');
    const send = (name, args) => page.evaluate(([name, args]) => fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) }).then(response => response.status, () => 'refused'), [name, args]);
    assert.equal(await send('update-deal', { deal: fixtureId, fields: { phase: 'parked' } }), 200);
    assert.equal((await readState(dir)).spent.mutation, 1);
    assert.equal(await send('claim-lead', { lead: '22222222-2222-4222-8222-222222222222' }), 'refused');
    assert.equal(home.hits.filter(hit => hit === 'POST /mcp').length, 1);
    assert.equal((await readState(dir)).stopped.reason, 'mutation-untagged');
    void write;
    await context.close();
  } finally { await browser.close(); await budget.close(); await home.close(); }
});

test('the mutation cap refuses the write after the twenty-fifth without sending it', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: SWEEP_EXPLORE });
  let sent = 0;
  for (let index = 0; index < 25; index++) await budget.dispatch('mutation', async () => ++sent);
  await assert.rejects(budget.dispatch('mutation', async () => ++sent), refusal('mutation-exhausted'));
  assert.equal(sent, 25);
  assert.deepEqual([budget.spent.mutation, budget.spent.http], [25, 25]);
  await budget.close();
});

test('fixture cleanup is charged, and a failed cleanup stops the run with a receipt naming what was left behind', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: SWEEP_EXPLORE });
  const created = [{ record: 'tour', id: 't1' }, { record: 'conversation', id: 'c1' }, { record: 'lead', id: 'l1' }];
  const removed = [];
  const remove = async entry => { if (entry.record === 'conversation') throw new Error('staging refused'); removed.push(entry.id); };
  await assert.rejects(cleanupStagingRecords({ budget, created, remove }), refusal('cleanup-failed'));
  assert.deepEqual(removed, ['t1']);
  const receipt = JSON.parse(await readFile(join(dir, 'evidence', budget.runId, 'sweep-explore-receipt.json'), 'utf8'));
  assert.equal(receipt.stopped.reason, 'cleanup-failed');
  assert.deepEqual(receipt.left_behind.map(entry => entry.id), ['c1', 'l1']);
  assert.equal((await readState(dir)).spent.mutation, 2, 'the successful and the failed removal were both charged');

  const clean = await createRunBudget({ dir: await budgetDir(), profile: SWEEP_EXPLORE });
  assert.deepEqual(await cleanupStagingRecords({ budget: clean, created, remove: async () => {} }), { removed: ['t1', 'c1', 'l1'], left_behind: [] });
  assert.equal(clean.spent.mutation, 3);
  await clean.close();
});

test('fresh fixture creation refuses before any request while a record kind has no pinned removal verb', async () => {
  assert.deepEqual(Object.keys(REMOVAL_VERBS), []);
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: SWEEP_EXPLORE });
  let sessions = 0, requests = 0;
  const output = await budgetDir();
  await assert.rejects(prepareStagingRecords(output, { budget, session: async () => { sessions++; }, requestFactory: async () => { requests++; } }), refusal('cleanup-unavailable'));
  assert.deepEqual([sessions, requests, budget.spent.mutation, budget.spent.fixture], [0, 0, 0, 0]);
  await budget.close();
});

test('setup requests through the default transport refuse without a budget', async () => {
  await assert.rejects(prepareStagingRecords(await budgetDir(), { session: async () => ({}) }), refusal('http-not-budgeted'));
});

// F1: a crowded host refuses before the authorization is opened, so the run
// is not burned; the refusal leaves its own receipt and the run can start later.
const assertUnspentAfterRefusal = async (dir, profile, cause) => {
  const state = await readState(dir);
  assert.deepEqual([state.started_at, state.stopped], [null, null]);
  assert.ok(Object.values(state.spent).every(value => value === 0));
  const refusals = await readdir(join(dir, 'refusals'));
  assert.equal(refusals.length, 1);
  const receipt = JSON.parse(await readFile(join(dir, 'refusals', refusals[0]), 'utf8'));
  assert.deepEqual([receipt.code, receipt.cause, receipt.run_id, receipt.profile], ['local_model_resident', cause, state.run_id, profile]);
  const later = await openRunBudget({ dir, profile });
  assert.equal(later.runId, state.run_id);
  await later.close();
};

test('the host-headroom guard applies to the sweep and the exploration before any setup and burns no authorization', async () => {
  for (const entry of [sweep, exploreAll]) {
    const dir = await budgetDir();
    await authorizeRun({ dir, profile: SWEEP_EXPLORE, reason: 'mock-only test' });
    let setup = 0, loaded = 0;
    await assert.rejects(entry({ budgetDir: dir, host: crowdedHost, prepareRecords: async () => { setup++; }, loadExplorer: async () => { loaded++; } }), refusal('local_model_resident'));
    assert.deepEqual([setup, loaded], [0, 0]);
    await assertUnspentAfterRefusal(dir, SWEEP_EXPLORE.name, 'local-model-port-listening');
  }
});

test('the Home smoke entry checks host headroom before opening the authorization', async () => {
  for (const [host, cause] of [[crowdedHost, 'local-model-port-listening'],
    [{ portOpen: async () => 'timeout', freeInactiveBytes: async () => 40 * GiB }, 'local-model-probe-timeout'],
    [{ portOpen: async () => false, freeInactiveBytes: async () => 8 * GiB }, 'memory-below-floor']]) {
    const dir = await budgetDir();
    await authorizeRun({ dir, profile: HOME_SMOKE, reason: 'mock-only test' });
    let launched = 0;
    await assert.rejects(runHomeSmoke({ dir, host, launch: async () => { launched++; } }), refusal('local_model_resident'));
    assert.equal(launched, 0);
    await assertUnspentAfterRefusal(dir, HOME_SMOKE.name, cause);
  }
  await assert.rejects(runHomeSmoke({ dir: await budgetDir(), host: crowdedHost, launch: async () => assert.fail('no launch') }), refusal('not-authorized'));
});

test('an exploration goal that ends incomplete stops scheduling at once, with trace and AI trace off', async () => {
  const dir = await budgetDir();
  await authorizeRun({ dir, profile: SWEEP_EXPLORE, reason: 'mock-only test' });
  const output = await budgetDir();
  const goals = [];
  const explore = async options => {
    goals.push(options);
    await mkdir(join(options.cwd, options.output), { recursive: true });
    await writeFile(join(options.cwd, options.output, 'report.json'), JSON.stringify({ artifacts: [] }));
    return { explore: { steps: [], ended: 'time', findings: [] } };
  };
  await assert.rejects(exploreAll({ budgetDir: dir, host: clearHost, output, loadExplorer: async () => explore, checkRelease: async () => release,
    prepareRecords: async () => ({ release, records: {}, needs_restore: [], findings: [] }) }), refusal('exploration-time'));
  assert.equal(goals.length, 1);
  assert.deepEqual([goals[0].trace, goals[0].aiTrace, goals[0].video], ['off', false, 'off']);
  assert.ok(goals[0].timeoutMs <= SWEEP_EXPLORE.deadlineMs);
  const state = await readState(dir);
  assert.equal(state.stopped.reason, 'exploration-time');
});

test('evidence limits refuse oversize output before writing and count copies, files and logs', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: tiny({ byte: 4096, file: 3, logByte: 64 }) });
  await budget.writeEvidence('a.json', 'x'.repeat(1000));
  await assert.rejects(budget.writeEvidence('big.json', 'x'.repeat(5000)), refusal('byte-exhausted'));
  assert.deepEqual((await readdir(join(dir, 'evidence', budget.runId))).sort(), ['a.json']);
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
  assert.deepEqual(await readdir(join(dir, 'evidence', budget.runId)).catch(() => []), []);
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
    const files = await readdir(join(dir, 'evidence', budget.runId));
    assert.deepEqual(files.sort(), ['home-desktop.jpg', 'home-phone.jpg', 'home-smoke-receipt.json']);
    assert.equal(files.some(file => /trace|video|\.zip|\.webm/.test(file)), false);
    await assert.rejects(resumeRunBudget({ dir }), refusal('stopped'));
  } finally { await browser.close(); await home.close(); }
});

test('inside an opened run, the second-line headroom check stops before any dispatch and leaves a durable stop receipt', async () => {
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
    const stored = JSON.parse(await readFile(join(dir, 'evidence', budget.runId, 'home-smoke-receipt.json'), 'utf8'));
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

test('memory is re-checked between viewports: a host that crowds mid-run never starts the next viewport', async () => {
  const home = await loopbackHome();
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  let probes = 0;
  // Clear for the opening check and the desktop viewport, crowded before the phone viewport.
  const host = { portOpen: async () => false, freeInactiveBytes: async () => (++probes >= 3 ? 4 * GiB : 40 * GiB) };
  const browser = await chromium.launch();
  try {
    const receipt = await homeSmoke({ budget, browser, origin: home.origin, allowed: home.allowed, host, session: smokeSession(budget, fakePreflight()) });
    assert.equal(receipt.qualified, false);
    assert.deepEqual(receipt.viewports.map(row => row.viewport), ['desktop']);
    assert.equal(receipt.stopped.reason, 'local_model_resident');
    assert.equal(receipt.failure.cause, 'memory-below-floor');
    assert.equal(home.hits.filter(hit => hit === 'GET /').length, 1, 'the phone viewport never started');
  } finally { await browser.close(); await home.close(); }
});

test('Home smoke rechecks headroom before opening the first viewport context', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  let probes = 0, contexts = 0;
  const host = { portOpen: async () => false, freeInactiveBytes: async () => (++probes === 1 ? 40 * GiB : 4 * GiB) };
  const browser = { newContext: async () => { contexts++; throw new Error('a crowded host must not open a context'); } };
  const receipt = await homeSmoke({ budget, browser, origin: STAGING_ORIGIN, host,
    session: async () => ({ state: { cookies: [], origins: [] } }) });
  assert.deepEqual([probes, contexts], [2, 0]);
  assert.equal(receipt.failure.cause, 'memory-below-floor');
  assert.equal(receipt.stopped.reason, 'local_model_resident');
});

test('the local model probe covers IPv4 and IPv6 loopback and treats a timeout as a refusal', async () => {
  const server = createServer(() => {});
  server.listen(0, '::1');
  server.unref();
  await once(server, 'listening');
  const { port } = server.address();
  assert.equal(await localModelPortStatus({ port }), 'open', 'a server on ::1 only is still found');
  await new Promise(resolve => server.close(resolve));
  assert.equal(await localModelPortStatus({ port }), 'closed');
  // A connect that never answers is a timeout, not "no model".
  const silent = () => { const socket = new EventEmitter(); socket.setTimeout = (ms, fn) => setTimeout(fn, ms); socket.destroy = () => {}; return socket; };
  assert.equal(await localModelPortStatus({ port, timeoutMs: 20, connect: silent }), 'timeout');
  assert.deepEqual(await localModelHeadroom({ floorBytes: GiB, probe: { portOpen: async () => 'timeout', freeInactiveBytes: async () => 40 * GiB } }),
    { cause: 'local-model-probe-timeout', port: LOCAL_MODEL_PORT });
  assert.equal(await localModelHeadroom({ floorBytes: GiB, probe: { portOpen: async () => 'closed', freeInactiveBytes: async () => 40 * GiB } }), null);
});

test('a stop that lands while the debit is being written sends nothing', async () => {
  const dir = await budgetDir();
  const budget = await createRunBudget({ dir, profile: HOME_SMOKE });
  let sent = 0;
  const pending = budget.dispatch('http', async () => ++sent);
  // The in-memory debit lands before its durable write finishes.
  while (budget.spent.http === 0) await new Promise(resolve => setImmediate(resolve));
  const stopping = budget.stop('hold during debit');
  await assert.rejects(pending, refusal('hold during debit'));
  await stopping;
  assert.equal(sent, 0);
  await budget.close();
});
