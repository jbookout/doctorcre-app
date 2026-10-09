import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openRun, RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';
import { supervise } from '../../scripts/e2e-staging/supervise.mjs';
import { calendarCases, requestedCalendarState } from '../../scripts/e2e-staging/state-plan.mjs';
import { screens, targets } from '../../scripts/e2e-staging/screens.mjs';
import { sweepOwnerStates } from '../../scripts/e2e-staging/owner-states.mjs';
import { createModelRoomModel, dispatchThroughModelRoom, MODEL_ROOM_DISPATCH_CONTRACT } from '../../scripts/e2e-staging/model-room.mjs';

async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-review-blockers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const policy = { ...RUN_LIMITS, stopGraceMs: 250, monitorIntervalMs: 100 };
const runLimitsURL = new URL('../../scripts/e2e-staging/run-limits.mjs', import.meta.url).href;
const modelURL = new URL('../../scripts/e2e-staging/model-room.mjs', import.meta.url).href;
const authorization = run => ({ E2E_RUN_ID: run.id, E2E_ALLOW_MODEL_CALLS: run.id });

test('supervisor admits authentication with no caller staging target', async t => {
  const output = await rootFor(t);
  const environment = { ...process.env };
  for (const key of ['E2E_TARGET', 'E2E_RUN_ID', 'E2E_RUN_SUPERVISED']) delete environment[key];
  const worker = `import { requireSupervisedRun } from ${JSON.stringify(runLimitsURL)}; requireSupervisedRun();`;
  await supervise({ command: process.execPath, args: ['--input-type=module', '-e', worker], output, environment, limits: policy });
});

test('finite HTTP budget admits all Calendar contexts and the routed base screen loads', async t => {
  const output = await rootFor(t);
  const run = openRun(output, { runId: 'synthetic-full-plan', events: null });
  t.after(() => run.dispose());
  const routes = await screens();
  const contexts = targets.reduce((total, target) => total + routes.filter(row => row.surface === target.surface).length +
    (target.surface === 'app' ? calendarCases.length + 3 : 0), 0);
  // Includes transitive modules, fonts, release probes and reads beyond the 14-request minimum.
  for (let context = 0; context < contexts; context++)
    for (let request = 0; request < 40; request++) await run.http(() => true);
  assert.equal(run.snapshot().httpRequests, contexts * 40);
  assert.ok(Number.isSafeInteger(run.limits.httpRequests));
});

test('explicit supervisor invocation renews stopped budgets and preserves checkpoint evidence', async t => {
  const output = await rootFor(t);
  const events = new EventEmitter();
  const first = openRun(output, { runId: 'synthetic-resume-budget', events, limits: policy });
  first.reserveModel();
  const deadline = first.deadline;
  first.reserveBytes(100);
  const retainedBytes = first.snapshot().artifactBytes;
  events.emit('SIGINT'); first.dispose();
  const evidence = 'synthetic checkpoint and write receipt';
  await writeFile(join(output, 'checkpoint.json'), evidence);
  await new Promise(resolve => setTimeout(resolve, 5));
  const state = await supervise({ command: process.execPath, args: ['-e', ''], output,
    environment: { ...process.env, E2E_RUN_ID: first.id }, limits: policy });
  assert.equal(state.id, first.id);
  assert.equal(state.stopReason, null);
  assert.equal(state.modelCalls, 0);
  assert.ok(state.artifactBytes >= retainedBytes);
  assert.ok(state.deadline > deadline);
  assert.equal(await readFile(join(output, 'checkpoint.json'), 'utf8'), evidence);
  assert.equal(state.invocations.at(-1).stopReason, 'stop-signal');
  assert.equal(state.invocations.at(-1).modelCalls, 1);
});

