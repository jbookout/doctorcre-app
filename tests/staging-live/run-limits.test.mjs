import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir, open, rename, readdir, symlink, link, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RUN_LIMITS, RunLimitError, directoryBytes, openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { createHash } from 'node:crypto';

const code = expected => error => error instanceof RunLimitError && error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('synthetic operation did not reach expected state');
};

async function fixture(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-run-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const limits = { ...RUN_LIMITS, ...overrides };
  const run = openRun(root, { limits, runId: 'synthetic-limits-run', events: null, ...options });
  t.after(() => run.dispose());
  return { root, limits, run };
}

test('evidence digest receipts charge exact changed bytes once across writers and reopening', async t => {
  const { root, limits, run } = await fixture(t);
  await mkdir(join(root, 'evidence'), { mode: 0o700 });
  const path = join(root, 'evidence', 'frame.jpg');
  const bytes = Buffer.from('abc');
  const manifest = value => ({ 'evidence/frame.jpg': { size: value.length,
    sha256: createHash('sha256').update(value).digest('hex') } });
  const before = run.snapshot().artifactBytes;
  await run.writeFile(path, bytes, writeFile);
  assert.equal(run.snapshot().artifactBytes - before, bytes.length);
  await run.writeFile(path, bytes, writeFile);
  assert.equal(run.snapshot().artifactBytes - before, bytes.length);
  assert.equal(run.accountEvidence(manifest(bytes)).chargedBytes, 0);
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  assert.equal(reopened.accountEvidence(manifest(bytes)).chargedBytes, 0);
  const changed = Buffer.from('xyz'), previous = run.snapshot().artifactBytes;
  await run.writeFile(path, changed, writeFile, { replaces: path });
  assert.equal(run.snapshot().artifactBytes - previous, changed.length);
  assert.equal(run.accountEvidence(manifest(changed)).chargedBytes, 0);
  const external = Buffer.from('uvw'), priorExternal = run.snapshot().artifactBytes;
  await writeFile(path, external);
  assert.equal(run.accountEvidence(manifest(external)).chargedBytes, external.length);
  assert.equal(run.snapshot().artifactBytes - priorExternal, external.length);
  assert.equal(run.accountEvidence(manifest(external)).chargedBytes, 0);
  assert.throws(() => run.accountEvidence(manifest(bytes)), code('artifact-evidence-mismatch'));
  assert.throws(() => run.accountEvidence({ 'controls.json': manifest(bytes)['evidence/frame.jpg'] }), code('artifact-path-refused'));
  await rm(path);
  assert.equal(run.snapshot().artifactBytes, priorExternal + external.length);
});

