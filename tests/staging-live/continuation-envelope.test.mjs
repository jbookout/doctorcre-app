import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { RUN_LIMITS, openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { restoreContinuation, sealContinuation } from '../../scripts/e2e-staging/continuation-envelope.mjs';

const sourcePair = { source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const secret = 'synthetic-continuation-secret-value-that-is-not-real';
const privateCanary = 'SYNTHETIC_PRIVATE_CONTROL_CANARY_84d177';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-continuation-'));
  const restored = join(root, 'restored');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'source');
  const run = openRun(output, { runId: 'synthetic-continuation-run', events: null });
  t.after(() => run.dispose());
  const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin, state: 'complete', run: id(1),
    release: sourcePair, keys: {}, names: {}, records: {}, receipts: {}, current_step: 'complete', observed_at: '2026-10-14T00:00:00.000Z' };
  const setup = { schema: 'doctorcre-staging-records.v1', origin: contract.origin, release: sourcePair, complete: true,
    records: {}, eligibleLead: null, findings: [], needs_restore: [] };
  const controls = { release: { service: 'doctorcre-app', environment: 'staging', ...sourcePair }, screens: [], history: [],
    explorations: [], findings: [], setup: { complete: true, private_canary: privateCanary }, expectedScreens: 62, expectedExplorations: 93,
    stateObligations: [], expectedStates: 62 };
  await writeFile(join(output, 'controls.json'), JSON.stringify(controls), { mode: 0o600 });
  await writeFile(join(output, 'staging-records.json'), JSON.stringify(setup), { mode: 0o600 });
  await writeFile(join(output, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return { root, output, restored, run };
}

async function seal(f) {
  return sealContinuation({ output: f.output, envelopePath: join(f.root, 'resume.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: f.run });
}

test('seals only the three progress files and cumulative budget; restore validates then atomically publishes private files', async t => {
  const f = await fixture(t);
  await f.run.http(() => true);
  f.run.reserveModel();
  const sealed = await seal(f);
  const bytes = await readFile(sealed.path);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(bytes.includes(Buffer.from(privateCanary)), false);
  assert.equal(bytes.includes(Buffer.from('controls.json')), false);
  assert.equal(sealed.generation, 1);
  const receipt = await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } });
  assert.equal(receipt.generation, 1);
  assert.deepEqual((await readdir(f.restored)).sort(), ['controls.json', 'run-budget.json', 'staging-records-plan.json', 'staging-records.json']);
  assert.equal((await readFile(join(f.restored, 'controls.json'), 'utf8')).length > 0, true);
  const budget = JSON.parse(await readFile(join(f.restored, 'run-budget.json'), 'utf8'));
  assert.equal(budget.globalHttpRequests, 1);
  assert.equal(budget.globalModelCalls, 1);
  assert.equal(budget.httpRequests, 1);
  assert.equal(budget.modelCalls, 1);
  assert.ok(budget.artifactBytes > 0);
  assert.equal((await readdir(f.root)).includes('public'), false);
  const next = openRun(f.restored, { runId: f.run.id, events: null, newInvocation: true });
  t.after(() => next.dispose());
  assert.equal(next.snapshot().globalHttpRequests, 1);
  assert.equal(next.snapshot().globalModelCalls, 1);
  assert.equal(next.snapshot().httpRequests, 0);
  assert.equal(next.snapshot().modelCalls, 0);
});

test('restore fsyncs and publishes private regular files, refuses existing targets and serializes competing publishers', async t => {
  const f = await fixture(t), sealed = await seal(f);
  const expected = { ...sealed, sourcePair, runId: f.run.id, predecessor: null };
  await mkdir(f.restored);
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret, expected }),
    { code: 'continuation-destination-exists' });
  await rmdir(f.restored);

  const results = await Promise.allSettled([
    restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret, expected }),
    restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret, expected }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  const rejected = results.find(row => row.status === 'rejected');
  assert.ok(['continuation-destination-busy', 'continuation-destination-exists'].includes(rejected.reason.code));
  assert.deepEqual((await readdir(f.restored)).sort(), ['controls.json', 'run-budget.json', 'staging-records-plan.json', 'staging-records.json']);
  assert.equal((await stat(f.restored)).mode & 0o777, 0o700);
  for (const name of await readdir(f.restored)) assert.equal((await stat(join(f.restored, name))).mode & 0o777, 0o600);
});