test('two authorized exploration batches receive separate bounded model budgets', async t => {
  const output = await rootFor(t);
  const worker = count => `import { currentRun } from ${JSON.stringify(runLimitsURL)}; const run = currentRun(); for(let i=0;i<${count};i++){run.reserveModel(); if(i%10===0)await new Promise(resolve=>setTimeout(resolve,1));}`;
  const environment = { ...process.env, E2E_RUN_ID: 'synthetic-batch-budget', E2E_ALLOW_MODEL_CALLS: 'synthetic-batch-budget' };
  const first = await supervise({ command: process.execPath, args: ['--input-type=module', '-e', worker(4050)], output, environment, limits: policy });
  assert.equal(first.modelCalls, 4050);
  const second = await supervise({ command: process.execPath, args: ['--input-type=module', '-e', worker(3240)], output, environment, limits: policy });
  assert.equal(second.modelCalls, 3240);
  assert.equal(second.invocations.at(-1).modelCalls, 4050);
});

test('ordered board projects drain late Calendar query owners on their app viewports', async () => {
  const pending = [], measured = [];
  const run = { pendingStates: () => pending.filter(row => !measured.some(result => result.key === row.key)),
    recordState: (key, result) => measured.push({ key, result }), snapshot: () => ({ stateObligations: pending }) };
  for (const project of targets) {
    if (project.surface === 'board') {
      const target = targets.find(row => row.surface === 'app' && row.viewport.width === project.viewport.width);
      pending.push({ key: project.name, target: target.name, spec: requestedCalendarState('/calendar?view=week&d=2028-02-29&day=2028-02-29') });
    }
    await sweepOwnerStates({ run, targets, targetName: project.name, routedScreens: [{ path: '/calendar', surface: 'app' }],
      freshPageFor: (target, screen, spec) => {
        assert.equal(target.surface, 'app');
        assert.deepEqual(target.viewport, project.viewport);
        return async () => ({ context: () => ({ close: async () => {} }),
          evaluate: async () => ({ status: 'ready', entries: [] }), url: () => 'https://synthetic.invalid' + (spec.url || screen.path) });
      }, evidence: async () => '/synthetic/calendar.png', persist: async () => {},
      sweep: async ({ target, freshPage }) => ({ target, url: (await freshPage()).url() }) });
  }
  assert.deepEqual(measured.map(row => row.result.target), ['staging-live', 'staging-live-phone']);
  assert.ok(measured.every(row => row.result.url.endsWith('/calendar?view=week&d=2028-02-29&day=2028-02-29')));
});

for (const failure of ['envelope-detail', 'nonzero-stderr']) test(failure + ' never reaches a retained supervised log', async t => {
  const output = await rootFor(t);
  const canary = 'synthetic_sensitive_review_canary';
  let worker;
  if (failure === 'envelope-detail') {
    worker = `import { currentRun } from ${JSON.stringify(runLimitsURL)}; import { createModelRoomModel } from ${JSON.stringify(modelURL)};
      const run=currentRun(); const model=createModelRoomModel({run, dispatch:async ({desk,task})=>({msg_id:'synthetic',desk,task,kind:'synthetic',dispatched_at:'2026-10-09',status:'failed',detail:${JSON.stringify(canary)}})});
      try { await model.doGenerate({prompt:[]}); } catch(error) { if(error.code !== 'model-room-desk-incomplete') throw error; console.error(error.message); }`;
  } else {
    const dispatcher = join(output, 'synthetic.py');
    await writeFile(dispatcher, `import sys\nsys.stdin.read()\nprint('${canary}',file=sys.stderr)\nsys.exit(1)\n`);
    const contract = { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(await readFile(dispatcher)).digest('hex') };
    worker = `import { currentRun } from ${JSON.stringify(runLimitsURL)}; import { dispatchThroughModelRoom } from ${JSON.stringify(modelURL)};
      try { await dispatchThroughModelRoom({desk:'doctorcre-e2e',task:'synthetic',fresh:true,run:currentRun(),dispatcherPath:${JSON.stringify(dispatcher)},dispatcherContract:${JSON.stringify(contract)}}); } catch(error) { if(error.code !== 'model-room-dispatcher-failed') throw error; console.error(error.message); }`;
  }
  await supervise({ command: process.execPath, args: ['--input-type=module', '-e', worker], output,
    environment: { ...process.env, E2E_RUN_ID: 'synthetic-log-budget', E2E_ALLOW_MODEL_CALLS: 'synthetic-log-budget' }, limits: policy });
  assert.doesNotMatch(await readFile(join(output, 'run.log'), 'utf8'), new RegExp(canary));
});

