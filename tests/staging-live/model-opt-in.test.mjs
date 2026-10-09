import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createModelRoomModel, createModelCallBudget, dispatchThroughModelRoom, MODEL_ROOM_DISPATCH_CONTRACT } from '../../scripts/e2e-staging/model-room.mjs';
import { createHash } from 'node:crypto';
import { RUN_LIMITS, openRun } from '../../scripts/e2e-staging/run-limits.mjs';

const runId = 'synthetic-opt-in-run';
const environment = { E2E_RUN_ID: runId, E2E_ALLOW_MODEL_CALLS: runId };
const options = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] };
const completed = request => ({ msg_id: 'synthetic', desk: request.desk, task: request.task, kind: 'synthetic',
  dispatched_at: '2026-10-08T12:00:00Z', status: 'completed', result: JSON.stringify({ content: [{ type: 'text', text: '{}' }] }) });

async function temporaryRun(t, limits = RUN_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-model-opt-in-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = openRun(root, { runId, limits, events: null });
  t.after(() => run.dispose());
  return { root, run };
}

test('configured dispatcher and missing or mismatched opt-in cannot invoke a model', async t => {
  const { run } = await temporaryRun(t);
  let calls = 0;
  for (const authorization of [{}, { E2E_ALLOW_MODEL_CALLS: '1' }, { E2E_RUN_ID: runId, E2E_ALLOW_MODEL_CALLS: 'another-run' }]) {
    const model = createModelRoomModel({ run, environment: { CARR_MODEL_ROOM_DISPATCH: '/configured/dispatcher.py', ...authorization },
      dispatch: () => { calls++; assert.fail('unauthorized dispatch'); } });
    await assert.rejects(model.doGenerate(options), /model-calls-not-authorized-for-run/);
  }
  assert.equal(calls, 0);
  assert.equal(run.snapshot().modelCalls, 0);
  assert.equal(run.snapshot().artifactBytes, 0);
});

test('configured direct dispatcher refuses missing run authorization before reading its path', async t => {
  const { run } = await temporaryRun(t);
  for (const authorization of [{}, { E2E_RUN_ID: runId, E2E_ALLOW_MODEL_CALLS: '1' },
    { E2E_RUN_ID: 'other-run', E2E_ALLOW_MODEL_CALLS: 'other-run' }]) {
    await assert.rejects(dispatchThroughModelRoom({ desk: 'doctorcre-e2e', task: 'synthetic', fresh: true, run,
      environment: { CARR_MODEL_ROOM_DISPATCH: '/configured/nonexistent-dispatcher.py', ...authorization } }),
      error => error.code === 'model-calls-not-authorized-for-run');
  }
  await assert.rejects(dispatchThroughModelRoom({ desk: 'doctorcre-e2e', task: 'synthetic', fresh: true, run: null,
    environment: { ...environment, CARR_MODEL_ROOM_DISPATCH: '/configured/nonexistent-dispatcher.py' } }),
    error => error.code === 'model-calls-not-authorized-for-run');
  assert.equal(run.snapshot().modelCalls, 0);
});

test('authorized direct dispatcher consumes one persistent reservation per execution', async t => {
  const { root, run } = await temporaryRun(t, { ...RUN_LIMITS, modelCalls: 2 });
  const dispatcher = join(root, 'synthetic.py');
  const source = 'import json,sys\nsys.stdin.read()\nprint(json.dumps({"ok":True}))\n';
  await writeFile(dispatcher, source);
  const contract = { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(source).digest('hex') };
  const request = { desk: 'doctorcre-e2e', task: 'synthetic', fresh: true, run,
    environment: { ...process.env, ...environment }, dispatcherPath: dispatcher, dispatcherContract: contract };
  assert.deepEqual(await dispatchThroughModelRoom(request), { ok: true });
  assert.equal(run.snapshot().modelCalls, 1);
  assert.deepEqual(await dispatchThroughModelRoom(request), { ok: true });
  assert.equal(run.snapshot().modelCalls, 2);
  await assert.rejects(dispatchThroughModelRoom(request), error => error.code === 'model-call-limit');
  assert.equal(run.snapshot().modelCalls, 2);
  assert.equal(run.snapshot().stopReason, 'model-call-limit');
});