test('wrong key and ciphertext tampering fail closed without a partial restore', async t => {
  const f = await fixture(t), sealed = await seal(f);
  const expected = { ...sealed, sourcePair, runId: f.run.id, predecessor: null };
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret: 'wrong synthetic key', expected }), { code: 'continuation-auth-failed' });
  await assert.rejects(readFile(join(f.restored, 'controls.json')), { code: 'ENOENT' });
  const corrupted = join(f.root, 'corrupt.carr');
  const envelope = JSON.parse(await readFile(sealed.path, 'utf8'));
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  const data = Buffer.from(JSON.stringify(envelope));
  await writeFile(corrupted, data);
  await assert.rejects(restoreContinuation({ envelopePath: corrupted, destination: f.restored, secret, expected: { ...expected, sha256: sha256(data) } }), { code: 'continuation-auth-failed' });
  await assert.rejects(readFile(join(f.restored, 'controls.json')), { code: 'ENOENT' });
});

test('trusted generation, artifact digest, predecessor, source pair and contract plan bindings reject stale or mismatched envelopes', async t => {
  const f = await fixture(t), sealed = await seal(f);
  const expected = { ...sealed, sourcePair, runId: f.run.id, predecessor: null };
  for (const changed of [
    { generation: 2 }, { sha256: 'b'.repeat(64) }, { predecessor: { generation: 0, sha256: 'c'.repeat(64) } },
    { sourcePair: { ...sourcePair, source_commit: 'd'.repeat(40) } }, { planHash: 'e'.repeat(64) }, { contractHash: 'f'.repeat(64) },
    { runId: 'synthetic-another-run' },
  ]) {
    await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: join(f.root, 'reject-' + Object.keys(changed)[0]), secret, expected: { ...expected, ...changed } }));
  }
});

test('short run IDs, unknown paths, invalid plan schemas and sensitive canary fields are refused before sealing', async t => {
  const f = await fixture(t);
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(f.root, 'short.carr'), secret,
    sourcePair, runId: 'short', generation: 1, predecessor: null, run: f.run }), { code: 'continuation-invalid-binding' });
  await writeFile(join(f.output, 'storage-state.json'), JSON.stringify({ cookies: [] }), { mode: 0o600 });
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(f.output, 'resume.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: f.run }), { code: 'continuation-path-refused' });
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(f.output, '..cache', 'resume.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: f.run }), { code: 'continuation-path-refused' });
  const mismatchedRun = Object.create(f.run);
  Object.defineProperty(mismatchedRun, 'root', { value: f.root });
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(f.root, 'wrong-root.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: mismatchedRun }), { code: 'continuation-budget-invalid' });
  const sealed = await seal(f);
  assert.equal((await readFile(sealed.path)).includes(Buffer.from('cookies')), false);
  await rm(join(f.output, 'storage-state.json'));
  const canary = await fixture(t);
  const shortPlan = JSON.parse(await readFile(join(canary.output, 'staging-records-plan.json'), 'utf8'));
  shortPlan.run = 'short';
  await writeFile(join(canary.output, 'staging-records-plan.json'), JSON.stringify(shortPlan), { mode: 0o600 });
  await assert.rejects(sealContinuation({ output: canary.output, envelopePath: join(canary.root, 'short-plan.carr'), secret,
    sourcePair, runId: canary.run.id, generation: 1, predecessor: null, run: canary.run }), { code: 'continuation-payload-invalid' });
  const canaryWithAuthField = await fixture(t);
  await writeFile(join(canaryWithAuthField.output, 'controls.json'), JSON.stringify({ release: { service: 'doctorcre-app', environment: 'staging', ...sourcePair },
    screens: [], history: [], explorations: [], findings: [], setup: { sessionToken: 'SYNTHETIC_SECRET_CANARY' }, expectedScreens: 0,
    expectedExplorations: 0, stateObligations: [], expectedStates: 0 }), { mode: 0o600 });
  await assert.rejects(sealContinuation({ output: canaryWithAuthField.output, envelopePath: join(canaryWithAuthField.root, 'canary.carr'), secret,
    sourcePair, runId: canaryWithAuthField.run.id, generation: 1, predecessor: null, run: canaryWithAuthField.run }), { code: 'continuation-sensitive-field-refused' });
});

test('symlink ancestors, hardlinked private sources and permissive private directories fail closed', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target');
  await mkdir(target, { mode: 0o700 });
  const linked = join(f.root, 'linked');
  await symlink(target, linked);
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(linked, 'resume.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: f.run }), { code: 'continuation-path-refused' });

  const hardlink = join(f.root, 'controls-hardlink.json');
  await link(join(f.output, 'controls.json'), hardlink);
  await assert.rejects(seal(f), { code: 'continuation-payload-invalid' });
  await rm(hardlink);

  await chmod(f.output, 0o755);
  await assert.rejects(seal(f), { code: 'continuation-private-permissions-refused' });
  await chmod(f.output, 0o700);

  const looseParent = join(f.root, 'loose-parent');
  await mkdir(looseParent, { mode: 0o700 });
  await chmod(looseParent, 0o755);
  const sealed = await seal(f);
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: join(looseParent, 'restored'), secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } }),
  { code: 'continuation-private-permissions-refused' });
  await chmod(looseParent, 0o700);
});