test('unknown evidence is charged once without a resident-floor credit and copied evidence keeps its path receipt', async t => {
  const { root, run } = await fixture(t);
  const evidence = join(root, 'evidence');
  await mkdir(evidence, { mode: 0o700 });
  const bytes = Buffer.alloc(32 * 1024, 3), digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(evidence, 'external.jpg'), bytes);
  run.reserveBytes(1);
  assert.ok(run.snapshot().artifactBytes < bytes.length, 'untyped resident accounting excludes evidence content');
  const before = run.snapshot().artifactBytes;
  const files = { 'evidence/external.jpg': { size: bytes.length, sha256: digest } };
  assert.equal(run.accountEvidence(files).chargedBytes, bytes.length);
  assert.equal(run.snapshot().artifactBytes, before + bytes.length);
  const source = await mkdtemp(join(tmpdir(), 'doctorcre-evidence-copy-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, 'copied.jpg'), bytes);
  const priorCopy = run.snapshot().artifactBytes;
  await run.copyArtifacts(source, join(evidence, 'copied'), (from, to) => cp(from, to, { recursive: true }));
  assert.equal(run.snapshot().artifactBytes - priorCopy, bytes.length, 'the same digest at a new path is new content');
  assert.equal(run.accountEvidence({ 'evidence/copied/copied.jpg': { size: bytes.length, sha256: digest } }).chargedBytes, 0);
  const beforeMissing = run.snapshot().artifactBytes;
  assert.throws(() => run.accountEvidence({ 'evidence/missing.jpg': { size: bytes.length, sha256: digest } }));
  assert.equal(run.snapshot().artifactBytes, beforeMissing);
});

test('HTTP total stops before a third operation and survives reopening the ledger', async t => {
  const { root, limits, run } = await fixture(t, { httpRequests: 2 });
  let calls = 0;
  const operation = () => ++calls;
  assert.equal(await run.http(operation), 1);
  assert.equal(await run.http(operation), 2);
  await assert.rejects(run.http(operation), code('http-request-limit'));
  assert.equal(calls, 2);
  assert.equal(run.snapshot().httpRequests, 2);
  assert.equal(run.snapshot().stopReason, 'http-request-limit');
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  await assert.rejects(reopened.http(operation), code('http-request-limit'));
  assert.equal(calls, 2);
});

test('HTTP concurrency queues a third request until a slot is released', async t => {
  const { run } = await fixture(t, { httpConcurrency: 2, httpTimeoutMs: 1_000 });
  const gates = [deferred(), deferred(), deferred()];
  let active = 0, peak = 0, started = 0;
  const work = gates.map(gate => run.http(async () => {
    started++; peak = Math.max(peak, ++active);
    try { return await gate.promise; } finally { active--; }
  }));
  await until(() => started === 2 && Object.keys(run.snapshot().queuedHttp).length === 1);
  assert.equal(peak, 2);
  assert.equal(run.snapshot().httpRequests, 2);
  gates[0].resolve('first');
  await until(() => started === 3);
  assert.equal(peak, 2);
  gates[1].resolve('second'); gates[2].resolve('third');
  assert.deepEqual(await Promise.all(work), ['first', 'second', 'third']);
  assert.equal(run.snapshot().httpRequests, 3);
  assert.deepEqual(run.snapshot().activeHttp, {});
  assert.deepEqual(run.snapshot().queuedHttp, {});
});

test('HTTP queue overflow waits for room, so a page-load burst completes under the caps', async t => {
  // A real staging page requests more assets at once than httpQueue holds
  // (run 2026-10-09: 221 requests, stopped at http-queue-limit before any control).
  const { run } = await fixture(t, { httpConcurrency: 2, httpQueue: 4, httpTimeoutMs: 1_000 });
  let active = 0, peak = 0, peakQueued = 0;
  const burst = Array.from({ length: 12 }, (_, index) => run.http(async () => {
    peak = Math.max(peak, ++active);
    peakQueued = Math.max(peakQueued, Object.keys(run.snapshot().queuedHttp).length);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return index;
  }));
  assert.deepEqual(await Promise.all(burst), [...Array(12).keys()]);
  assert.equal(peak, 2);
  assert.ok(peakQueued <= 4, `queue held ${peakQueued} > 4`);
  assert.equal(run.snapshot().httpRequests, 12);
  assert.equal(run.snapshot().stopReason, null);
  assert.deepEqual(run.snapshot().queuedHttp, {});
});

test('HTTP queue overflow that never drains stops the run without starting replacements', async t => {
  const { run } = await fixture(t, { httpConcurrency: 1, httpQueue: 1, httpTimeoutMs: 50 });
  let calls = 0;
  const blocked = () => { calls++; return new Promise(() => {}); };
  const first = assert.rejects(run.http(blocked), RunLimitError);
  await until(() => calls === 1);
  const queued = assert.rejects(run.http(blocked), RunLimitError);
  await until(() => Object.keys(run.snapshot().queuedHttp).length === 1);
  await assert.rejects(run.http(blocked), RunLimitError);
  await Promise.all([first, queued]);
  assert.equal(calls, 1);
  assert.equal(run.snapshot().httpRequests, 1);
  assert.ok(['http-request-timeout', 'http-queue-limit'].includes(run.snapshot().stopReason));
  assert.deepEqual(run.snapshot().activeHttp, {});
  assert.deepEqual(run.snapshot().queuedHttp, {});
});

test('HTTP timeout bounds an operation that ignores cancellation', { timeout: 2_000 }, async t => {
  const { run } = await fixture(t, { httpTimeoutMs: 25 });
  let calls = 0;
  await assert.rejects(run.http(() => { calls++; return new Promise(() => {}); }), code('http-request-timeout'));
  await assert.rejects(run.http(() => { calls++; }), code('http-request-timeout'));
  assert.equal(calls, 1);
  assert.equal(run.snapshot().httpRequests, 1);
  assert.equal(run.snapshot().stopReason, 'http-request-timeout');
  assert.deepEqual(run.snapshot().activeHttp, {});
});

test('queued HTTP admission has a named timeout before another operation starts', { timeout: 2_000 }, async t => {
  let now = 1_000;
  const { run } = await fixture(t, { httpConcurrency: 1, httpTimeoutMs: 1_000 }, { now: () => now });
  let calls = 0;
  const first = assert.rejects(run.http(() => { calls++; return new Promise(() => {}); }), code('http-admission-timeout'));
  await until(() => calls === 1);
  const queued = assert.rejects(run.http(() => { calls++; }), code('http-admission-timeout'));
  await until(() => Object.keys(run.snapshot().queuedHttp).length === 1);
  now += 1_001;
  await Promise.all([first, queued]);
  assert.equal(calls, 1);
  assert.equal(run.snapshot().httpRequests, 1);
  assert.equal(run.snapshot().stopReason, 'http-admission-timeout');
});

test('the persisted deadline cannot reset on reopen and refuses every reservation', async t => {
  let now = 1_000;
  const { root, limits, run } = await fixture(t, { runTimeoutMs: 500 }, { now: () => now });
  assert.equal(run.deadline, 1_500);
  now = 1_300;
  const reopened = openRun(root, { limits, runId: run.id, events: null, now: () => now });
  t.after(() => reopened.dispose());
  assert.equal(reopened.deadline, 1_500);
  now = 1_500;
  assert.throws(() => reopened.check(), code('whole-run-deadline'));
  assert.throws(() => run.reserveModel(), code('whole-run-deadline'));
  assert.throws(() => run.reserveBytes(1), code('whole-run-deadline'));
  assert.equal(run.snapshot().modelCalls, 0);
  assert.equal(run.snapshot().artifactBytes, 0);
});

test('new invocations preserve the whole-run deadline and cannot resume after it expires', async t => {
  let now = 1_000;
  const { root, limits, run } = await fixture(t, { runTimeoutMs: 500 }, { now: () => now });
  assert.equal(run.snapshot().startedAt, 1_000);
  assert.equal(run.deadline, 1_500);
  run.dispose();

  now = 1_600;
  let requests = 0;
  assert.throws(() => {
    const resumed = openRun(root, { limits, runId: run.id, events: null, now: () => now, newInvocation: true });
    return resumed.http(() => { requests++; });
  }, code('whole-run-deadline'));
  assert.equal(requests, 0);
  const state = JSON.parse(await readFile(join(root, 'run-budget.json'), 'utf8'));
  assert.equal(state.startedAt, 1_000);
  assert.equal(state.deadline, 1_500);
  assert.equal(state.invocations, undefined);
});

test('artifact reservations retain their count and fail before a write exceeding the quota', async t => {
  const { root, limits, run } = await fixture(t, { artifactBytes: 8_192 });
  const expected = directoryBytes(root) + 3_000;
  run.reserveBytes(3_000);
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  let writes = 0;
  await assert.rejects(reopened.writeFile(join(root, 'unused'), 'x'.repeat(limits.artifactBytes - expected + 1), () => { writes++; }), code('artifact-byte-limit'));
  assert.equal(writes, 0);
  assert.equal(run.snapshot().artifactBytes, expected);
  assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
});

test('retained artifacts count toward the quota even without a new reservation', async t => {
  const { root, run } = await fixture(t, { artifactBytes: 4_096 });
  await writeFile(join(root, 'retained-evidence.bin'), Buffer.alloc(4_097));
  assert.throws(() => run.checkArtifacts(), code('artifact-byte-limit'));
  assert.equal(run.snapshot().artifactBytes, 0);
  assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
});

test('stop remains sticky across signals and ledger reopen and runs registered cleanup', async t => {
  const events = new EventEmitter();
  const { root, limits, run } = await fixture(t, {}, { events });
  let cleaned = 0;
  run.onStop(() => { cleaned++; });
  events.emit('SIGTERM');
  events.emit('SIGINT');
  run.stop('another-reason');
  await until(() => cleaned === 1);
  assert.equal(run.signal.reason.code, 'stop-signal');
  assert.equal(run.snapshot().stopReason, 'stop-signal');
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  assert.throws(() => reopened.reserveModel(), code('stop-signal'));
  assert.equal(reopened.snapshot().modelCalls, 0);
});

test('model counters persist and a rejected reservation does not exceed the ceiling', async t => {
  const { root, limits, run } = await fixture(t, { modelCalls: 2 });
  run.reserveModel();
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  assert.equal(reopened.snapshot().modelCalls, 1);
  reopened.reserveModel();
  assert.throws(() => run.reserveModel(), code('model-call-limit'));
  assert.equal(reopened.snapshot().modelCalls, 2);
  assert.equal(reopened.snapshot().stopReason, 'model-call-limit');
});

test('process-group admission stops at the cap before another reservation is returned', async t => {
  const { run } = await fixture(t, { processGroups: 3 });
  const releaseFirst = run.reserveProcessGroup();
  const releaseSecond = run.reserveProcessGroup();
  assert.equal(Object.keys(run.snapshot().processGroups).length, 2);
  assert.throws(() => run.reserveProcessGroup(), code('process-group-limit'));
  assert.equal(Object.keys(run.snapshot().processGroups).length, 2);
  assert.equal(run.snapshot().stopReason, 'process-group-limit');
  releaseFirst(); releaseSecond();
  assert.deepEqual(run.snapshot().processGroups, {});
});

test('releasing a process-group reservation allows reuse and is idempotent', async t => {
  const { root, limits, run } = await fixture(t, { processGroups: 2 });
  const release = run.reserveProcessGroup();
  assert.equal(Object.keys(run.snapshot().processGroups).length, 1);
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  assert.equal(Object.keys(reopened.snapshot().processGroups).length, 1);
  release(); release();
  const releaseAgain = reopened.reserveProcessGroup();
  assert.equal(Object.keys(run.snapshot().processGroups).length, 1);
  releaseAgain();
  assert.deepEqual(run.snapshot().processGroups, {});
  assert.equal(run.snapshot().stopReason, null);
});

test('unreadable and structurally invalid ledgers fail with named errors', async t => {
  const { root, limits, run } = await fixture(t);
  const path = join(root, 'run-budget.json');
  const original = await readFile(path, 'utf8');
  await writeFile(path, '{truncated');
  assert.throws(() => run.snapshot(), code('run-ledger-unreadable'));
  assert.throws(() => run.check(), code('run-ledger-unreadable'));
  assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-unreadable'));
  for (const falsey of [null, false, 0]) {
    await writeFile(path, JSON.stringify(falsey));
    assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-invalid'));
  }
  for (const corrupt of [{ schema: 'unknown' }, { modelCalls: -1 }, { activeHttp: [] }, { queuedHttp: null }, { processGroups: null }, { processGroups: [] }, { stopReason: 3 }, { deadline: 0 }, { id: 'wrong-run' }]) {
    await writeFile(path, JSON.stringify({ ...JSON.parse(original), ...corrupt }));
    assert.throws(() => run.snapshot(), code('run-ledger-invalid'));
    assert.throws(() => run.check(), code('run-ledger-invalid'));
    assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-invalid'));
  }
  await writeFile(path, original);
  assert.equal(run.snapshot().modelCalls, 0);
});


test('environment limits are a whole, lower-only, typed and canonical policy', async () => {
  const { runLimitsFromEnvironment } = await import('../../scripts/e2e-staging/run-limits.mjs');
  const env = limits => ({ E2E_RUN_LIMITS: typeof limits === 'string' ? limits : JSON.stringify(limits) });
  const refused = detail => error => code('invalid-run-limits')(error) && detail.test(error.message);
  // Unset keeps today's defaults.
  assert.deepEqual(runLimitsFromEnvironment({}), RUN_LIMITS);
  // A full object is accepted and returned in canonical key order.
  const lower = { ...RUN_LIMITS, httpRequests: 120, modelCalls: 0 };
  const reversed = Object.fromEntries(Object.entries(lower).reverse());
  assert.deepEqual(Object.entries(runLimitsFromEnvironment(env(reversed))), Object.entries(lower));
  // Partial, empty and unknown-key objects fail closed and name the keys.
  const rest = Object.keys(RUN_LIMITS).filter(key => key !== 'httpRequests');
  assert.throws(() => runLimitsFromEnvironment(env({ httpRequests: 120 })), refused(new RegExp(`missing ${rest.join(', ')}\\)`)));
  assert.throws(() => runLimitsFromEnvironment(env('{}')), refused(new RegExp(`missing ${Object.keys(RUN_LIMITS).join(', ')}\\)`)));
  assert.throws(() => runLimitsFromEnvironment(env({ ...RUN_LIMITS, unknown: 1 })), refused(/\(unknown unknown\)/));
  assert.throws(() => runLimitsFromEnvironment(env(JSON.stringify(RUN_LIMITS).replace('{', '{"__proto__":{},'))), refused(/unknown __proto__/));
  const { modelCalls, ...withoutModel } = RUN_LIMITS;
  assert.throws(() => runLimitsFromEnvironment(env({ ...withoutModel, extra: 1 })), refused(/missing modelCalls; unknown extra/));
  for (const value of ['', 'null', '[]', 'false', '{broken}'])
    assert.throws(() => runLimitsFromEnvironment(env(value)), code('invalid-run-limits'));
  for (const bad of [{ httpRequests: '120' }, { httpRequests: 0 }, { httpRequests: 1.5 }, { modelCalls: -1 }])
    assert.throws(() => runLimitsFromEnvironment(env({ ...RUN_LIMITS, ...bad })), refused(/no higher than its default/));
  for (const [key, maximum] of Object.entries(RUN_LIMITS))
    assert.throws(() => runLimitsFromEnvironment(env({ ...RUN_LIMITS, [key]: maximum + 1 })), code('invalid-run-limits'));
  assert.throws(() => runLimitsFromEnvironment(env({ ...RUN_LIMITS, httpRequests: 3 }), { ...RUN_LIMITS, httpRequests: 2 }), code('invalid-run-limits'));
});

test('zero model calls prevents the first reservation and survives reopen and resume', async t => {
  const { root, limits, run } = await fixture(t, { modelCalls: 0 });
  assert.throws(() => run.reserveModel(), code('model-call-limit'));
  assert.equal(run.snapshot().modelCalls, 0);
  const reopened = openRun(root, { limits, runId: run.id, events: null });
  t.after(() => reopened.dispose());
  assert.throws(() => reopened.reserveModel(), code('model-call-limit'));
  const resumed = openRun(root, { limits, runId: run.id, events: null, newInvocation: true });
  t.after(() => resumed.dispose());
  assert.throws(() => resumed.reserveModel(), code('model-call-limit'));
  assert.equal(resumed.snapshot().modelCalls, 0);
});

test('global request and model ceilings survive supervisor invocation renewal', async t => {
  const { root, run } = await fixture(t, { httpRequests: 3, modelCalls: 2 });
  await run.http(() => true);
  run.reserveModel();
  run.stop('worker-exit');
  const next = openRun(root, { limits: run.limits, runId: run.id, events: null, newInvocation: true });
  t.after(() => next.dispose());
  assert.equal(next.snapshot().httpRequests, 0);
  assert.equal(next.snapshot().modelCalls, 0);
  assert.equal(next.snapshot().globalHttpRequests, 1);
  assert.equal(next.snapshot().globalModelCalls, 1);
  await next.http(() => true);
  next.reserveModel();
  assert.throws(() => next.reserveModel(), code('model-call-limit'));
  // Clear only the sticky stop from the model ceiling to exercise request exhaustion independently.
  const resumed = openRun(root, { limits: run.limits, runId: run.id, events: null, newInvocation: true });
  t.after(() => resumed.dispose());
  await resumed.http(() => true);
  await assert.rejects(resumed.http(() => true), code('http-request-limit'));
  assert.equal(resumed.snapshot().globalHttpRequests, 3);
  assert.equal(resumed.snapshot().globalModelCalls, 2);
});

test('legacy invocation history migrates into global totals and corrupted totals fail closed', async t => {
  const { root, run } = await fixture(t, { httpRequests: 4, modelCalls: 3 });
  await run.http(() => true);
  run.reserveModel();
  run.dispose();
  const path = join(root, 'run-budget.json');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  delete legacy.globalHttpRequests;
  delete legacy.globalModelCalls;
  await writeFile(path, JSON.stringify(legacy));
  const resumed = openRun(root, { limits: run.limits, runId: run.id, events: null, newInvocation: true });
  t.after(() => resumed.dispose());
  assert.equal(resumed.snapshot().globalHttpRequests, 1);
  assert.equal(resumed.snapshot().globalModelCalls, 1);
  resumed.dispose();
  const corrupt = JSON.parse(await readFile(path, 'utf8'));
  corrupt.globalHttpRequests = 0;
  await writeFile(path, JSON.stringify(corrupt));
  assert.throws(() => openRun(root, { limits: run.limits, runId: run.id, events: null }), code('run-ledger-invalid'));
});

test('atomic observations leave a live mutation lock and ledger untouched', async t => {
  const { root, run } = await fixture(t, { stopGraceMs: 20 });
  const path = join(root, 'run-budget.json'), lock = join(root, '.run-budget.lock');
  const original = await readFile(path, 'utf8');
  await mkdir(lock, { mode: 0o700 });
  const marker = JSON.stringify({ schema: 'doctorcre-run-lock.v1', runId: run.id, invocation: '11111111-1111-4111-8111-111111111111', pid: process.pid });
  await writeFile(join(lock, 'owner.json'), marker, { mode: 0o600 });
  assert.equal(run.snapshot().id, run.id);
  run.check(); run.checkArtifacts();
  assert.throws(() => run.reserveModel(), code('run-ledger-busy'));
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), marker);
});