for (const refused of [0, 'SIGTERM']) test('dispatcher cleanup verifies disappearance after EPERM on ' + refused, async t => {
  const output = await rootFor(t);
  const dispatcher = join(output, 'ephemeral.py');
  await writeFile(dispatcher, 'import json,sys\nsys.stdin.read()\nprint(json.dumps({"ok":True}))\n');
  const contract = { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(await readFile(dispatcher)).digest('hex') };
  const original = process.kill;
  let injected = false, probes = 0;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 0) probes++;
    if (!injected && pid < 0 && signal === refused) { injected = true; throw Object.assign(new Error('synthetic refusal'), { code: 'EPERM' }); }
    return original(pid, signal);
  };
  try {
    const run = openRun(output, { runId: 'synthetic-eperm-budget', events: null });
    t.after(() => run.dispose());
    assert.deepEqual(await dispatchThroughModelRoom({ desk:'doctorcre-e2e', task:'synthetic', fresh:true,
      dispatcherPath:dispatcher, dispatcherContract:contract, run, environment:{...process.env,...authorization(run)} }), {ok:true});
    assert.equal(injected, true);
    assert.ok(probes > 1, 'cleanup continues probing after the refusal');
  } finally { process.kill = original; }
});

test('exploration exposes only the operative run cancellation interface', async () => {
  const exploration = await import('../../scripts/e2e-staging/explore.mjs');
  assert.equal(exploration.createExplorationRunSignals, undefined);
});


test('invocation renewal refuses unsettled prior process and HTTP reservations', async t => {
  const output = await rootFor(t);
  const run = openRun(output, { runId: 'synthetic-unsettled-budget', events: null });
  t.after(() => run.dispose());
  const release = run.reserveProcessGroup();
  assert.throws(() => openRun(output, { runId: run.id, events: null, newInvocation: true }), { code: 'prior-invocation-unsettled' });
  release();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let complete;
  const pending = run.http(() => { started(); return new Promise(resolve => { complete = resolve; }); });
  await ready;
  assert.throws(() => openRun(output, { runId: run.id, events: null, newInvocation: true }), { code: 'prior-invocation-unsettled' });
  complete(); await pending;
});


test('a first supervisor invocation has no fabricated prior budget', async t => {
  const output = await rootFor(t);
  const state = await supervise({ command: process.execPath, args: ['-e', ''], output, environment: { ...process.env, E2E_RUN_ID: 'synthetic-first-budget' }, limits: policy });
  assert.deepEqual(state.invocations || [], []);
});

test('a new invocation admits the current finite policy while retaining the old limits in history', async t => {
  const output = await rootFor(t);
  const previousLimits = { ...policy, httpRequests: 400 };
  const previous = openRun(output, { runId: 'synthetic-updated-policy', limits: previousLimits, events: null });
  previous.stop('stop-signal'); previous.dispose();
  assert.throws(() => openRun(output, { runId: previous.id, limits: policy, events: null }), { code: 'run-ledger-invalid' });
  const state = await supervise({ command: process.execPath, args: ['-e', ''], output, environment: { ...process.env, E2E_RUN_ID: previous.id }, limits: policy });
  assert.deepEqual(state.limits, policy);
  assert.deepEqual(state.invocations.at(-1).limits, previousLimits);
});