test('sealing requires an existing private parent and canonical acknowledged write coverage', async t => {
  const f = await fixture(t);
  const missingParent = join(f.root, 'not-created');
  await assert.rejects(sealContinuation({ output: f.output, envelopePath: join(missingParent, 'resume.carr'), secret,
    sourcePair, runId: f.run.id, generation: 1, predecessor: null, run: f.run }), { code: 'continuation-path-refused' });
  await assert.rejects(stat(missingParent), { code: 'ENOENT' });

  const planPath = join(f.output, 'staging-records-plan.json');
  const basePlan = JSON.parse(await readFile(planPath, 'utf8'));
  const attemptedAt = new Date().toISOString();
  const negatives = [
    [{ state: 'inflight' }],
    [{ state: 'acknowledged', response: { acknowledged: false } }],
    [{ state: 'acknowledged', response: { acknowledged: true,
      receipt: { ok: true, deal_id: '70000000-0000-4000-8000-000000000001',
        next_step_id: '70000000-0000-4000-8000-000000000002', next_action_id: '70000000-0000-4000-8000-000000000003',
        supersedes: null, created_at: attemptedAt } },
      record_ids: ['70000000-0000-4000-8000-000000000001'], operation: 'set-next-step',
      arguments: { deal: '70000000-0000-4000-8000-000000000001', text: 'Synthetic continuation canary',
        idempotency_key: '70000000-0000-4000-8000-000000000004' }, attempted_at: attemptedAt }],
  ];
  for (const attempts of negatives) {
    await writeFile(planPath, JSON.stringify({ ...basePlan, browser_write_attempts: attempts }), { mode: 0o600 });
    await assert.rejects(seal(f), { code: 'continuation-write-coverage-incomplete' });
  }
  await writeFile(planPath, JSON.stringify(basePlan), { mode: 0o600 });
  const sealed = await seal(f);
  const absentRestoreParent = join(f.root, 'restore-parent-missing');
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: join(absentRestoreParent, 'restored'), secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } }), { code: 'continuation-path-refused' });
  await assert.rejects(stat(absentRestoreParent), { code: 'ENOENT' });
});

test('invalid private record schemas and incomplete or unsettled budget are refused', async t => {
  const f = await fixture(t);
  await writeFile(join(f.output, 'staging-records.json'), JSON.stringify({ schema: 'wrong', complete: true }), { mode: 0o600 });
  await assert.rejects(seal(f), { code: 'continuation-payload-invalid' });
  const other = await fixture(t);
  other.run.reserveProcessGroup();
  await assert.rejects(seal(other), { code: 'continuation-budget-unsettled' });
});

test('fixed run-limit defaults remain the 20,000 request, 5,000 model, and 256 MiB whole-run ceilings', () => {
  assert.equal(RUN_LIMITS.httpRequests, 20_000);
  assert.equal(RUN_LIMITS.modelCalls, 5_000);
  assert.equal(RUN_LIMITS.artifactBytes, 256 * 1024 * 1024);
});
