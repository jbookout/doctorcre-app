import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RUN_LIMITS, RunLimitError, directoryBytes, openRun } from '../../scripts/e2e-staging/run-limits.mjs';

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
  assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-unreadable'));
  for (const falsey of [null, false, 0]) {
    await writeFile(path, JSON.stringify(falsey));
    assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-invalid'));
  }
  for (const corrupt of [{ schema: 'unknown' }, { modelCalls: -1 }, { activeHttp: [] }, { queuedHttp: null }, { processGroups: null }, { processGroups: [] }, { stopReason: 3 }, { deadline: 0 }, { id: 'wrong-run' }]) {
    await writeFile(path, JSON.stringify({ ...JSON.parse(original), ...corrupt }));
    assert.throws(() => openRun(root, { limits, runId: run.id, events: null }), code('run-ledger-invalid'));
  }
  await writeFile(path, original);
  assert.equal(run.snapshot().modelCalls, 0);
});


test('environment limits are partial, lower-only, typed and canonical', async () => {
  const { runLimitsFromEnvironment } = await import('../../scripts/e2e-staging/run-limits.mjs');
  assert.deepEqual(runLimitsFromEnvironment({}), RUN_LIMITS);
  assert.deepEqual(runLimitsFromEnvironment({ E2E_RUN_LIMITS: '{"httpRequests":120,"modelCalls":0}' }),
    { ...RUN_LIMITS, httpRequests: 120, modelCalls: 0 });
  for (const value of ['', 'null', '[]', 'false', '{broken}', '{"unknown":1}', '{"__proto__":{}}',
    '{"httpRequests":"120"}', '{"httpRequests":0}', '{"httpRequests":1.5}', '{"modelCalls":-1}'])
    assert.throws(() => runLimitsFromEnvironment({ E2E_RUN_LIMITS: value }), code('invalid-run-limits'));
  for (const [key, maximum] of Object.entries(RUN_LIMITS))
    assert.throws(() => runLimitsFromEnvironment({ E2E_RUN_LIMITS: JSON.stringify({ [key]: maximum + 1 }) }), code('invalid-run-limits'));
  assert.throws(() => runLimitsFromEnvironment({ E2E_RUN_LIMITS: '{"httpRequests":3}' }, { ...RUN_LIMITS, httpRequests: 2 }), code('invalid-run-limits'));
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
