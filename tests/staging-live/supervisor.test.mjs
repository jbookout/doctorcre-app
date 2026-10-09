import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';

const supervisorURL = new URL('../../scripts/e2e-staging/supervise.mjs', import.meta.url).href;
const inspection = spawnSync('ps', ['-p', String(process.pid), '-o', 'pid=', '-o', 'lstart='], { encoding: 'utf8', timeout: 250 });
const processTests = { skip: inspection.error || inspection.status !== 0 ?
  'Process identity inspection is unavailable in this sandbox; run these tests outside it' : false };
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function within(operation, milliseconds = 4_000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic supervisor exceeded its cleanup deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { phase = 'setup', behavior = 'wait', limits = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-supervisor-'));
  const pidsPath = join(root, 'pids.json');
  const output = join(root, 'output');
  const worker = `
    import { spawn } from 'node:child_process';
    import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ worker: process.pid, child: child.pid, phase: ${JSON.stringify(phase)} }));
    const behavior = ${JSON.stringify(behavior)};
    if (behavior === 'corrupt-registry') appendFileSync(process.env.E2E_PROCESS_REGISTRY, ${JSON.stringify('{broken}' + String.fromCharCode(10))});
    if (behavior === 'locked-ledger') {
      // The supervisor holds this same lock for its own ledger writes; wait for a free moment to take it.
      for (;;) {
        try { mkdirSync(join(process.env.E2E_V2_OUTPUT, '.run-budget.lock')); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
    if (behavior === 'normal-exit') process.exit(0);
    if (behavior === 'log-quota') setInterval(() => process.stdout.write('x'.repeat(16384)), 5);
    setInterval(()=>{},1000);
  `;
  const policy = { ...RUN_LIMITS, stopGraceMs: 100, monitorIntervalMs: 10, runTimeoutMs: 5_000, ...limits };
  const program = `
    import { supervise } from ${JSON.stringify(supervisorURL)};
    try {
      await supervise({ command: process.execPath, args: ['--input-type=module', '-e', ${JSON.stringify(worker)}], output: ${JSON.stringify(output)}, limits: ${JSON.stringify(policy)} });
      console.log(JSON.stringify({ status: 'complete' }));
    } catch (error) { console.log(JSON.stringify({ status: 'stopped', reason: error.code })); process.exitCode = 1; }
  `;
  const environment = { ...process.env };
  for (const name of ['E2E_RUN_ID', 'E2E_RUN_SUPERVISED', 'E2E_ALLOW_MODEL_CALLS', 'E2E_PROCESS_REGISTRY']) delete environment[name];
  const supervisor = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', pids;
  supervisor.stdout.on('data', chunk => { stdout += chunk; });
  supervisor.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    supervisor.once('error', reject);
    supervisor.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(async () => {
    for (const pid of [pids?.child, pids?.worker]) {
      if (!pid) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    await within(ended).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await within((async () => {
    for (;;) {
      try { pids = JSON.parse(await readFile(pidsPath, 'utf8')); return; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) throw new Error('Synthetic supervisor failed before worker readiness: ' + stderr + stdout + await readFile(join(output, 'run.log'), 'utf8').catch(() => ''));
      await pause(10);
    }
  })());
  return {
    supervisor, pids, output, ended,
    diagnostic() { return stdout + stderr; },
    async assertReaped() {
      await within((async () => {
        while (alive(pids.worker) || alive(pids.child)) await pause(10);
      })());
      assert.equal(alive(pids.worker), false, 'worker exited');
      assert.equal(alive(pids.child), false, 'detached child exited');
    },
  };
}

for (const phase of ['setup', 'exploration', 'sweep', 'report']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} reaps the ${phase} worker and resistant detached child within four seconds`, processTests, async t => {
      const run = await fixture(t, { phase });
      assert.equal(alive(run.pids.worker), true);
      assert.equal(alive(run.pids.child), true);
      const started = Date.now();
      run.supervisor.kill(signal);
      const result = await within(run.ended).catch(error => { throw new Error(error.message + '\n' + run.diagnostic()); });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).reason, 'stop-signal');
      await run.assertReaped();
      assert.ok(Date.now() - started <= 4_000, 'signal cleanup stayed within four seconds');
      const state = JSON.parse(await readFile(join(run.output, 'run-budget.json'), 'utf8'));
      assert.equal(state.stopReason, 'stop-signal');
    });
  }
}

test('whole-run deadline reaps a resistant worker and detached child', processTests, async t => {
  const run = await fixture(t, { limits: { runTimeoutMs: 700 } });
  const result = await within(run.ended);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).reason, 'whole-run-deadline');
  await run.assertReaped();
});

test('aggregate log quota stops and reaps every owned group', processTests, async t => {
  const run = await fixture(t, { behavior: 'log-quota', limits: { artifactBytes: 48 * 1024 } });
  const result = await within(run.ended);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).reason, 'artifact-byte-limit');
  await run.assertReaped();
});

test('normal worker exit still reaps its detached descendant', processTests, async t => {
  const run = await fixture(t, { behavior: 'normal-exit' });
  const result = await within(run.ended);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'complete' });
  await run.assertReaped();
});

test('a corrupt registry never prevents known groups from being reaped', processTests, async t => {
  const run = await fixture(t, { behavior: 'corrupt-registry' });
  const result = await within(run.ended);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout.trim()).reason, 'process-cleanup-unverified');
  await run.assertReaped();
});

test('a failed stop receipt never prevents physical termination', processTests, async t => {
  const run = await fixture(t, { behavior: 'locked-ledger' });
  const result = await within(run.ended);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).reason, 'run-ledger-busy');
  await run.assertReaped();
});

test('unavailable process inspection refuses before launching a worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-supervisor-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'worker-started');
  const program = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawnSync = () => ({ error: Object.assign(new Error('inspection denied'), { code: 'EPERM' }) });
    syncBuiltinESMExports();
    const { supervise } = await import(${JSON.stringify(supervisorURL)});
    try {
      await supervise({ command: process.execPath, args: ['-e', ${JSON.stringify('require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "started")')}], output: ${JSON.stringify(join(root, 'output'))} });
      process.exitCode = 2;
    } catch (error) { console.log(error.code); process.exitCode = error.code === 'process-inspection-unavailable' ? 0 : 1; }
  `;
  const environment = { ...process.env };
  for (const name of ['E2E_RUN_ID', 'E2E_RUN_SUPERVISED', 'E2E_RUN_LIMITS', 'E2E_PROCESS_REGISTRY']) delete environment[name];
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const code = await within(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }));
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), 'process-inspection-unavailable');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});


