import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

// The exact reproductions from the blocking reviews of #201 and #203, kept as one regression each.
const project = fileURLToPath(new URL('../../', import.meta.url));

test('#201: one capped run honors every selected lower limit at once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-review-repro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { currentRun } from './scripts/e2e-staging/run-limits.mjs';
    const run = currentRun();
    try {
      const { preflightRequest } = await import('./scripts/e2e-staging/session.mjs');
      let calls = 0;
      try { await preflightRequest('synthetic', async () => { calls++; return { status: () => 503 }; },
        { pause: async () => {}, signal: run.signal }); } catch {}
      const { createExplorationBatchPlan, createExplorationCallPlan } = await import('./scripts/e2e-staging/model-room.mjs');
      const config = (await import('./playwright.staging.config.mjs')).default;
      console.log(JSON.stringify([calls, createExplorationBatchPlan(2).batches[0].goalCount,
        createExplorationCallPlan(1).perGoal, config.timeout]));
    } finally { run.dispose(); }
  `], { cwd: project, timeout: 15_000, killSignal: 'SIGKILL', stdio: 'pipe', env: {
    ...process.env, E2E_V2_OUTPUT: root, E2E_RUN_ID: 'synthetic-review-repro',
    E2E_RUN_SUPERVISED: '1', E2E_TARGET: 'staging-live',
    E2E_RUN_LIMITS: JSON.stringify({ ...RUN_LIMITS, preflightAttempts: 1, batchGoals: 1, explorationSteps: 1, testTimeoutMs: 10 }),
  } }).toString();
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), [1, 1, 1, 10]);
});

test('#203: a resumed Calendar skip carrying a run-limit failure fails the run', () => {
  const targets = [{ name: 'desktop', surface: 'app', viewport: { width: 1440, height: 960 } }];
  const routedScreens = [{ name: 'Calendar', path: '/calendar', surface: 'app' }];
  const skip = { status: 'SKIPPED', reason: 'control-scope-unproved', execution: { press_attempted: false, handler_executions: 0 } };
  const run = createSweepRun({ targets, routedScreens });
  run.record({ ...routedScreens[0], ...skip, target: 'desktop', reached: false, controls: [] });
  let poisoned;
  for (const entry of run.pendingStates()) {
    const result = entry.spec.kind === 'calendar-operation' ? { ...skip, spec: entry.spec, steps: [] }
      : { ...routedScreens[0], ...skip, target: entry.target, state_scope: entry.key, reached: false, controls: [] };
    if (entry.spec.case === 'month-next-nonleap') { result.failure = { phase: 'run-limit', code: 'stop-signal' }; poisoned = entry.key; }
    run.recordState(entry.key, result);
  }
  assert.ok(poisoned, 'the Calendar plan still contains the reviewed case');
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40),
    carr_source_commit: contract.producer.source_commit };
  const resumed = createSweepRun({ targets, routedScreens, prior: { release, ...run.snapshot() } });
  assert.deepEqual(resumed.snapshot().stateObligations.find(entry => entry.key === poisoned).result.failure,
    { phase: 'run-limit', code: 'stop-signal' });
  assert.equal(resumed.verdict([]).failed, true);
});