for (const refusal of ['live writer', 'unknown invocation', 'wrong run', 'incomplete ownership', 'replaced lease', 'missing metadata', 'malformed metadata', 'symlink marker', 'linked marker', 'public marker', 'symlink lock']) {
  test(`orphan lock recovery refuses ${refusal}`, async t => {
    const { root, limits, run } = await fixture(t, { stopGraceMs: 20 });
    const leasePath = join(root, '.run-owner'), lock = join(root, '.run-budget.lock');
    const lease = await open(leasePath, 'wx', 0o600);
    await lease.writeFile(String(process.pid));
    t.after(() => lease.close());
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const supervisor = openRun(root, { limits, runId: run.id, events: null, ownerId,
      retirement: { lease: lease.fd, isRetired: () => refusal !== 'incomplete ownership' } });
    t.after(() => supervisor.dispose());
    const release = supervisor.reserveProcessGroup();
    const before = await readFile(join(root, 'run-budget.json'), 'utf8');
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 1_000 });
    assert.equal(dead.status, 0);
    assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
    await mkdir(lock, { mode: 0o700 });
    const marker = refusal === 'malformed metadata' ? '{broken' : JSON.stringify({
      schema: 'doctorcre-run-lock.v1', runId: refusal === 'wrong run' ? 'another-run' : run.id,
      invocation: refusal === 'unknown invocation' ? 'another-invocation' : ownerId,
      pid: refusal === 'live writer' ? process.pid : dead.pid,
    });
    if (refusal !== 'missing metadata') await writeFile(join(lock, 'owner.json'), marker, { mode: 0o600 });
    if (refusal === 'replaced lease') {
      await rename(leasePath, leasePath + '.retired');
      await writeFile(leasePath, String(process.pid));
    }
    if (refusal === 'symlink marker') {
      await rename(join(lock, 'owner.json'), join(root, 'other-marker'));
      await symlink(join(root, 'other-marker'), join(lock, 'owner.json'));
    }
    if (refusal === 'linked marker') await link(join(lock, 'owner.json'), join(root, 'other-marker'));
    if (refusal === 'public marker') await chmod(join(lock, 'owner.json'), 0o644);
    if (refusal === 'symlink lock') {
      await rename(lock, lock + '.other');
      await symlink(lock + '.other', lock);
    }
    assert.throws(() => supervisor.releaseInvocationResources(), code(
      ['incomplete ownership', 'replaced lease'].includes(refusal) ? 'process-cleanup-unverified' : 'run-ledger-busy'));
    assert.equal(await readFile(join(root, 'run-budget.json'), 'utf8'), before);
    if (refusal !== 'missing metadata') assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), marker);
    else assert.deepEqual(await readdir(lock), []);
    await rm(lock, { recursive: true });
    release();
  });
}