test('supervisor passes environment caps to its worker and persisted ledger', processTests, async t => {
  const { supervise } = await import('../../scripts/e2e-staging/supervise.mjs');
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-supervisor-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = { ...RUN_LIMITS, httpRequests: 2, modelCalls: 0, stopGraceMs: 50 };
  const worker = `
    import { currentRun } from ${JSON.stringify(new URL('../../scripts/e2e-staging/run-limits.mjs', import.meta.url).href)};
    const run = currentRun();
    if (run.limits.httpRequests !== 2 || run.limits.modelCalls !== 0) process.exit(3);
    await run.http(() => {}); await run.http(() => {});
    try { await run.http(() => process.exit(4)); process.exit(5); }
    catch (error) { if (error.code !== 'http-request-limit') process.exit(6); }
  `;
  await assert.rejects(supervise({ command: process.execPath, args: ['--input-type=module', '-e', worker], output: root,
    environment: { ...process.env, E2E_RUN_LIMITS: JSON.stringify(policy) } }), error => error.code === 'http-request-limit');
  const state = JSON.parse(await readFile(join(root, 'run-budget.json'), 'utf8'));
  assert.deepEqual(state.limits, policy);
  assert.equal(state.httpRequests, 2);
  assert.equal(state.modelCalls, 0);
});

test('invalid environment caps refuse before the output directory or worker exists', async t => {
  const { supervise } = await import('../../scripts/e2e-staging/supervise.mjs');
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-supervisor-invalid-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'unused');
  await assert.rejects(supervise({ command: process.execPath, args: ['-e', 'process.exit(99)'], output,
    environment: { ...process.env, E2E_RUN_LIMITS: JSON.stringify({ httpRequests: RUN_LIMITS.httpRequests + 1 }) } }),
    error => error.code === 'invalid-run-limits');
  await assert.rejects(readFile(join(output, 'run-budget.json')), { code: 'ENOENT' });
});
