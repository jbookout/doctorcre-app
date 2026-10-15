import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { prepareStagingRecords, stagingFixtureWriteGuard, assertStagingWriteCoverage } from '../../scripts/e2e-staging/records.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { fakeAPI } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { refuseFixtureCompanionConnection, assertCompanionUnavailable } from './companion-fixture.mjs';

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40),
  carr_source_commit: staging.producer.source_commit };
const request = (path = '/api/state', method = 'GET') => ({
  url: () => 'http://127.0.0.1:4682' + path, method: () => method,
});

for (const malformed of [false, true]) test(`served-app companion transport ${malformed ? 'keeps malformed replies unresolved' : 'retains a forwarded connection refusal'}`, async t => {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'served-companion-fixture-'));
  const run = openRun(output, { runId: 'synthetic-served-companion', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  await prepareStagingRecords(output, { ...fakeAPI(output, { sourceRelease: release }), run });
  const guard = stagingFixtureWriteGuard({ output, release, run });
  const scoped = guard.forContext();
  let forwarded = 0;
  await assert.rejects(scoped.handle(request(), async () => {
    forwarded++;
    if (malformed) return { status: () => 200, json: async () => ({ items: [] }) };
    refuseFixtureCompanionConnection(request());
  }), error => malformed ? error.code === 'companion-dispatch-outcome-unresolved'
    : error.code === 'ECONNREFUSED' && error.companionRead === true);
  assert.equal(forwarded, 1);
  const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
  assert.equal(plan.browser_write_attempts?.length || 0, 0);
  if (malformed) {
    assert.equal(plan.companion_attempts[0].state, 'unresolved');
    await assert.rejects(guard.assertCoverage(), /coverage|reconciliation/);
    await assert.rejects(assertStagingWriteCoverage(output), /coverage|reconciliation/);
  } else {
    assertCompanionUnavailable(plan);
    assert.equal(plan.browser_write_refusals?.length || 0, 0);
    await guard.assertCoverage();
    await assertStagingWriteCoverage(output);
  }
});

test('the served-app companion fake refuses unexpected companion routes and methods', () => {
  assert.throws(() => refuseFixtureCompanionConnection(request('/api/post-call/sync')), assert.AssertionError);
  assert.throws(() => refuseFixtureCompanionConnection(request('/api/state', 'POST')), assert.AssertionError);
  assert.equal(refuseFixtureCompanionConnection({ url: () => staging.origin + '/app-release' }), undefined);
});