test('owned abandoned writer lock recovers only after physical retirement under the original lease', async t => {
  const { root, limits, run } = await fixture(t, { stopGraceMs: 20 });
  const lease = await open(join(root, '.run-owner'), 'wx', 0o600);
  await lease.writeFile(String(process.pid));
  t.after(() => lease.close());
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const supervisor = openRun(root, { limits, runId: run.id, events: null, ownerId,
    retirement: { lease: lease.fd, isRetired: () => true } });
  t.after(() => supervisor.dispose());
  supervisor.reserveModel();
  await supervisor.http(() => true);
  const deadline = supervisor.deadline;
  supervisor.reserveProcessGroup();
  const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 1_000 });
  assert.equal(dead.status, 0);
  assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
  const lock = join(root, '.run-budget.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ schema: 'doctorcre-run-lock.v1',
    runId: run.id, invocation: ownerId, pid: dead.pid }), { mode: 0o600 });
  supervisor.releaseInvocationResources();
  supervisor.stop('stop-signal');
  assert.equal(supervisor.snapshot().stopReason, 'stop-signal');
  assert.equal(supervisor.snapshot().globalHttpRequests, 1);
  assert.equal(supervisor.snapshot().globalModelCalls, 1);
  assert.equal(supervisor.snapshot().deadline, deadline);
  assert.deepEqual(supervisor.snapshot().processGroups, {});
  await assert.rejects(readdir(lock), { code: 'ENOENT' });
});


