import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../../', import.meta.url));
async function consumer(t, limits, source) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-effective-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  try { execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { currentRun } from './scripts/e2e-staging/run-limits.mjs';
    const run = currentRun();
    try { ${source} } finally { run.dispose(); }
  `], { cwd: project, timeout: 15_000, killSignal: 'SIGKILL', stdio: 'pipe', env: {
    ...process.env, E2E_V2_OUTPUT: root, E2E_RUN_ID: 'synthetic-effective-limits',
    E2E_RUN_SUPERVISED: '1', E2E_TARGET: 'staging-live', E2E_RUN_LIMITS: JSON.stringify(limits),
  } }); } catch (error) { assert.fail(error.stderr?.toString() || error.message); }
}

test('preflight stops at the selected attempt ceiling for HTTP and transport failures', async t => {
  await consumer(t, { preflightAttempts: 1 }, `
    const { preflightRequest } = await import('./scripts/e2e-staging/session.mjs');
    for (const transport of [false, true]) {
      let calls = 0, pauses = 0;
      await assert.rejects(preflightRequest('synthetic', async () => {
        calls++; if (transport) throw new Error('synthetic transport');
        return { status: () => 503 };
      }, { pause: async () => pauses++, signal: run.signal }), /preflight failed/);
      assert.equal(calls, 1); assert.equal(pauses, 0);
    }
  `);
});

test('exploration plans enforce the selected steps, batches and aggregate model ceiling', async t => {
  await consumer(t, { explorationSteps: 1, batchGoals: 1, modelCalls: 3 }, `
    const { createExplorationBatchPlan, createExplorationCallPlan } = await import('./scripts/e2e-staging/model-room.mjs');
    const call = createExplorationCallPlan(1);
    assert.equal(call.perGoal, 1); assert.equal(call.scheduled, 3);
    assert.throws(() => createExplorationCallPlan(2), /above the hard global ceiling/);
    const batch = createExplorationBatchPlan(2);
    assert.deepEqual(batch.batches.map(row => row.goalCount), [1, 1]);
    assert.equal(batch.totalCalls, 6);
  `);
});

test('Playwright uses the selected test and whole-run deadlines', async t => {
  await consumer(t, { testTimeoutMs: 10, runTimeoutMs: 10_000 }, `
    const config = (await import('./playwright.staging.config.mjs')).default;
    assert.equal(config.timeout, 10); assert.equal(config.globalTimeout, 10_000);
    assert.equal(config.workers, 1); assert.equal(config.retries, 0);
  `);
});

test('coverage refuses a pending read at the selected settlement ceiling even with a larger caller timeout', async t => {
  await consumer(t, { settlementMs: 10 }, `
    const { stagingFixtureWriteGuard } = await import('./scripts/e2e-staging/records.mjs');
    const { STAGING_ORIGIN } = await import('./scripts/e2e-staging/session.mjs');
    const guard = stagingFixtureWriteGuard({ run });
    let release;
    const pending = guard.handle({ url: () => STAGING_ORIGIN + '/app-release', method: () => 'GET' },
      () => new Promise(resolve => { release = resolve; }));
    const settled = pending.catch(error => error);
    while (!release) { if (guard.refusals.length) assert.fail(JSON.stringify(guard.refusals)); await new Promise(resolve => setTimeout(resolve, 1)); }
    const late = setTimeout(() => release({ status: () => 200 }), 80);
    try { await assert.rejects(guard.assertCoverage({ timeoutMs: 1000 }), /dispatch-settlement-timeout/); }
    finally { clearTimeout(late); release({ status: () => 200 }); await settled; }
    assert.equal((await settled).code, 'dispatch-settlement-timeout');
  `);
});

test('control sweep stops before measuring beyond the selected screen ceiling', async t => {
  await consumer(t, { controlsPerScreen: 1 }, `
    const { chromium } = await import('playwright');
    const { sweepScreen } = await import('./scripts/e2e-staging/controls.mjs');
    const browser = await chromium.launch();
    let measured = 0;
    try {
      const result = await sweepScreen({ screen: { path: '/', name: 'Synthetic', surface: 'app' }, target: 'desktop',
        waitMs: 20, limit: 100, freshPage: async () => {
          const page = await browser.newPage();
          await page.setContent(${JSON.stringify('<button id="one" onclick="this.textContent=\'changed\'">One</button><button id="two" onclick="this.textContent=\'changed\'">Two</button>')});
          return page;
        }, checkpoint: async row => { measured = Math.max(measured, row.controls.length); }
      });
      assert.equal(run.signal.reason?.code, 'control-count-limit');
      assert.ok(result.controls.length <= 1);
      assert.equal(measured, 1);
    } finally { await browser.close(); }
  `);
});

test('navigation and intercepted fetches use the selected HTTP timeout and retry policy', async t => {
  await consumer(t, { httpTimeoutMs: 123 }, `
    const { createFreshPageFactory } = await import('./scripts/e2e-staging/playwright-fixtures.mjs');
    const { installStagingGuard } = await import('./scripts/e2e-staging/engine.mjs');
    const { boundedRequestContext } = await import('./scripts/e2e-staging/run-limits.mjs');
    const { STAGING_ORIGIN } = await import('./scripts/e2e-staging/session.mjs');
    const observed = [], url = STAGING_ORIGIN + '/';
    const page = { url: () => url, goto: async (_, options) => { observed.push(options.timeout); return { ok: () => true }; },
      waitForLoadState: async (_, options) => { observed.push(options.timeout); } };
    const context = { newPage: async () => page, on() {}, close: async () => {} };
    const release = { source_commit: 'synthetic', carr_source_commit: 'synthetic' };
    const factory = createFreshPageFactory({ browser: { newContext: async () => context }, installGuard: async () => {}, releaseProbe: async () => release });
    await factory.freshPage({ screen: { path: '/' }, release }); await factory.dispose();
    let handler;
    await installStagingGuard({ route: async (_, value) => { handler = value; }, addInitScript: async () => {} }, { handle: (_, forward) => forward() });
    await handler({ request: () => ({}), fetch: async options => { observed.push(options.timeout); assert.equal(options.maxRetries, 0); return { status: () => 200 }; }, fulfill: async () => {}, abort: async () => assert.fail('unexpected route refusal') });
    await boundedRequestContext({ get: async (_, options) => { observed.push(options.timeout); assert.equal(options.maxRetries, 0); }, dispose() {} }, run).get('/');
    assert.deepEqual(observed, [123, 123, 123, 123]);
  `);
});

for (const [limits, body, reason] of [
  [{ dispatcherOutputBytes: 10 }, 'print("x" * 100)', 'dispatcher-output-byte-limit'],
  [{ goalTimeoutMs: 50 }, 'import time; time.sleep(10)', 'dispatcher-deadline'],
]) test('Model Room dispatch enforces ' + reason, async t => {
  await consumer(t, limits, `
    const { writeFile, readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { dispatchThroughModelRoom, MODEL_ROOM_DISPATCH_CONTRACT } = await import('./scripts/e2e-staging/model-room.mjs');
    const path = run.root + '/synthetic-dispatcher.py';
    await writeFile(path, ${JSON.stringify(body)});
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 2000);
    try {
      await assert.rejects(dispatchThroughModelRoom({ desk: 'synthetic', task: 'synthetic', fresh: true, run,
        signal: controller.signal, dispatcherPath: path,
        environment: { ...process.env, E2E_ALLOW_MODEL_CALLS: run.id },
        dispatcherContract: { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
      }), error => error.code === ${JSON.stringify(reason)});
    } finally { clearTimeout(fallback); }
  `);
});

test('evidence scrub uses the selected timeout and output ceiling', async t => {
  await consumer(t, { httpTimeoutMs: 123, dispatcherOutputBytes: 321 }, `
    const childProcess = (await import('node:child_process')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    let observed;
    childProcess.spawnSync = (_, __, options) => { observed = options; return { status: 1 }; };
    syncBuiltinESMExports();
    const { scrubEvidence } = await import('./scripts/e2e-staging/evidence.mjs');
    assert.throws(() => scrubEvidence(run.root), /Evidence scrub failed/);
    assert.equal(observed.timeout, 123); assert.equal(observed.maxBuffer, 321);
  `);
});

test('detached child inspection, launch and retirement obey the selected cleanup limits', async t => {
  await consumer(t, { dispatcherGraceMs: 11, launchTimeoutMs: 12, stopGraceMs: 13, cleanupVerifyMs: 14, monitorIntervalMs: 15 }, `
    const childProcess = (await import('node:child_process')).default;
    const { EventEmitter } = await import('node:events');
    process.env.E2E_PROCESS_REGISTRY = run.root + '/synthetic-processes.jsonl';
    const inspections = [], timers = [], callbacks = [];
    const child = new EventEmitter(); child.pid = 987654321;
    child.stdio = [null, null, null, { end() {} }];
    childProcess.spawnSync = (_, __, options) => { inspections.push(options.timeout); return { status: 0, stdout: 'synthetic birth' }; };
    let launch;
    childProcess.spawn = (...args) => { launch = args; return child; };
    process.kill = () => true;
    const now = Date.now;
    let clock = 1000;
    Date.now = () => clock;
    globalThis.setTimeout = (callback, ms) => { timers.push(ms); callbacks.push(callback); return { unref() {} }; };
    try {
      await import('./scripts/e2e-staging/preload.mjs');
      childProcess.spawn('synthetic', [], { detached: true, stdio: 'pipe' });
      assert.deepEqual(inspections, [11, 11]);
      assert.equal(launch[1][2], '12');
      child.emit('close');
      assert.deepEqual(timers, [15]);
      clock += 28; callbacks.shift()();
      assert.deepEqual(timers, [15], 'retirement polling ends at stopGraceMs + cleanupVerifyMs');
      child.kill = () => {};
      childProcess.spawnSync = () => ({ status: 1 });
      let probes = 0;
      process.kill = () => { probes++; clock += 5; return true; };
      assert.throws(() => childProcess.spawn('synthetic', [], { detached: true }), error => error.code === 'process-inspection-unavailable');
      assert.equal(probes, 0, 'an inspection failure before launch owns no process');
      let inspectionsAfterLaunch = 0;
      childProcess.spawnSync = () => ({ status: inspectionsAfterLaunch++ ? 1 : 0, stdout: 'synthetic birth' });
      assert.throws(() => childProcess.spawn('synthetic', [], { detached: true }), error => error.code === 'process-cleanup-unverified');
      assert.equal(probes, 4, 'failed admission cleanup ends at cleanupVerifyMs');
    } finally { Date.now = now; }
  `);
});

test('artifact reservations respect the selected metadata reserve and refuse the next byte', async t => {
  await consumer(t, { artifactBytes: 20_000, artifactMetadataBytes: 100 }, `
    const { directoryBytes } = await import('./scripts/e2e-staging/run-limits.mjs');
    const remaining = 20_000 - 100 - directoryBytes(run.root);
    run.reserveBytes(remaining);
    assert.throws(() => run.reserveBytes(1), error => error.code === 'artifact-byte-limit');
  `);
});

test('dispatcher cleanup escalates at the selected grace deadline without a polling overrun', async t => {
  await consumer(t, { dispatcherGraceMs: 23, dispatcherOutputBytes: 10 }, `
    const childProcess = (await import('node:child_process')).default;
    const timers = (await import('node:timers/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const { EventEmitter } = await import('node:events');
    const { writeFile, readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const path = run.root + '/synthetic-cleanup.py'; await writeFile(path, 'synthetic');
    let clock = 1000, killed = false;
    const waits = [], signals = [], now = Date.now;
    Date.now = () => clock;
    process.kill = (_, signal) => {
      if (signal) { signals.push([signal, clock]); if (signal === 'SIGKILL') killed = true; return; }
      if (killed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    timers.setTimeout = async ms => { waits.push(ms); clock += ms; };
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.pid = 987654321; child.exitCode = null; child.signalCode = null;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = () => queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(11)));
      return child;
    };
    syncBuiltinESMExports();
    try {
      const { dispatchThroughModelRoom, MODEL_ROOM_DISPATCH_CONTRACT } = await import('./scripts/e2e-staging/model-room.mjs');
      await assert.rejects(dispatchThroughModelRoom({ desk: 'synthetic', task: 'synthetic', fresh: true, run, dispatcherPath: path,
        environment: { ...process.env, E2E_ALLOW_MODEL_CALLS: run.id },
        dispatcherContract: { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
      }), error => error.code === 'dispatcher-output-byte-limit');
      assert.equal(waits.reduce((total, ms) => total + ms, 0), 23);
      assert.ok(signals.filter(([signal]) => signal === 'SIGKILL').every(([, at]) => at === 1023));
    } finally { Date.now = now; }
  `);
});

test('exploration runner clamps a larger caller deadline to the selected goal deadline', async t => {
  await consumer(t, { goalTimeoutMs: 23 }, `
    const { runExplorationAttempt } = await import('./scripts/e2e-staging/explore.mjs');
    let observed;
    const attempt = await runExplorationAttempt(async options => { observed = options.timeoutMs; throw new Error('synthetic timeout'); }, { timeoutMs: 999 });
    assert.equal(observed, 23); assert.match(attempt.error.message, /synthetic timeout/);
  `);
});