test('planned call exhaustion stops the shared run while retaining the original cap error', async t => {
  const { run } = await temporaryRun(t, { ...RUN_LIMITS, modelCalls: 2 });
  const model = createModelRoomModel({ run, environment, budget: createModelCallBudget(1), dispatch: async request => completed(request) });
  await model.doGenerate(options);
  await assert.rejects(model.doGenerate(options), error => error.code === 'planned-model-call-limit' && /aggregate model-call limit of 1/.test(error.message));
  assert.equal(run.snapshot().modelCalls, 1);
  assert.equal(run.snapshot().stopReason, 'planned-model-call-limit');
  assert.throws(() => run.check(), error => error.code === 'planned-model-call-limit');
});

test('cancelled and over-quota inputs cannot start model dispatch', async t => {
  const { run } = await temporaryRun(t, { ...RUN_LIMITS, artifactBytes: 128 });
  let calls = 0;
  const model = createModelRoomModel({ run, environment, dispatch: () => { calls++; assert.fail('unbounded dispatch'); } });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(model.doGenerate({ ...options, abortSignal: abort.signal }), /abort/i);
  await assert.rejects(model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(129) }] }] }), /artifact-byte-limit/);
  assert.equal(calls, 0);
  assert.equal(run.snapshot().modelCalls, 0);
});

test('model reservations survive a process restart and a second model instance', async t => {
  const limits = { ...RUN_LIMITS, modelCalls: 2 };
  const { root, run } = await temporaryRun(t, limits);
  const model = createModelRoomModel({ run, environment, dispatch: async request => completed(request) });
  await model.doGenerate(options);
  assert.equal(run.snapshot().modelCalls, 1);
  const script = join(root, 'restart.mjs');
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { createModelRoomModel } from ${JSON.stringify(new URL('../../scripts/e2e-staging/model-room.mjs', import.meta.url).href)};
    import { openRun } from ${JSON.stringify(new URL('../../scripts/e2e-staging/run-limits.mjs', import.meta.url).href)};
    const run = openRun(${JSON.stringify(root)}, { runId: ${JSON.stringify(runId)}, limits: ${JSON.stringify(limits)}, events: null });
    const model = createModelRoomModel({ run, environment: ${JSON.stringify(environment)}, dispatch: async request => (${completed.toString()})(request) });
    assert.equal(run.snapshot().modelCalls, 1);
    await model.doGenerate(${JSON.stringify(options)});
    await assert.rejects(model.doGenerate(${JSON.stringify(options)}), /model-call-limit/);
    assert.equal(run.snapshot().modelCalls, 2);
    run.dispose();
  `);
  await promisify(execFile)(process.execPath, [script], { timeout: 5_000 });
  assert.equal(JSON.parse(await readFile(join(root, 'run-budget.json'), 'utf8')).modelCalls, 2);
});

test('both configs require matching run opt-in before exposing model agents', async () => {
  const { loadConfigModule } = await import('../../node_modules/e2e/dist/config/load.js');
  const previous = Object.fromEntries(['E2E_TARGET', 'E2E_RUN_ID', 'E2E_ALLOW_MODEL_CALLS', 'CI'].map(key => [key, process.env[key]]));
  try {
    process.env.E2E_TARGET = 'staging-live';
    delete process.env.CI;
    process.env.E2E_RUN_ID = runId;
    for (const allowed of [undefined, '1', 'another-run', runId]) {
      if (allowed === undefined) delete process.env.E2E_ALLOW_MODEL_CALLS;
      else process.env.E2E_ALLOW_MODEL_CALLS = allowed;
      for (const file of ['e2e.config.ts', 'e2e.regressions.config.ts']) {
        const config = await loadConfigModule(new URL('../../' + file, import.meta.url).pathname);
        assert.equal(Boolean(config.agents?.default), allowed === runId, file + ' opt-in ' + allowed);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