test('global counter decoding stays observational under a lock and validates legacy totals', async t => {
  const { root, run } = await fixture(t, { httpRequests: 3, modelCalls: 3, stopGraceMs: 20 });
  await run.http(() => true);
  run.reserveModel();
  const path = join(root, 'run-budget.json'), lock = join(root, '.run-budget.lock');
  const legacy = run.snapshot();
  delete legacy.globalHttpRequests;
  delete legacy.globalModelCalls;
  const encoded = JSON.stringify(legacy);
  await writeFile(path, encoded);
  await mkdir(lock, { mode: 0o700 });
  assert.equal(run.snapshot().globalHttpRequests, 1);
  assert.equal(run.snapshot().globalModelCalls, 1);
  run.check();
  assert.equal(await readFile(path, 'utf8'), encoded);
  await writeFile(path, JSON.stringify({ ...legacy, globalHttpRequests: 0, globalModelCalls: 1 }));
  assert.throws(() => run.snapshot(), code('run-ledger-invalid'));
  assert.throws(() => run.check(), code('run-ledger-invalid'));
  await writeFile(path, encoded);
  await rm(lock, { recursive: true });
  run.reserveModel();
  const committed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(committed.globalHttpRequests, 1);
  assert.equal(committed.globalModelCalls, 2);
});
