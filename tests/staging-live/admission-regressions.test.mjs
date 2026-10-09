import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweep } from '../../scripts/e2e-staging/sweep.mjs';
import { stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { openRun, RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';

const request = { url: () => STAGING_ORIGIN + '/app-release', method: () => 'GET' };

test('sweep refuses skipped setup before the session callback without target or supervision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ['E2E_TARGET', 'E2E_RUN_SUPERVISED', 'E2E_RUN_ID', 'E2E_V2_OUTPUT'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  process.env.E2E_V2_OUTPUT = root;
  process.env.E2E_RUN_ID = 'synthetic-admission-run';
  for (const [target, supervised] of [[undefined, undefined], ['staging-live', undefined], [undefined, '1']]) {
    if (target === undefined) delete process.env.E2E_TARGET; else process.env.E2E_TARGET = target;
    if (supervised === undefined) delete process.env.E2E_RUN_SUPERVISED; else process.env.E2E_RUN_SUPERVISED = supervised;
    let sessions = 0;
    await assert.rejects(sweep({ targetName: 'staging-live', freshPage: () => assert.fail('unexpected page'),
      session: async () => { sessions++; throw new Error('session reached'); } }), /staging-target-required|supervised-run-required/);
    assert.equal(sessions, 0);
  }
});

test('browser forwarding refuses an absent run budget', async () => {
  let forwarded = 0;
  await assert.rejects(stagingFixtureWriteGuard({ run: null }).handle(request, async () => {
    forwarded++; return { status: () => 200 };
  }), /supervised-run-required/);
  assert.equal(forwarded, 0);
});

test('browser forwarding enforces the unchanged 400 request ceiling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-requests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = openRun(root, { runId: 'synthetic-request-run', events: null });
  t.after(() => run.dispose());
  const guard = stagingFixtureWriteGuard({ run });
  let forwarded = 0;
  const forward = async () => { forwarded++; return { status: () => 200 }; };
  for (let i = 0; i < RUN_LIMITS.httpRequests; i++) await guard.handle(request, forward);
  await assert.rejects(guard.handle(request, forward), /http-request-limit/);
  assert.equal(forwarded, 400);
  assert.equal(run.snapshot().httpRequests, 400);
  assert.equal(run.snapshot().stopReason, 'http-request-limit');
});
