import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canary, canaryRequestAllowed, canaryLimits, canaryFailure, qualifiedModelRoom, assertQualifiedDesk, assertBudget, assertGitHubArtifact,
  assertSeparated, boundedInvocation, runBusinessPhase, assertCheckout, verifyFrozenSource, publicationBoundary,
  assertSourcePair, invocationBoundary, assertTrustedArtifact, assertFirstWorkflowAttempt, digestDownloadedContinuation,
  assertAdoptionReceipt, assertReadonlyResult, assertJourneyQualification, retainJourneyQualification,
  assertRestoredEvidence } from '../../scripts/e2e-staging/continue-run.mjs';
import { RUN_LIMITS, openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const binding = { checkout: sha, app: sha, carr: contract.producer.source_commit };
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: sha, carr_source_commit: binding.carr };

test('canary admits the staging shell, static modules and dedicated identity read; RPC and writes never enter browser canary traffic', () => {
  for (const path of ['/', '/js/app.js', '/js/auto-refresh.mjs', '/css/app.css', '/assets/logo.svg', '/api/system-work/session'])
    assert.equal(canaryRequestAllowed('GET', contract.origin + path), true);
  for (const [method, url] of [['POST', contract.origin + '/mcp'], ['POST', contract.origin + '/auth/e2e-session'],
    ['GET', contract.origin + '/auth/session'], ['GET', contract.origin + '/mcp'],
    ['GET', contract.origin + '/api/records'], ['GET', contract.carr_origin + '/release'],
    ['GET', 'https://app.doctorcre.com/'], ['GET', contract.origin + '/js/a.js?token=private']])
    assert.equal(canaryRequestAllowed(method, url), false);
});

test('canary preserves canonical HTTP timeout, two-way concurrency and queue admission while reporting only closed diagnostics', async () => {
  const limits = await canaryLimits(120_000);
  for (const key of Object.keys(RUN_LIMITS).filter(key => !['modelCalls', 'httpRequests', 'artifactBytes', 'runTimeoutMs', 'testTimeoutMs'].includes(key)))
    assert.equal(limits[key], RUN_LIMITS[key], key);
  assert.equal(limits.httpTimeoutMs, 30_000);
  assert.deepEqual(canaryFailure({ schema: 'doctorcre-staging-canary-phase.v1', phase: 'asset-settlement' }, 'http-admission-timeout'),
    { phase: 'asset-settlement', stopReason: 'http-admission-timeout' });
  assert.deepEqual(canaryFailure({ schema: 'doctorcre-staging-canary-phase.v1', phase: 'source-readback' }, 'source-pair-mismatch'),
    { phase: 'source-readback', stopReason: 'source-pair-mismatch' });
  assert.deepEqual(canaryFailure({ schema: 'doctorcre-staging-startup-canary.v1', status: 'AUTHENTICATED_READ_ONLY_CANARY', acceptedV1: false }, 'process-cleanup-unverified'),
    { phase: 'cleanup', stopReason: 'process-cleanup-unverified' });
  const safe = canaryFailure({ schema: 'doctorcre-staging-canary-phase.v1', phase: 'private-cookie-marker' }, 'raw-provider-private-message');
  assert.deepEqual(safe, { phase: 'startup', stopReason: 'worker-failed' });
});

test('source pair rejects old app, production, changed backend and unbound checkout', () => {
  assert.doesNotThrow(() => assertSourcePair(release, binding));
  for (const delta of [{ source_commit: 'c'.repeat(40) }, { environment: 'production' }, { carr_source_commit: 'c'.repeat(40) }])
    assert.throws(() => assertSourcePair({ ...release, ...delta }, binding));
  assert.throws(() => assertSourcePair(release, { ...binding, checkout: 'main' }));
});

test('invocation boundary never extends immutable deadline or absolute cutoff', () => {
  const now = Date.parse('2026-10-14T22:00:00Z');
  assert.equal(invocationBoundary({ now, deadline: now + 1000, sliceMs: 5000 }), now + 1000);
  assert.equal(invocationBoundary({ now, deadline: now + 5000, sliceMs: 1000 }), now + 1000);
  const cutoff = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(invocationBoundary({ now: cutoff - 1000, deadline: cutoff + 5000, sliceMs: 5000 }), cutoff);
  for (const deadline of [now, now - 1, NaN]) assert.throws(() => invocationBoundary({ now, deadline, sliceMs: 1000 }));
  assert.throws(() => invocationBoundary({ now: cutoff, deadline: cutoff + 1000, sliceMs: 1000 }));
});

test('artifact identity and chain expectations come from trusted predecessor outputs, never offered metadata', () => {
  const expected = { artifactId: '123', digest, generation: 1, predecessor: null, planHash: 'e'.repeat(64), size: 4096 };
  assert.doesNotThrow(() => assertTrustedArtifact({ ...expected }, expected));
  for (const delta of [{ artifactId: '124' }, { digest: 'c'.repeat(64) }, { generation: 0 },
    { predecessor: digest }, { planHash: 'c'.repeat(64) }, { size: 4097 }])
    assert.throws(() => assertTrustedArtifact({ ...expected, ...delta }, expected));
  for (const delta of [{ artifactId: '' }, { digest: '' }, { generation: '1' }, { size: 0 }])
    assert.throws(() => assertTrustedArtifact(expected, { ...expected, ...delta }));
});

test('a rerun attempt or a second same-slot artifact cannot supply a continuation predecessor', async () => {
  assert.doesNotThrow(() => assertFirstWorkflowAttempt({ GITHUB_RUN_ATTEMPT: '1' }));
  for (const attempt of ['2', '', undefined])
    assert.throws(() => assertFirstWorkflowAttempt({ GITHUB_RUN_ATTEMPT: attempt }), { code: 'workflow-replay-refused' });
  const { assertSingleGitHubArtifact } = await import('../../scripts/e2e-staging/continue-run.mjs');
  const item = { id: 123, name: 'staging-continuation-789-1' };
  assert.doesNotThrow(() => assertSingleGitHubArtifact({ total_count: 1, artifacts: [item] }, '123', item.name));
  assert.doesNotThrow(() => assertSingleGitHubArtifact({ total_count: 2,
    artifacts: [item, { id: 987, name: 'staging-public-evidence-789-1' }] }, '123', item.name));
  for (const list of [{ total_count: 2, artifacts: [item, { ...item, id: 124 }] },
    { total_count: 1, artifacts: [{ ...item, id: 124 }] }, { total_count: 0, artifacts: [] },
    { total_count: 101, artifacts: [item] }])
    assert.throws(() => assertSingleGitHubArtifact(list, '123', item.name), { code: 'artifact-identity-mismatch' });
});

test('an owned GitHub download is tightened to private mode before restore and wrong-size or multiply linked input is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-download-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'continuation.enc'), bytes = Buffer.from('synthetic-encrypted-continuation');
  await writeFile(path, bytes, { mode: 0o644 });
  assert.equal(await digestDownloadedContinuation(path, bytes.length), createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await fsPromises.stat(path)).mode & 0o777, 0o600);
  await assert.rejects(digestDownloadedContinuation(path, bytes.length + 1), { code: 'artifact-content-refused' });
  const alias = join(root, 'alias.enc');
  await fsPromises.link(path, alias);
  await assert.rejects(digestDownloadedContinuation(path, bytes.length), { code: 'artifact-content-refused' });
});

test('logical predecessor credit requires an exact consumed authenticated transfer receipt', () => {
  const expected = { artifactId: '123', digest, size: 4096, generation: 1, planHash: 'c'.repeat(64) };
  const context = { runId: 'synthetic_' + sha,
    sourcePair: { source_commit: sha, carr_source_commit: binding.carr },
    contractHash: 'e'.repeat(64), priorArtifactBytes: 6000 };
  const receipt = { schema: 'doctorcre-staging-continuation-adoption.v1', artifactId: '123', sha256: digest,
    envelopeBytes: 4096, chargedBytes: 4096, generation: 1, runId: context.runId,
    sourcePair: context.sourcePair, contractHash: context.contractHash,
    planHash: expected.planHash, priorLedgerArtifactBytes: 6000,
    inputConsumed: true };
  assert.doesNotThrow(() => assertAdoptionReceipt(receipt, expected, context));
  for (const change of [{ artifactId: '124' }, { sha256: 'd'.repeat(64) }, { envelopeBytes: 4095 },
    { chargedBytes: 4095 }, { generation: 2 }, { runId: 'foreign-run' },
    { planHash: 'd'.repeat(64) }, { contractHash: 'd'.repeat(64) },
    { sourcePair: { ...context.sourcePair, source_commit: 'd'.repeat(40) } },
    { priorLedgerArtifactBytes: 5999 }, { inputConsumed: false }])
    assert.throws(() => assertAdoptionReceipt({ ...receipt, ...change }, expected, context), { code: 'artifact-adoption-invalid' });
});

test('unqualified Model Room is refused before invoking a dispatcher or using a staging session', async t => {
  await assert.rejects(qualifiedModelRoom({}), { code: 'model-room-runtime-unqualified' });
  await assert.rejects(qualifiedModelRoom({ descriptorPath: '/tmp/not-a-readiness-proof', expectedDigest: 'true' }),
    { code: 'model-room-runtime-unqualified' });
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-unqualified-descriptor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'offered.json'), bytes = JSON.stringify({ ready: true });
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(qualifiedModelRoom({ descriptorPath: path, expectedDigest: createHash('sha256').update(bytes).digest('hex'), binding }),
    { code: 'model-room-runtime-unqualified' });
});

test('qualified live Codex desk binds network access, cwd and resolved model to a fresh read-only runtime', () => {
  const entry = { kind: 'codex-live', network_access: true, family: 'luna', effort: 'medium', cwd: '/synthetic/private-app' };
  const descriptor = { ...entry, model: 'gpt-6-luna' };
  const receipt = { kind: 'codex-live', model: 'gpt-6-luna', family: 'luna', effort: 'medium' };
  assert.doesNotThrow(() => assertQualifiedDesk(entry, descriptor, receipt));
  for (const delta of [{ family: 'sol' }, { effort: 'high' }, { cwd: '/other-source' },
    { kind: 'codex-session' }, { network_access: undefined }, { network_access: false }, { network_access: 'true' }])
    assert.throws(() => assertQualifiedDesk({ ...entry, ...delta }, descriptor, receipt), { code: 'model-room-desk-unqualified' });
  for (const delta of [{ kind: 'codex-session' }, { model: 'gpt-6-sol' }, { family: 'sol' }, { effort: undefined }])
    assert.throws(() => assertQualifiedDesk(entry, descriptor, { ...receipt, ...delta }), { code: 'model-room-desk-unqualified' });
  assert.throws(() => assertQualifiedDesk(entry, { ...descriptor, model: 'gpt-6-sol' }, receipt),
    { code: 'model-room-desk-unqualified' });
});

test('an offered runtime for an old checkout or source pair is refused before opening its dispatcher', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-runtime-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { MODEL_ROOM_DISPATCH_CONTRACT: pinned } = await import('../../scripts/e2e-staging/model-room.mjs');
  const now = Date.now(), path = join(root, 'descriptor.json');
  const base = { schema: 'doctorcre-model-room-qualified-runtime.v1', checkout: sha,
    sourcePair: { source_commit: sha, carr_source_commit: binding.carr }, dispatcherRevision: pinned.revision,
    dispatcherSha256: pinned.sha256, dispatcherPath: '/synthetic/not-opened/dispatch.py',
    registryPath: '/synthetic/not-opened/desks.json', repositoryPath: '/synthetic/not-opened',
    qualificationReceiptPath: '/synthetic/not-opened/receipt.json', registrySha256: digest,
    qualificationReceiptSha256: digest, qualifiedAt: now, expiresAt: now + 1000,
    desk: 'doctorcre-e2e', family: pinned.family, model: pinned.model, effort: pinned.effort, completion: 'synchronous' };
  for (const delta of [{ checkout: 'c'.repeat(40) },
    { sourcePair: { ...base.sourcePair, source_commit: 'c'.repeat(40) } },
    { sourcePair: { ...base.sourcePair, carr_source_commit: 'c'.repeat(40) } }]) {
    const bytes = JSON.stringify({ ...base, ...delta });
    await writeFile(path, bytes, { mode: 0o600 });
    await assert.rejects(qualifiedModelRoom({ descriptorPath: path,
      expectedDigest: createHash('sha256').update(bytes).digest('hex'), binding, now }),
    { code: 'model-room-runtime-unqualified' });
  }
});

test('the real CLI reports a closed qualification failure without printing even synthetic credential material', async () => {
  const execute = promisify(execFile);
  const result = await execute(process.execPath, [fileURLToPath(new URL('../../scripts/e2e-staging/continue-run.mjs', import.meta.url)), 'qualify'],
    { env: { ...process.env, E2E_MODEL_ROOM_DESCRIPTOR: '', E2E_MODEL_ROOM_DESCRIPTOR_SHA256: '',
      GITHUB_SHA: sha, E2E_EXPECTED_APP_SHA: sha,
      E2E_SESSION_SECRET: 'synthetic-never-print-credential-marker' } }).catch(error => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /model-room-runtime-unqualified/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-never-print|Authorization|Bearer/);
});

test('session-path persists only the validated runner-temp path for subsequent steps, without creating a credential file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-session-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'github-env'), secretPath = join(root, 'doctorcre-session-123-2');
  const result = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../scripts/e2e-staging/continue-run.mjs', import.meta.url)), 'session-path'],
    { env: { ...process.env, RUNNER_TEMP: root, GITHUB_RUN_ID: '123', E2E_SLOT: '2', GITHUB_ENV: environment,
      E2E_SESSION_SECRET_FILE: secretPath, E2E_SESSION_SECRET: privateMarker } });
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.equal(await readFile(environment, 'utf8'), `E2E_SESSION_SECRET_FILE=${secretPath}\n`);
  await assert.rejects(readFile(secretPath), { code: 'ENOENT' });
});

test('canary authenticates in memory, restricts browser traffic, rechecks source, and returns no auth or page material', async () => {
  let routeHandler, contextsClosed = 0, browsersClosed = 0, probes = 0;
  const phases = [];
  const state = { cookies: [{ name: 'private-cookie', value: 'do-not-publish' }] };
  const page = { goto: async url => { assert.equal(url, contract.origin + '/'); return { ok: () => true }; }, on() {},
    waitForLoadState: async () => {}, url: () => contract.origin + '/', locator: () => ({ count: async () => 1, waitFor: async () => {} }) };
  const run = { http: async operation => operation(), check() {}, limits: { httpTimeoutMs: 1000 } };
  const deps = { onPhase: async phase => phases.push(phase), session: async () => ({ state, release }), releaseProbe: async () => { probes++; return release; },
    browserFactory: async () => ({ newContext: async options => {
      assert.equal(options.storageState, state);
      assert.equal(options.serviceWorkers, 'block');
      return { route: async (_pattern, handler) => { routeHandler = handler; }, newPage: async () => page,
        close: async () => { contextsClosed++; } };
    }, close: async () => { browsersClosed++; } }) };
  const receipt = await canary({ binding, run }, deps);
  assert.equal(receipt.status, 'AUTHENTICATED_READ_ONLY_CANARY');
  assert.equal(receipt.acceptedV1, false);
  assert.equal(probes, 1);
  assert.equal(contextsClosed, 1);
  assert.equal(browsersClosed, 1);
  assert.deepEqual(phases, ['session', 'browser-launch', 'context', 'guard', 'navigation', 'asset-settlement', 'shell', 'source-readback']);
  assert.doesNotMatch(JSON.stringify(receipt), /cookie|do-not-publish|storageState/);
  let aborted = 0, forwarded = 0;
  await routeHandler({ request: () => ({ method: () => 'POST', url: () => contract.origin + '/mcp' }),
    abort: async () => { aborted++; }, fetch: async () => { forwarded++; } });
  assert.equal(aborted, 1);
  assert.equal(forwarded, 0);
  await assert.rejects(canary({ binding, run }, { ...deps,
    session: async () => ({ state, release: { ...release, source_commit: 'c'.repeat(40) } }),
    browserFactory: async () => assert.fail('old source must fail before browser launch') }), { code: 'source-pair-mismatch' });
});

test('GitHub artifact metadata must identify this workflow run, immutable checkout, exact id and predecessor generation', () => {
  const expected = { id: '123', runId: '456', checkout: sha, generation: 1 };
  const actual = { id: 123, expired: false, name: 'staging-continuation-456-1', size_in_bytes: 1024,
    workflow_run: { id: 456, head_sha: sha } };
  assert.doesNotThrow(() => assertGitHubArtifact(actual, expected));
  for (const delta of [{ id: 124 }, { expired: true }, { name: 'staging-continuation-456-0' },
    { workflow_run: { id: 457, head_sha: sha } }, { workflow_run: { id: 456, head_sha: 'c'.repeat(40) } }])
    assert.throws(() => assertGitHubArtifact({ ...actual, ...delta }, expected));
});

test('global budget admission rejects exhausted counters, unfinished resources and altered immutable deadline', () => {
  const now = Date.now(), limits = { ...RUN_LIMITS, runTimeoutMs: 60_000, batchGoals: 1 };
  const expected = { runId: 'synthetic-run', startedAt: now, deadline: now + 60_000, limits, now };
  const state = { id: expected.runId, startedAt: now, deadline: expected.deadline, limits,
    globalHttpRequests: 1, globalModelCalls: 1, artifactBytes: 100, activeHttp: {}, queuedHttp: {}, processGroups: {} };
  assert.doesNotThrow(() => assertBudget(state, expected));
  for (const delta of [{ globalHttpRequests: 20_000 }, { globalModelCalls: 5000 }, { artifactBytes: 256 * 1024 * 1024 },
    { deadline: now + 120_000 }, { activeHttp: { pending: 1 } }, { processGroups: { pending: 1 } }])
    assert.throws(() => assertBudget({ ...state, ...delta }, expected));
});

test('restored evidence refuses missing or mismatched proof while zero-evidence progress remains resumable', () => {
  const checkpoint = { release, explorations: [] }, runId = 'synthetic_' + sha;
  assert.doesNotThrow(() => assertRestoredEvidence(checkpoint, { verified: false }, runId));
  const retained = { schema: 'doctorcre-staging-retained-evidence.v1', verified: true,
    source_pair: { source_commit: sha, carr_source_commit: binding.carr }, run_id: runId, referencedFiles: 1 };
  const observed = { ...checkpoint, explorations: [{ status: 'finished', evidence: '/synthetic/evidence/explore/goal' }] };
  assert.doesNotThrow(() => assertRestoredEvidence(observed, retained, runId));
  for (const proof of [{ verified: false }, { ...retained, run_id: 'other' },
    { ...retained, source_pair: { ...retained.source_pair, source_commit: 'f'.repeat(40) } },
    { ...retained, referencedFiles: 0 }])
    assert.throws(() => assertRestoredEvidence(observed, proof, runId), { code: 'retained-evidence-unverified' });
});

const privateMarker = 'SYNTHETIC_PRIVATE_CONTINUATION_MARKER_3c702';
async function continuationFixture(t, { interrupt = true, checkout = sha } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-workflow-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = Date.now(), deadline = Math.min(startedAt + 60 * 60 * 1000, Date.parse('2026-10-15T12:00:00Z'));
  const sourcePair = { source_commit: binding.app, carr_source_commit: binding.carr };
  const runId = 'synthetic_' + checkout;
  const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin, state: 'complete',
    run: '60000000-0000-4000-8000-000000000001', release: sourcePair, records: {}, receipts: {} };
  const setup = { schema: 'doctorcre-staging-records.v1', origin: contract.origin, release: sourcePair,
    complete: true, records: {}, eligibleLead: null, findings: [], needs_restore: [] };
  const controls = { release, screens: [], history: [], explorations: [], findings: [], stateObligations: [],
    expectedScreens: 62, expectedStates: 62, expectedExplorations: 93, setup: { private_marker: privateMarker } };
  let workerCalls = 0, verificationCalls = 0;
  const dependencies = { tourPrerequisite: async () => ({ status: 'READY' }), invoicePrerequisite: async () => ({ status: 'READY' }), qualify: async () => ({}), checkout: async () => {}, freeze: async () => {},
    verifyRetainedEvidence: async () => { verificationCalls++; return { verified: false }; },
    progress: async (_output, _binding, observedRunId) => {
      assert.equal(observedRunId, runId); return { phase: 'explore' };
    },
    work: async ({ output, limits }) => {
      workerCalls++;
      const run = openRun(output, { limits, runId, events: null, newInvocation: true });
      try {
        await run.http(() => true); run.reserveModel();
        for (const [name, value] of [['controls.json', controls], ['staging-records.json', setup], ['staging-records-plan.json', plan]])
          await run.writeFile(join(output, name), JSON.stringify(value), (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));
        if (interrupt) run.stop('stop-signal');
      } finally { run.dispose(); }
      return { boundary: interrupt };
    } };
  const base = { binding: { ...binding, checkout }, slot: 1, runId, startedAt, deadline, secret: 'synthetic-encryption-secret-at-least-32-characters',
    output: join(root, 'progress-one'), publicDir: join(root, 'public-one'), envelopePath: join(root, 'one.enc'), environment: {} };
  return { root, base, dependencies, calls: () => workerCalls, verificationCalls: () => verificationCalls };
}

test('cutoff crossed at the actual envelope link refuses success and retains the private envelope for reconciliation', async t => {
  for (const kind of ['absolute-cutoff', 'canonical-run-deadline']) {
    const f = await continuationFixture(t);
    const deadline = kind === 'absolute-cutoff' ? Date.parse('2026-10-15T12:00:00Z') : Date.now() + 30_000;
    let clock = deadline - 10_000, linked = false;
    t.mock.method(Date, 'now', () => clock);
    f.base.startedAt = clock - 1000; f.base.deadline = deadline;
    const original = fsPromises.link;
    fsPromises.link = async (from, to) => {
      if (to === f.base.envelopePath) { clock = deadline + 1; linked = true; }
      return original(from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(boundedInvocation(f.base, f.dependencies), { code: 'deadline-exhausted' });
      assert.equal(linked, true);
      assert.ok((await readFile(f.base.envelopePath)).length > 0);
    } finally { fsPromises.link = original; syncBuiltinESMExports(); t.mock.restoreAll(); }
  }
});

test('tracked synthetic source changed after real Git qualification prevents settlement and sealing', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'doctorcre-frozen-source-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const execute = promisify(execFile), git = (...args) => execute('git', args, { cwd: repo });
  await git('init', '-q'); await writeFile(join(repo, 'owned.txt'), 'synthetic frozen source\n');
  await git('add', 'owned.txt');
  await git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic source');
  const checkout = (await git('rev-parse', 'HEAD')).stdout.trim();
  const frozen = () => assertCheckout(checkout, repo);
  for (const stage of ['settlement', 'actual-envelope-link']) {
    await writeFile(join(repo, 'owned.txt'), 'synthetic frozen source\n');
    const f = await continuationFixture(t, { checkout });
    let qualified = false;
    const original = fsPromises.link;
    if (stage === 'actual-envelope-link') {
      fsPromises.link = async (from, to) => {
        if (to === f.base.envelopePath) await writeFile(join(repo, 'owned.txt'), 'synthetic changed source\n');
        return original(from, to);
      };
      syncBuiltinESMExports();
    }
    try {
      await assert.rejects(boundedInvocation(f.base, { ...f.dependencies,
        qualify: async () => { await frozen(); qualified = true; return {}; }, freeze: frozen, checkout: frozen,
        work: async options => {
          assert.equal(qualified, true);
          const outcome = await f.dependencies.work(options);
          if (stage === 'settlement') await writeFile(join(repo, 'owned.txt'), 'synthetic changed source\n');
          return outcome;
        } }), { code: 'checkout-source-changed' });
      if (stage === 'settlement') await assert.rejects(readFile(f.base.envelopePath), { code: 'ENOENT' });
      else assert.ok((await readFile(f.base.envelopePath)).length > 0);
      assert.ok((await readFile(join(f.base.output, 'controls.json'))).length > 0);
    } finally { fsPromises.link = original; syncBuiltinESMExports(); }
  }
});

test('actual frozen-source checks count both public release reads and reject deployed drift at settlement or immediately before sealing', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'doctorcre-release-freeze-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const execute = promisify(execFile), git = (...args) => execute('git', args, { cwd: repo });
  await git('init', '-q'); await writeFile(join(repo, 'owned.txt'), 'synthetic source\n'); await git('add', 'owned.txt');
  await git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic source');
  const checkout = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const stage of ['settlement-app', 'pre-seal-app', 'pre-seal-carr']) {
    const f = await continuationFixture(t, { checkout });
    let changed = false, inspections = 0, requests = 0;
    const freeze = run => verifyFrozenSource({ binding: f.base.binding, run, repository: repo,
      fetcher: async (url, options) => {
        requests++; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
        assert.equal('headers' in options, false);
        const value = url === contract.origin + '/app-release'
          ? { ...release, source_commit: changed && stage.endsWith('-app') ? 'c'.repeat(40) : sha }
          : { env: { value: 'staging' }, git_sha: { value: changed && stage.endsWith('-carr') ? 'c'.repeat(40) : binding.carr } };
        return { ok: true, json: async () => value };
      } });
    await assert.rejects(boundedInvocation(f.base, { ...f.dependencies, freeze,
      checkout: expected => assertCheckout(expected, repo),
      qualify: async () => { await assertCheckout(checkout, repo); return {}; },
      progress: async () => { inspections++; if (stage.startsWith('pre-seal') && inspections === 2) changed = true; return { phase: 'explore' }; },
      work: async options => { const outcome = await f.dependencies.work(options); if (stage.startsWith('settlement')) changed = true; return outcome; },
    }), { code: 'source-pair-mismatch' });
    const ledger = JSON.parse(await readFile(join(f.base.output, 'run-budget.json'), 'utf8'));
    assert.equal(ledger.globalHttpRequests, 1 + requests);
    assert.equal(requests, stage.startsWith('settlement') ? 2 : 4);
    await assert.rejects(readFile(f.base.envelopePath), { code: 'ENOENT' });
  }
});

test('fresh publication gates reject late clocks, dirty source and substituted ciphertext without deleting evidence', async t => {
  const previousMask = process.umask(0o022);
  t.after(() => process.umask(previousMask));
  const f = await continuationFixture(t);
  const encrypted = join(f.root, 'encrypted'), incoming = join(f.root, 'incoming');
  await mkdir(encrypted, { mode: 0o700 }); await mkdir(incoming, { mode: 0o700 });
  f.base.envelopePath = join(encrypted, 'continuation.enc');
  const first = await boundedInvocation(f.base, f.dependencies);
  for (const file of ['controls.json', 'findings.json', 'explorations.json', 'coverage.md'])
    assert.equal((await fsPromises.stat(join(f.base.output, file))).mode & 0o777, 0o600, file);
  const env = { GITHUB_SHA: sha, E2E_EXPECTED_APP_SHA: sha, E2E_RUN_ID: f.base.runId,
    E2E_SLOT: '1', E2E_STARTED_AT: String(f.base.startedAt), E2E_DEADLINE: String(f.base.deadline),
    E2E_V2_OUTPUT: f.base.output, E2E_EVIDENCE_PACKAGE: f.base.publicDir,
    E2E_CONTINUATION_DIRECTORY: encrypted, E2E_RESTORE_DIRECTORY: incoming, E2E_PUBLICATION_DIGEST: first.digest };
  const supplied = { checkout: async () => {}, qualify: async () => ({}) };
  await publicationBoundary(env, supplied);
  await assert.rejects(publicationBoundary(env, { ...supplied, now: () => f.base.deadline + 1 }), { code: 'deadline-exhausted' });
  let checks = 0;
  await assert.rejects(publicationBoundary(env, { ...supplied, checkout: async () => {
    if (++checks === 2) throw Object.assign(new Error('synthetic source changed during export check'), { code: 'checkout-source-changed' });
  } }), { code: 'checkout-source-changed' });
  await assert.rejects(publicationBoundary({ ...env, E2E_PUBLICATION_DIGEST: 'f'.repeat(64) }, supplied), { code: 'publication-binding-invalid' });
  assert.equal(createHash('sha256').update(await readFile(f.base.envelopePath)).digest('hex'), first.digest);
  assert.ok((await readdir(f.base.publicDir)).length > 0);
});

test('workflow checks fresh boundaries around every upload and requires predecessor job success', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/staging-live.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
  const plan = workflow.split('\n  plan:')[1].split('\n  canary:')[0];
  assert.match(plan, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020[\s\S]*?node-version: 22\.23\.2[\s\S]*?- id: plan/);
  for (let n = 1; n <= 4; n++) {
    const section = workflow.split(`\n  part_${n}:`)[1].split(/\n  (?:part_\d|full_v1_proof):/)[0];
    assert.equal(section.match(/continue-run\.mjs publication-boundary/g)?.length, 3);
    assert.ok(section.indexOf('publication-boundary') < section.indexOf('- id: encrypted'));
    assert.ok(section.lastIndexOf('publication-boundary') > section.lastIndexOf('retention-days: 14'));
    assert.match(section, /- id: encrypted[\s\S]*?retention-days: 1/,
      'each private continuation slot expires after one day');
    if (n > 1) assert.ok(section.includes(`needs.part_${n - 1}.result == 'success'`));
  }
});

test('synthetic interrupted/restored chain retains global counters and deadline, with only encrypted progress beside sanitized public receipts', async t => {
  const f = await continuationFixture(t);
  const first = await boundedInvocation(f.base, f.dependencies);
  assert.equal(first.job_status, 'CONTINUE');
  assert.equal(first.accepted_v1, 'false');
  const firstBudget = JSON.parse(await readFile(join(f.base.output, 'run-budget.json'), 'utf8'));
  assert.equal(firstBudget.globalHttpRequests, 1);
  assert.equal(firstBudget.globalModelCalls, 1);
  assert.equal(firstBudget.deadline, f.base.deadline);
  assert.equal(firstBudget.invocations.some(row => row.stopReason === 'stop-signal'), true);
  const encrypted = await readFile(f.base.envelopePath);
  assert.equal(encrypted.includes(Buffer.from(privateMarker)), false);
  assert.equal(encrypted.includes(Buffer.from('controls.json')), false);
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash, size: Number(first.size) };
  const copiedInput = join(f.root, 'copied-predecessor.enc');
  await copyFile(f.base.envelopePath, copiedInput);
  const secondOptions = { ...f.base, slot: 2, output: join(f.root, 'progress-two'), publicDir: join(f.root, 'public-two'),
    envelopePath: join(f.root, 'two.enc'), expected, incoming: { ...expected, path: f.base.envelopePath } };
  const second = await boundedInvocation(secondOptions, f.dependencies);
  const secondBudget = JSON.parse(await readFile(join(secondOptions.output, 'run-budget.json'), 'utf8'));
  assert.equal(secondBudget.globalHttpRequests, 2);
  assert.equal(secondBudget.globalModelCalls, 2);
  assert.equal(secondBudget.deadline, firstBudget.deadline);
  assert.ok(secondBudget.artifactBytes >= firstBudget.artifactBytes,
    'authenticated predecessor content keeps its monotone logical charge without charging the transferred copy again');
  assert.equal(second.predecessor, first.digest);
  assert.equal(second.generation, '2');
  assert.equal(second.accepted_v1, 'false');
  assert.equal(f.calls(), 2);
  assert.equal(f.verificationCalls(), 1);
  await assert.rejects(boundedInvocation({ ...secondOptions,
    output: join(f.root, 'copied-progress'), publicDir: join(f.root, 'copied-public'),
    envelopePath: join(f.root, 'copied-successor.enc'), incoming: { ...expected, path: copiedInput } },
  f.dependencies), { code: 'artifact-replay-refused' });
  assert.equal(f.calls(), 2, 'same authenticated predecessor cannot start a second local worker from a copied input');
  assert.deepEqual((await readdir(secondOptions.publicDir)).sort(), ['controls.json', 'coverage.md', 'evidence-package.json', 'explorations.json', 'findings.json']);
  for (const name of await readdir(secondOptions.publicDir)) {
    const text = await readFile(join(secondOptions.publicDir, name), 'utf8');
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE|cookies|storageState|staging-records-plan/);
  }
});

test('worker journey observations survive the fixed three-file private seal and restore without entering public evidence', async t => {
  const f = await continuationFixture(t), observed = [];
  const work = async ({ output, limits }) => {
    const run = openRun(output, { limits, runId: f.base.runId, events: null, newInvocation: true });
    try {
      await run.http(() => true); run.reserveModel();
      const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin, state: 'complete',
        run: '60000000-0000-4000-8000-000000000003', release: { source_commit: binding.app, carr_source_commit: binding.carr },
        records: {}, receipts: {} };
      const controls = { release, screens: [], history: [], explorations: [], findings: [], stateObligations: [],
        expectedScreens: 62, expectedStates: 62, expectedExplorations: 93 };
      const setup = { schema: 'doctorcre-staging-records.v1', origin: contract.origin,
        release: plan.release, complete: true, records: {}, eligibleLead: null, findings: [], needs_restore: [] };
      for (const [name, value] of [['controls.json', controls], ['staging-records.json', setup], ['staging-records-plan.json', plan]])
        await run.writeFile(join(output, name), JSON.stringify(value),
          (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));
      const readonly = { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
        provenance: { source_commit: binding.app, carr_source_commit: binding.carr, run: plan.run },
        counts: { carr_record_mutations: 0 },
        journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending' })) };
      observed.push(await retainJourneyQualification({ run, binding, release,
        result: { completed: ['W4', 'W9', 'W15'], steps: [], tour: { full_v1_qualified: false },
          readonly, full_v1_qualified: false } }));
      run.stop('stop-signal');
    } finally { run.dispose(); }
    return { boundary: true };
  };
  const result = await boundedInvocation(f.base, { ...f.dependencies, work });
  const restored = join(f.root, 'restored-journey');
  const { restoreContinuation } = await import('../../scripts/e2e-staging/continuation-envelope.mjs');
  await restoreContinuation({ envelopePath: f.base.envelopePath, destination: restored, secret: f.base.secret,
    expected: { sha256: result.digest, generation: 1, predecessor: null, runId: f.base.runId,
      sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr },
      contractHash: createHash('sha256').update(await readFile(new URL('../../contracts/e2e-staging.v1.json', import.meta.url))).digest('hex'),
      planHash: result.plan_hash } });
  const retained = JSON.parse(await readFile(join(restored, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained, observed[0]);
  assert.doesNotThrow(() => assertJourneyQualification(retained, binding, f.base.runId));
  assert.equal(retained.full_v1_qualified, false);
  for (const name of await readdir(f.base.publicDir))
    assert.equal((await readFile(join(f.base.publicDir, name), 'utf8')).includes('journey_qualification'), false);
  assert.equal((await readFile(f.base.envelopePath)).includes(Buffer.from('journey_qualification')), false);
});

test('four serial caller slots adopt only authenticated consumed predecessors without resetting the logical budget', async t => {
  const f = await continuationFixture(t);
  let previous, predecessorPath, priorBudget;
  for (let slot = 1; slot <= 4; slot++) {
    const options = { ...f.base, slot, output: join(f.root, `progress-${slot}`),
      publicDir: join(f.root, `public-${slot}`), envelopePath: join(f.root, `${slot}.enc`) };
    if (previous) {
      const expected = { artifactId: String(122 + slot), digest: previous.digest,
        size: Number(previous.size), generation: slot - 1,
        predecessor: previous.predecessor || null, planHash: previous.plan_hash };
      options.expected = expected;
      options.incoming = { ...expected, path: predecessorPath };
    }
    const result = await boundedInvocation(options, f.dependencies);
    const state = JSON.parse(await readFile(join(options.output, 'run-budget.json'), 'utf8'));
    assert.equal(result.generation, String(slot));
    assert.equal(result.accepted_v1, 'false');
    assert.ok(Number(result.size) > 0 && Number(result.size) <= RUN_LIMITS.artifactBytes);
    assert.equal(state.globalHttpRequests, slot);
    assert.equal(state.globalModelCalls, slot);
    assert.ok(state.artifactBytes <= RUN_LIMITS.artifactBytes);
    if (priorBudget) {
      assert.ok(state.artifactBytes >= priorBudget.artifactBytes);
      await assert.rejects(readFile(predecessorPath), { code: 'ENOENT' }, 'authenticated input is consumed once');
      if (slot === 2) {
        await assert.rejects(boundedInvocation({ ...options,
          output: join(f.root, 'replay-progress'), publicDir: join(f.root, 'replay-public'),
          envelopePath: join(f.root, 'replay.enc') }, f.dependencies));
        assert.equal(f.calls(), 2, 'consumed input cannot fork a second worker');
      }
    }
    previous = result; predecessorPath = options.envelopePath; priorBudget = state;
  }
  assert.equal(f.calls(), 4);
  assert.equal(f.verificationCalls(), 3);
});

test('private parent durably refuses a copied predecessor after one failed restore attempt', async t => {
  const f = await continuationFixture(t);
  const first = await boundedInvocation(f.base, f.dependencies);
  const expected = { artifactId: '123', digest: first.digest, size: Number(first.size),
    generation: 1, predecessor: null, planHash: first.plan_hash };
  const copy = join(f.root, 'copied-input.enc');
  await copyFile(f.base.envelopePath, copy);
  const second = { ...f.base, slot: 2, output: join(f.root, 'first-restore'),
    publicDir: join(f.root, 'first-public'), envelopePath: join(f.root, 'first-successor.enc'),
    expected, incoming: { ...expected, path: copy } };
  await assert.rejects(boundedInvocation({ ...second, secret: 'invalid synthetic envelope key that is long enough' },
    f.dependencies), { code: 'continuation-auth-failed' });
  const claims = (await readdir(f.root)).filter(name => name.startsWith('.continuation-consumed-'));
  assert.equal(claims.length, 1, 'the one-use claim survives the failed restore in the trusted parent');
  assert.equal((await fsPromises.stat(join(f.root, claims[0]))).mode & 0o777, 0o600);
  await assert.rejects(boundedInvocation({ ...second, output: join(f.root, 'second-restore'),
    publicDir: join(f.root, 'second-public'), envelopePath: join(f.root, 'second-successor.enc') },
  f.dependencies), { code: 'artifact-replay-refused' });
  const foreignId = { ...expected, artifactId: '124' };
  await assert.rejects(boundedInvocation({ ...second, output: join(f.root, 'third-restore'),
    publicDir: join(f.root, 'third-public'), envelopePath: join(f.root, 'third-successor.enc'),
    expected: foreignId, incoming: { ...foreignId, path: copy } },
  f.dependencies), { code: 'artifact-replay-refused' });
  assert.equal(f.calls(), 1, 'neither restore attempt starts a second worker');
});

test('four serial caller slots carry 5,140 incompressible retained files inside logical and physical caps',
  { timeout: 600_000 }, async t => {
    const f = await continuationFixture(t), sourcePair = { source_commit: binding.app, carr_source_commit: binding.carr };
    const fileCount = 5140, filesPerSlot = fileCount / 4, fileBytes = 40_960, retainedBytes = fileCount * fileBytes;
    const report = Buffer.from('{"schema":"synthetic-retained-report"}');
    let previous, predecessorPath, priorBudget, totalHostedBytes = 0, calls = 0;
    const dependencies = { ...f.dependencies,
      verifyRetainedEvidence: async (output, checkpoint) =>
        (await import('../../scripts/e2e-staging/evidence-manifest.mjs')).verifyRetainedEvidence(output, checkpoint),
      work: async ({ output, limits }) => {
        calls++;
        const run = openRun(output, { limits, runId: f.base.runId, events: null, newInvocation: true });
        try {
          await run.http(() => true); run.reserveModel();
          const evidence = join(output, 'evidence', 'explore', 'synthetic-goal');
          if (calls === 1) {
            await mkdir(evidence, { recursive: true, mode: 0o700 });
            await run.writeFile(join(evidence, 'report.json'), report,
              (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));
            const controls = { release, screens: [], history: [], findings: [], stateObligations: [],
              expectedScreens: 62, expectedStates: 62, expectedExplorations: 93,
              explorations: [{ target: 'staging-live', screen: 'Home', path: '/', agent: 'bug-hunter',
                steps: 1, status: 'finished', evidence }] };
            const setup = { schema: 'doctorcre-staging-records.v1', origin: contract.origin, release,
              complete: true, records: {}, eligibleLead: null, findings: [], needs_restore: [] };
            const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin, state: 'complete',
              run: '60000000-0000-4000-8000-000000000001', release: sourcePair, records: {}, receipts: {} };
            for (const [name, value] of [['controls.json', controls], ['staging-records.json', setup], ['staging-records-plan.json', plan]])
              await run.writeFile(join(output, name), JSON.stringify(value),
                (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));
          }
          // Each bounded job creates one quarter of the measured corpus through
          // the same accounted write path used by production evidence.
          const start = (calls - 1) * filesPerSlot;
          for (let index = start; index < start + filesPerSlot; index++) {
            const path = join(evidence, `observation-${index}.png`);
            await run.writeFile(path, randomBytes(fileBytes),
              (destination, bytes) => writeFile(destination, bytes, { mode: 0o600 }));
          }
          run.stop('stop-signal');
        } finally { run.dispose(); }
        return { boundary: true };
      } };
    for (let slot = 1; slot <= 4; slot++) {
      let preSealBytes, sealedAccounting, restorePeak;
      const options = { ...f.base, slot, output: join(f.root, `large-progress-${slot}`),
        publicDir: join(f.root, `large-public-${slot}`), envelopePath: join(f.root, `large-${slot}.enc`) };
      if (previous) {
        const expected = { artifactId: String(200 + slot), digest: previous.digest, size: Number(previous.size),
          generation: slot - 1, predecessor: previous.predecessor || null, planHash: previous.plan_hash };
        options.expected = expected; options.incoming = { ...expected, path: predecessorPath };
      }
      const result = await boundedInvocation(options, { ...dependencies,
        onSeal: sealed => { sealedAccounting = sealed.accounting; },
        onRestore: restored => { restorePeak = restored; },
        checkout: async () => {
          if (preSealBytes === undefined)
            preSealBytes = JSON.parse(await readFile(join(options.output, 'run-budget.json'), 'utf8')).artifactBytes;
        } });
      const budget = JSON.parse(await readFile(join(options.output, 'run-budget.json'), 'utf8'));
      const size = Number(result.size);
      assert.ok(size >= slot * filesPerSlot * fileBytes + report.length && size <= RUN_LIMITS.artifactBytes,
        'each growing real encrypted file is bounded');
      totalHostedBytes += size;
      assert.ok(budget.artifactBytes >= slot * filesPerSlot * fileBytes + report.length && budget.artifactBytes <= RUN_LIMITS.artifactBytes);
      assert.equal(budget.artifactBytes - preSealBytes, size - slot * filesPerSlot * fileBytes - report.length,
        'new content was already charged by work; seal charges this generation full authenticated framing exactly once');
      assert.equal(sealedAccounting?.schema, 'doctorcre-staging-logical-evidence-budget.v1');
      assert.equal(sealedAccounting.framingBytes, size - slot * filesPerSlot * fileBytes - report.length);
      assert.ok(sealedAccounting.peakLocalBytes <= 3 * RUN_LIMITS.artifactBytes);
      assert.ok(sealedAccounting.peakMemoryBytes <= 6 * RUN_LIMITS.artifactBytes);
      if (slot > 1) {
        assert.ok(restorePeak.peakLocalBytes <= 3 * RUN_LIMITS.artifactBytes);
        assert.ok(restorePeak.peakMemoryBytes <= 6 * RUN_LIMITS.artifactBytes);
      }
      assert.ok(!priorBudget || budget.artifactBytes >= priorBudget.artifactBytes);
      assert.equal(budget.globalHttpRequests, slot); assert.equal(budget.globalModelCalls, slot);
      assert.ok((await import('../../scripts/e2e-staging/run-limits.mjs')).directoryBytes(f.root) <= 3 * RUN_LIMITS.artifactBytes,
        'this invocation has at most input, restored progress and output encrypted slots on disk');
      if (slot === 4) {
        const run = openRun(options.output, { limits: budget.limits, runId: f.base.runId, events: null });
        try {
          const ceiling = RUN_LIMITS.artifactBytes - Math.min(RUN_LIMITS.artifactMetadataBytes,
            Math.floor(RUN_LIMITS.artifactBytes / 8));
          assert.throws(() => run.reserveBytes(ceiling - budget.artifactBytes + 1),
            { code: 'artifact-byte-limit' }, 'one byte beyond the remaining global logical allocation refuses');
        } finally { run.dispose(); }
      }
      await rm(options.output, { recursive: true });
      await rm(options.publicDir, { recursive: true });
      priorBudget = budget; previous = result; predecessorPath = options.envelopePath;
    }
    assert.equal(calls, 4);
    assert.ok(priorBudget.artifactBytes >= retainedBytes);
    assert.ok(totalHostedBytes <= 4 * RUN_LIMITS.artifactBytes);
    assert.ok(process.resourceUsage().maxRSS * 1024 <= 6 * RUN_LIMITS.artifactBytes,
      'measured coordinator peak RSS remains within the explicit transient cap');
  });

test('wrong id, digest, generation, predecessor, plan or source never reaches a restored worker', async t => {
  const f = await continuationFixture(t), first = await boundedInvocation(f.base, f.dependencies);
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash, size: Number(first.size) };
  for (const delta of [{ artifactId: '124' }, { digest: 'd'.repeat(64) }, { generation: 2 },
    { predecessor: 'd'.repeat(64) }, { size: expected.size + 1 }])
    await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'rejected'), publicDir: join(f.root, 'rejected-public'),
      envelopePath: join(f.root, 'rejected.enc'), expected, incoming: { ...expected, ...delta, path: f.base.envelopePath } }, f.dependencies),
    { code: 'artifact-chain-mismatch' });
  await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'wrong-source'),
    publicDir: join(f.root, 'wrong-source-public'), envelopePath: join(f.root, 'wrong-source.enc'),
    binding: { ...binding, app: 'c'.repeat(40) }, expected, incoming: { ...expected, path: f.base.envelopePath } }, f.dependencies),
  { code: 'continuation-binding-mismatch' });
  const wrongPlanOutput = join(f.root, 'wrong-plan');
  await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: wrongPlanOutput,
    expected: { ...expected, planHash: 'e'.repeat(64) },
    publicDir: join(f.root, 'wrong-plan-public'), envelopePath: join(f.root, 'wrong-plan.enc'),
    incoming: { ...expected, planHash: 'e'.repeat(64), path: f.base.envelopePath } }, f.dependencies),
  { code: 'continuation-binding-mismatch' });
  await assert.rejects(readFile(join(wrongPlanOutput, 'controls.json')), { code: 'ENOENT' });
  assert.equal(f.calls(), 1);
});

test('an unsettled write after an interrupted worker produces no continuation and no public package', async t => {
  const f = await continuationFixture(t);
  const work = f.dependencies.work;
  await assert.rejects(boundedInvocation(f.base, { ...f.dependencies, work: async options => {
    const result = await work(options);
    const path = join(options.output, 'staging-records-plan.json');
    const plan = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...plan, browser_write_attempts: [{ state: 'inflight' }] }), { mode: 0o600 });
    return result;
  } }), { code: 'write-coverage-incomplete' });
  await assert.rejects(readFile(f.base.envelopePath), { code: 'ENOENT' });
  await assert.rejects(readdir(f.base.publicDir), { code: 'ENOENT' });
});

test('a surviving source-worker ownership lease prevents packaging and sealing even with settled counters', async t => {
  const f = await continuationFixture(t), work = f.dependencies.work;
  await assert.rejects(boundedInvocation(f.base, { ...f.dependencies, work: async options => {
    const outcome = await work(options);
    await writeFile(join(options.output, '.run-owner'), 'synthetic-owned-worker', { mode: 0o600 });
    return outcome;
  } }), { code: 'source-worker-not-quiescent' });
  await assert.rejects(readFile(f.base.envelopePath), { code: 'ENOENT' });
  await assert.rejects(readdir(f.base.publicDir), { code: 'ENOENT' });
});

test('public and private destinations cannot overlap before any worker or session can run', async t => {
  const f = await continuationFixture(t);
  await assert.rejects(assertSeparated({ ...f.base, publicDir: join(f.base.output, 'publish') }), { code: 'public-private-overlap' });
  await assert.rejects(boundedInvocation({ ...f.base, publicDir: join(f.base.output, 'publish') }, f.dependencies),
    { code: 'public-private-overlap' });
  assert.equal(f.calls(), 0);
});

test('exploration precedes guarded business execution and sweep; bounded completion still cannot claim full V1', async t => {
  const f = await continuationFixture(t, { interrupt: false }), phases = [];
  const result = await boundedInvocation(f.base, { ...f.dependencies,
    progress: async () => ({ phase: phases.length === 0 ? 'explore' : phases.includes('sweep') ? 'complete' : 'sweep',
      completion: { status: 'ACCEPTED_SWEEP', acceptedV1: false } }),
    work: async options => { phases.push(options.phase); return f.dependencies.work(options); } });
  assert.deepEqual(phases, ['explore', 'business', 'sweep']);
  assert.equal(result.job_status, 'SWEEP_ACCEPTED');
  assert.equal(result.accepted_v1, 'false');
});

async function businessFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-business-caller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deal = '60000000-0000-4000-8000-000000000001', events = [];
  const awaitingDeal = '60000000-0000-4000-8000-000000000006';
  const plan = { schema: 'doctorcre-staging-records-plan.v1', state: 'complete',
    run: '60000000-0000-4000-8000-000000000003', release,
    keys: { awaiting_invoice_deal: '60000000-0000-4000-8000-000000000007',
      awaiting_invoice_lead: '60000000-0000-4000-8000-000000000008',
      awaiting_invoice_close: '60000000-0000-4000-8000-000000000009' },
    names: { awaiting_invoice: 'Synthetic awaiting fixture' },
    records: { deal: { id: deal }, invoice: { deal_id: '60000000-0000-4000-8000-000000000002' },
      client: { ref: 'synthetic-client-ref' }, awaiting_invoice: { deal_id: awaitingDeal, name: 'Synthetic awaiting fixture' } },
    receipts: { awaiting_invoice_deal: { ok: true, deal_id: awaitingDeal, name: 'Synthetic awaiting fixture', client_ref: 'synthetic-client-ref' },
      awaiting_invoice_lead: { ok: true, new_lead: 'joe' },
      awaiting_invoice_close: { ok: true, deal_id: awaitingDeal, field: 'phase', event_id: '60000000-0000-4000-8000-000000000010' } } };
  await writeFile(join(root, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const run = { root, signal: new AbortController().signal, limits: RUN_LIMITS,
    snapshot: () => ({ id: 'synthetic_' + sha }), check() {}, onStop: () => () => {},
    writeFile: async (path, bytes, writer) => writer(path, bytes),
    http: async operation => { events.push('http'); return operation(); } };
  const state = { cookies: [{ name: 'synthetic-session', value: privateMarker }] };
  let guarded = false, routeHandler;
  let currentURL;
  const page = { url: () => currentURL,
    goto: async url => {
      assert.equal(guarded, true);
      assert.ok([`${contract.origin}/deals?deal=${deal}`, contract.origin + '/', contract.origin + '/tours',
        contract.origin + '/vendors'].includes(url));
      currentURL = url;
      events.push('navigate');
      await routeHandler({ request: () => ({ method: () => 'GET', url: () => url }),
        fetch: async () => ({ status: () => 200 }), fulfill: async () => {}, abort: async () => assert.fail('guarded read refused') });
      return { ok: () => true };
    }, waitForLoadState: async () => {} };
  const fixtureGuard = { assertCoverage: async () => { events.push('guard-coverage'); },
    forContext: () => ({ assertCoverage: async () => {}, handle: async (_request, forward) => run.http(forward) }) };
  const supplied = {
    invoicePrerequisite: async () => ({ status: 'READY', verifiedTarget: {}, proofSha256: digest }),
    coverage: async () => { events.push('canonical-coverage'); },
    session: async () => { events.push('authenticate'); return { state, release }; },
    prepare: async (output, options) => {
      assert.equal(output, root); assert.equal(options.reuseOnly, true); assert.equal(options.run, run);
      assert.equal(options.signal, run.signal);
      events.push('prepare');
      const authenticated = await options.session(contract.origin, { run });
      return { ...authenticated, complete: true, needs_restore: [], records: plan.records };
    },
    releaseProbe: async (_api, origin, options) => { assert.equal(origin, contract.origin); assert.equal(options.run, run); return release; },
    guardFactory: options => { assert.equal(options.run, run); assert.equal(options.release, release); return fixtureGuard; },
    browserFactory: async () => ({ newContext: async options => {
      assert.equal(options.storageState, state); assert.equal(options.serviceWorkers, 'block');
      assert.equal(options.viewport.width, 1440);
      return { route: async (_pattern, handler) => { guarded = true; routeHandler = handler; events.push('install-guard'); },
        addInitScript: async () => {}, on() {}, newPage: async () => { assert.equal(guarded, true); return page; },
        close: async () => { events.push('context-close'); } };
    }, close: async () => { events.push('browser-close'); } }),
    journeys: async options => {
      assert.equal(options.page, page); assert.equal(options.fixtureGuard, fixtureGuard);
      assert.equal(options.release, release);
      assert.equal(options.deal, options.journeys[0] === 'W15' ? plan.records.invoice.deal_id : deal); assert.equal(options.run, run);
      if (options.journeys[0] === 'W15') assert.deepEqual(options.awaitingInvoicePlan, plan);
      events.push('business');
      return { completed: options.journeys, steps: [], full_v1_qualified: false, unqualified_journeys: ['W6'] };
    },
    readonlyJourneys: async options => {
      assert.equal(options.page, page); assert.equal(options.page.url(), contract.origin + '/');
      assert.equal(options.release, release); assert.equal(options.run, run);
      assert.equal(options.plan.records.deal.id, deal);
      events.push('readonly');
      return { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
        provenance: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit, run: plan.run },
        counts: { carr_record_mutations: 0 },
        journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending', reason: 'synthetic-unproved' })) };
    },
  };
  return { run, supplied, events, plan, fixtureGuard };
}

test('business caller reuses the real private fixture plan, fresh session and existing guarded page factory with route accounting', async t => {
  const f = await businessFixture(t);
  const result = await runBusinessPhase({ binding, run: f.run }, f.supplied);
  assert.equal(result.full_v1_qualified, false);
  const retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.doesNotThrow(() => assertJourneyQualification(retained, binding, f.run.snapshot().id));
  assert.deepEqual(retained.readonly, { W1: 'pending', W2: 'pending', W5: 'pending', W14: 'pending' });
  assert.deepEqual(retained.business, { W4: true, W9: true, W15: true, observed_steps: 0 });
  assert.equal(retained.full_v1_qualified, false);
  assert.equal(JSON.stringify(retained).includes(f.plan.records.deal.id), false);
  assert.equal(JSON.stringify(retained).includes(privateMarker), false);
  assert.deepEqual(f.events, ['canonical-coverage', 'prepare', 'authenticate', 'canonical-coverage',
    'install-guard', 'navigate', 'http', 'business', 'guard-coverage', 'canonical-coverage',
    'install-guard', 'navigate', 'http', 'business', 'guard-coverage', 'canonical-coverage',
    'guard-coverage', 'canonical-coverage', 'install-guard', 'navigate', 'http', 'readonly',
    'guard-coverage', 'canonical-coverage', 'context-close', 'context-close', 'context-close',
    'guard-coverage', 'browser-close']);
  assert.equal(result.readonly.journeys[0].state, 'pending');
});

test('local automatic producer receives a fresh private plan only after manual W4/W9 and a guarded fresh page', async t => {
  const f = await businessFixture(t);
  f.supplied.journeys = async options => {
    f.events.push('business');
    const result = { completed: options.journeys, steps: [], full_v1_qualified: false,
      unqualified_journeys: ['W6'] };
    if (options.journeys[0] === 'W4') {
      f.plan.manual_observed = true;
      await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
      result.steps = [{ journey: 'W4', step: 'move', state: 'observed' },
        { journey: 'W4', step: 'undo', state: 'observed' },
        { journey: 'W9', step: 'date', state: 'observed' }];
    }
    return result;
  };
  let produces = 0, observes = 0;
  const supplied = { ...f.supplied, localAgentCarrCheckout: '/synthetic/immutable-5dda',
    localAgentProducer: async ({ plan, release: actual, run, carrCheckout }) => {
      produces++;
      assert.equal(plan.manual_observed, true);
      assert.equal(actual, release); assert.equal(run, f.run);
      assert.equal(carrCheckout, '/synthetic/immutable-5dda');
      assert.equal(f.events.filter(row => row === 'business').length, 1);
      return { state: 'AUTOMATIC_SEAM_READY', doc_authorship_qualified: false, full_v1_qualified: false };
    },
    automaticPhaseJourney: async ({ page, fixtureGuard, deal, run }) => {
      observes++;
      assert.equal(page.url(), contract.origin + '/deals?deal=' + f.plan.records.deal.id);
      assert.equal(fixtureGuard, f.fixtureGuard); assert.equal(deal, f.plan.records.deal.id);
      assert.equal(run, f.run);
      return { state: 'GENERIC_AUTOMATIC_UNDO_OBSERVED', doc_authorship_qualified: false,
        full_v1_qualified: false };
    } };
  const result = await runBusinessPhase({ binding, run: f.run }, supplied);
  assert.equal(result.automaticPhase.state, 'GENERIC_AUTOMATIC_UNDO_OBSERVED');
  assert.equal(produces, 1); assert.equal(observes, 1);
  assert.equal(result.full_v1_qualified, false);
  assert.deepEqual(result.actions, []);
});

test('local automatic handoff leaves absent and uncertain paths pending without repeating a write', async t => {
  const f = await businessFixture(t);
  const absentResult = await runBusinessPhase({ binding, run: f.run }, f.supplied);
  assert.equal(absentResult.automaticPhase.state, 'PENDING_LOCAL_AGENT_SEAM');
  f.supplied.journeys = async options => {
    f.events.push('business');
    const result = { completed: options.journeys, steps: [], full_v1_qualified: false,
      unqualified_journeys: ['W6'] };
    if (options.journeys[0] === 'W4') result.steps = [
      { journey: 'W4', step: 'move', state: 'previously-observed' },
      { journey: 'W4', step: 'undo', state: 'previously-observed' },
      { journey: 'W9', step: 'date', state: 'previously-observed' }];
    return result;
  };
  let produces = 0, observes = 0;
  const supplied = { ...f.supplied, localAgentCarrCheckout: '/synthetic/immutable-5dda',
    localAgentProducer: async () => { produces++; return { state: 'PENDING_RECONCILIATION' }; },
    automaticPhaseJourney: async () => { observes++; } };
  const pending = await runBusinessPhase({ binding, run: f.run }, supplied);
  assert.equal(pending.automaticPhase.state, 'PENDING_RECONCILIATION');
  assert.equal(produces, 1); assert.equal(observes, 0);
  await mkdir(join(f.run.root, 'private'), { mode: 0o700 });
  await writeFile(join(f.run.root, 'private', 'w4-local-agent-phase.json'), '{}', { mode: 0o600 });
  const resumed = await runBusinessPhase({ binding, run: f.run }, supplied);
  assert.equal(resumed.automaticPhase.state, 'PENDING_RECONCILIATION');
  assert.equal(produces, 1); assert.equal(observes, 0);
});

test('local automatic handoff refuses unobserved manual predecessor before producer invocation', async t => {
  const f = await businessFixture(t);
  let produces = 0;
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    localAgentCarrCheckout: '/synthetic/immutable-5dda',
    localAgentProducer: async () => { produces++; } }),
  { code: 'automatic-manual-predecessor-unproved' });
  assert.equal(produces, 0);
});

test('business caller retains only source-bound vendor and Tour draft action rows from guarded pages', async t => {
  const f = await businessFixture(t);
  f.plan.records.vendor = { id: '60000000-0000-4000-8000-000000000004' };
  f.plan.records.tour = { id: '60000000-0000-4000-8000-000000000005' };
  await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
  const { observedV1Action } = await import('../../scripts/e2e-staging/v1-qualification.mjs');
  const action = (id, caseId, name) => observedV1Action({ id, case: caseId, action: name,
    sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr },
    runId: f.run.snapshot().id, fixtureRun: f.plan.run, ui: { observed: name }, readback: { owned: true } });
  const result = await runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    tourPrerequisite: async () => ({ status: 'READY', fixtureBinding: { synthetic: true } }),
    qualifyTour: async () => ({ full_v1_qualified: false,
      ui: { sha256: 'a'.repeat(64) }, backend_readback: { sha256: 'b'.repeat(64) } }),
    vendorJourney: async ({ page, plan }) => {
      assert.equal(new URL(page.url()).pathname, '/vendors');
      assert.equal(plan.records.vendor.id, f.plan.records.vendor.id);
      return { actions: [action('W5', 'vendors', 'owned-vendor')] };
    },
    tourDraftJourney: async ({ page, plan, fixtureBinding }) => {
      assert.equal(new URL(page.url()).pathname, '/tours');
      assert.equal(plan.records.tour.id, f.plan.records.tour.id);
      assert.deepEqual(fixtureBinding, { synthetic: true });
      return { actions: [action('W6', 'tours-drafts', 'draft-reload')] };
    },
  });
  assert.deepEqual(result.actions.map(row => [row.id, row.action]),
    [['W5', 'owned-vendor'], ['W6', 'draft-reload']]);
  const retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained.observations, result.actions);
  assert.equal(retained.full_v1_qualified, false);
});

test('business qualification retains the exact validated W4/W9/W15 action evidence when a resume reports already-observed steps', async t => {
  const f = await businessFixture(t);
  const { V1_REQUIRED_ACTIONS, observedV1Action } = await import('../../scripts/e2e-staging/v1-qualification.mjs');
  const businessActions = V1_REQUIRED_ACTIONS.filter(row => ['W4', 'W9'].includes(row.id)).slice(0, 9);
  const paidInvoiceActions = V1_REQUIRED_ACTIONS.filter(row => row.id === 'W15' && row.action !== 'awaiting-payment-hidden');
  const selected = [...businessActions, ...paidInvoiceActions];
  assert.equal(selected.length, 18);
  assert.equal(paidInvoiceActions.length, 9);
  let invocation = 0;
  const journeys = async options => {
    const actions = invocation === 0 ? selected.filter(row => row.id === options.journeys[0] ||
      options.journeys[0] === 'W4' && row.id === 'W9').map(row => observedV1Action({ ...row,
        sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr }, runId: f.run.snapshot().id,
        fixtureRun: f.plan.run, ui: { first: row.action }, readback: { owned: true } })) : [];
    if (options.journeys[0] === 'W15') invocation++;
    return { completed: options.journeys,
      steps: options.journeys.map(journey => ({ journey, step: 'synthetic-write',
        state: invocation === 0 ? 'observed' : 'previously-observed' })),
      actions, full_v1_qualified: false, unqualified_journeys: ['W6'] };
  };
  const firstResult = await runBusinessPhase({ binding, run: f.run }, { ...f.supplied, journeys });
  const first = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.equal(first.observations.length, 18);
  await assert.rejects(retainJourneyQualification({ run: f.run, binding, release,
    result: { ...firstResult, actions: [{ ...first.observations[0], ui_sha256: 'f'.repeat(64) }] } }),
  { code: 'journey-observations-invalid' });
  await runBusinessPhase({ binding, run: f.run }, { ...f.supplied, journeys });
  const resumed = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(resumed.observations, first.observations);
  assert.equal(resumed.observations.length, 18);
});

test('resume replaces fresh readonly/vendor/Tour evidence and drops it when current journeys have no proof', async t => {
  const f = await businessFixture(t), { V1_REQUIRED_ACTIONS, observedV1Action } =
    await import('../../scripts/e2e-staging/v1-qualification.mjs');
  const action = (id, caseId, name, ui) => observedV1Action({ id, case: caseId, action: name,
    sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr }, runId: f.run.snapshot().id,
    fixtureRun: f.plan.run, ui, readback: { owned: true } });
  const readonly = { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
    provenance: { source_commit: binding.app, carr_source_commit: binding.carr, run: f.plan.run },
    counts: { carr_record_mutations: 0 },
    journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending', reason: 'fresh synthetic readback' })) };
  const result = row => ({ completed: ['W4', 'W9', 'W15'], steps: ['W4', 'W9', 'W15'].map(journey =>
    ({ journey, step: 'paid-or-observed', state: 'previously-observed' })), readonly, tour: { full_v1_qualified: false },
  actions: Array.isArray(row) ? row : row ? [row] : [], companions: [], full_v1_qualified: false });
  const dynamicRows = [
    V1_REQUIRED_ACTIONS.find(row => row.id === 'W14' && row.action === 'referrals'),
    V1_REQUIRED_ACTIONS.find(row => row.id === 'W5' && row.action === 'owned-vendor'),
    V1_REQUIRED_ACTIONS.find(row => row.id === 'W6' && row.action === 'draft-reload'),
  ];
  const proofs = stamp => dynamicRows.map(row => action(row.id, row.case, row.action,
    { observation: row.id === 'W14' ? stamp : `${row.id}-${stamp}` }));
  const previous = proofs('old-readback');
  await retainJourneyQualification({ run: f.run, binding, release, result: result(previous[0]) });
  // Seed W5/W6 alongside the W14 row so the next invocation must replace all
  // three categories from fresh browser evidence rather than carry stale hashes.
  await retainJourneyQualification({ run: f.run, binding, release, result: result([...previous]) });
  const refreshed = proofs('fresh-readback');
  await retainJourneyQualification({ run: f.run, binding, release, result: result(refreshed) });
  let retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained.observations, refreshed);
  await retainJourneyQualification({ run: f.run, binding, release, result: result(null) });
  retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained.observations, []);
});

test('resume excludes awaiting-invoice read-only proof from prior carry and accepts only its fresh observation', async t => {
  const f = await businessFixture(t), { V1_REQUIRED_ACTIONS, observedV1Action } =
    await import('../../scripts/e2e-staging/v1-qualification.mjs');
  const requirement = V1_REQUIRED_ACTIONS.find(row => row.id === 'W15' && row.action === 'awaiting-payment-hidden');
  assert.ok(requirement, 'the current W15 contract includes the separately observed awaiting-invoice row');
  const action = stamp => observedV1Action({ ...requirement,
    sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr }, runId: f.run.snapshot().id,
    fixtureRun: f.plan.run, ui: { stamp }, readback: { awaiting: true } });
  const readonly = { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
    provenance: { source_commit: binding.app, carr_source_commit: binding.carr, run: f.plan.run },
    counts: { carr_record_mutations: 0 },
    journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending', reason: 'fresh synthetic readback' })) };
  const result = row => ({ completed: ['W4', 'W9', 'W15'], steps: ['W4', 'W9', 'W15'].map(journey =>
    ({ journey, step: 'paid-or-observed', state: 'previously-observed' })), readonly, tour: { full_v1_qualified: false },
  actions: row ? [row] : [], companions: [], full_v1_qualified: false });
  const previous = action('old-proof');
  await retainJourneyQualification({ run: f.run, binding, release, result: result(previous) });
  const fresh = action('fresh-proof');
  await retainJourneyQualification({ run: f.run, binding, release, result: result(fresh) });
  let retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained.observations, [fresh]);
  await retainJourneyQualification({ run: f.run, binding, release, result: result(null) });
  retained = JSON.parse(await readFile(join(f.run.root, 'staging-records-plan.json'), 'utf8')).journey_qualification;
  assert.deepEqual(retained.observations, []);
});

test('readonly W1/W2/W5/W14 caller uses a fresh guarded Home page and cannot qualify full V1', async t => {
  const f = await businessFixture(t);
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    readonlyJourneys: async options => {
      assert.equal(options.page.url(), contract.origin + '/');
      assert.equal(options.release, release); assert.equal(options.run, f.run);
      assert.equal(options.plan.records.deal.id, f.plan.records.deal.id);
      return { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: true, journeys: [] };
    } }), { code: 'readonly-result-unqualified' });
  assert.equal(f.events.filter(event => event === 'install-guard').length, 3);
  assert.equal(f.events.filter(event => event === 'context-close').length, 3);
  assert.equal(f.events.at(-1), 'browser-close');
});

test('readonly caller rejects foreign provenance, missing slices, mutation claims and fabricated full qualification', () => {
  const plan = { run: '33333333-3333-4333-8333-333333333333' };
  const value = { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
    provenance: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit, run: plan.run },
    counts: { carr_record_mutations: 0 },
    journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending', reason: 'synthetic-unproved' })) };
  assert.doesNotThrow(() => assertReadonlyResult(value, release, plan));
  assert.doesNotThrow(() => assertReadonlyResult({ ...value, journeys: value.journeys.map(row => row.journey === 'W14'
    ? { ...row, state: 'qualified-slice', reason: 'owned-relationship-edge-observed' } : row) }, release, plan));
  for (const changed of [{ provenance: { ...value.provenance, source_commit: 'b'.repeat(40) } },
    { journeys: value.journeys.slice(0, 3) }, { journeys: value.journeys.map(row => row.journey === 'W5'
      ? { ...row, state: 'qualified-slice' } : row) }, { counts: { carr_record_mutations: 1 } },
    { full_v1_qualified: true }])
    assert.throws(() => assertReadonlyResult({ ...value, ...changed }, release, plan),
      { code: 'readonly-result-unqualified' });
});

test('retained journey observations accept only closed source-bound statuses', () => {
  const value = { schema: 'doctorcre-staging-journey-observations.v1',
    source_pair: { source_commit: binding.app, carr_source_commit: binding.carr },
    run_id: 'synthetic_' + sha, observed_at: '2026-10-15T05:00:00.000Z',
    business: { W4: true, W9: true, W15: false, observed_steps: 3 },
    tour_readonly_observed: false,
    readonly: { W1: 'qualified-slice', W2: 'pending', W5: 'pending', W14: 'qualified-slice' },
    full_v1_qualified: false };
  assert.doesNotThrow(() => assertJourneyQualification(value, binding, value.run_id));
  for (const changed of [{ run_id: 'other-run' }, { source_pair: { ...value.source_pair, source_commit: 'b'.repeat(40) } },
    { readonly: { ...value.readonly, W5: 'qualified-slice' } }, { full_v1_qualified: true },
    { private_record_id: '60000000-0000-4000-8000-000000000001' }])
    assert.throws(() => assertJourneyQualification({ ...value, ...changed }, binding, value.run_id),
      { code: 'journey-observations-invalid' });
});

test('retained V1 action rows bind the exact fixture and reject foreign or duplicate observations', async () => {
  const { V1_QUALIFICATION_SHA256 } = await import('../../scripts/e2e-staging/v1-qualification.mjs');
  const fixtureRun = '33333333-3333-4333-8333-333333333333';
  const action = { id: 'W6', case: 'tours-drafts', action: 'draft-reload', state: 'observed',
    source_pair: { source_commit: binding.app, carr_source_commit: binding.carr },
    run_id: 'synthetic-run', fixture_run: fixtureRun, actor: 'joe',
    contract_sha256: V1_QUALIFICATION_SHA256,
    ui_sha256: 'a'.repeat(64), readback_sha256: 'b'.repeat(64) };
  const value = { schema: 'doctorcre-staging-journey-observations.v1',
    source_pair: action.source_pair, run_id: action.run_id, fixture_run: fixtureRun,
    observed_at: '2026-10-15T05:00:00.000Z',
    business: { W4: false, W9: false, W15: false, observed_steps: 0 },
    tour_readonly_observed: false,
    readonly: { W1: 'pending', W2: 'pending', W5: 'pending', W14: 'pending' },
    observations: [action], companions: [], full_v1_qualified: false };
  assert.doesNotThrow(() => assertJourneyQualification(value, binding, action.run_id));
  for (const changed of [
    { observations: [action, action] },
    { observations: [{ ...action, fixture_run: '44444444-4444-4444-8444-444444444444' }] },
    { observations: [{ ...action, source_pair: { ...action.source_pair, source_commit: 'b'.repeat(40) } }] },
    { companions: [{ id: 'Call Mode', enabled: false, state: 'disabled-observed' }] },
  ]) assert.throws(() => assertJourneyQualification({ ...value, ...changed }, binding, action.run_id),
    { code: 'journey-observations-invalid' });
});

test('unsettled writes, source changes and deal restore limitations refuse business execution before browser creation', async t => {
  for (const reason of ['unsettled', 'old-source', 'needs-restore', 'wrong-deal']) {
    const f = await businessFixture(t), supplied = { ...f.supplied,
      browserFactory: async () => assert.fail('refused fixture must not create a browser'),
      journeys: async () => assert.fail('refused fixture must not run business journeys') };
    if (reason === 'unsettled') supplied.coverage = async () => { throw Object.assign(new Error('synthetic gap'), { code: 'write-coverage-incomplete' }); };
    if (reason === 'old-source') supplied.session = async () => ({ state: {}, release: { ...release, source_commit: 'c'.repeat(40) } });
    if (['needs-restore', 'wrong-deal'].includes(reason)) supplied.prepare = async (...args) => {
      const setup = await f.supplied.prepare(...args);
      return { ...setup, ...(reason === 'needs-restore' ? { needs_restore: [{ record: 'deal', reason: 'closed' }] }
        : { records: { deal: { id: '60000000-0000-4000-8000-000000000002' } } }) };
    };
    await assert.rejects(runBusinessPhase({ binding, run: f.run }, supplied), {
      code: reason === 'unsettled' ? 'write-coverage-incomplete' : reason === 'old-source' ? 'source-pair-mismatch' : 'business-fixture-requires-reconciliation' });
    if (reason === 'unsettled') assert.deepEqual(f.events, []);
  }
});

test('missing observed UI coverage after business execution cannot be converted into a successful worker', async t => {
  const f = await businessFixture(t);
  let completed = false;
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    journeys: async options => { const result = await f.supplied.journeys(options); completed = true; return result; },
    coverage: async () => {
      if (completed) throw Object.assign(new Error('synthetic missing UI witness'), { code: 'write-coverage-incomplete' });
    } }), { code: 'write-coverage-incomplete' });
  assert.equal(f.events.includes('browser-close'), true);
});

test('only a retained, canonically re-admitted observed move may resume into its pending undo', async t => {
  for (const prior of ['observed-move', 'missing-move', 'undo-already-observed', 'admission-refused']) {
    const f = await businessFixture(t);
    const move = { operation: 'patch-deal-field', journey: { id: 'W4', step: 'move', state: 'observed' },
      response: { binding: { effect: { new_value: 'research' } } } };
    f.plan.browser_write_attempts = prior === 'missing-move' ? [] : [move];
    if (prior === 'undo-already-observed') f.plan.browser_write_attempts.push({ journey: { id: 'W4', step: 'undo', state: 'observed' } });
    await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
    const prepare = f.supplied.prepare;
    f.supplied.prepare = async (...args) => ({ ...await prepare(...args),
      needs_restore: [{ record: 'deal', reason: 'phase_changed', current_phase: 'research' }] });
    let admissions = 0;
    f.fixtureGuard.admitBusinessJourneyStep = async spec => {
      admissions++;
      assert.equal(spec.phase, 'admit'); assert.equal(spec.journey, 'W4'); assert.equal(spec.step, 'move');
      if (prior === 'admission-refused') throw Object.assign(new Error('synthetic retained binding changed'), { code: 'journey-binding-changed' });
    };
    if (prior === 'observed-move') {
      const result = await runBusinessPhase({ binding, run: f.run }, f.supplied);
      assert.equal(result.full_v1_qualified, false);
      assert.equal(admissions, 1);
    } else {
      await assert.rejects(runBusinessPhase({ binding, run: f.run }, f.supplied), {
        code: prior === 'admission-refused' ? 'journey-binding-changed' : 'business-fixture-requires-reconciliation' });
      assert.equal(f.events.includes('business'), false);
      assert.equal(f.events.includes('install-guard'), false);
    }
  }
});

test('each restored invocation revalidates business observations through the runner before treating sweep progress as complete', async t => {
  const f = await continuationFixture(t, { interrupt: false }), phases = [];
  const dependencies = { ...f.dependencies, progress: async () => ({ phase: 'complete', completion: { status: 'ACCEPTED_SWEEP' } }),
    work: async options => { phases.push(options.phase); return f.dependencies.work(options); } };
  const first = await boundedInvocation(f.base, dependencies);
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash, size: Number(first.size) };
  const second = await boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'restored-business'),
    publicDir: join(f.root, 'restored-business-public'), envelopePath: join(f.root, 'restored-business.enc'),
    expected, incoming: { ...expected, path: f.base.envelopePath } }, dependencies);
  assert.deepEqual(phases, ['business', 'business']);
  assert.equal(first.accepted_v1, 'false'); assert.equal(second.accepted_v1, 'false');
});

test('deadline or model-budget exhaustion after safe progress refuses another worker and refuses sealing', async t => {
  for (const reason of ['deadline', 'model-budget']) {
    const f = await continuationFixture(t);
    let stopped = false;
    const dependencies = { ...f.dependencies, now: () => stopped && reason === 'deadline' ? f.base.deadline : Date.now(),
      work: async options => {
        const result = await f.dependencies.work(options);
        if (reason === 'model-budget') {
          const path = join(options.output, 'run-budget.json');
          const state = JSON.parse(await readFile(path, 'utf8'));
          state.modelCalls = state.globalModelCalls = 5000;
          await writeFile(path, JSON.stringify(state), { mode: 0o600 });
        }
        stopped = true;
        return result;
      } };
    await assert.rejects(boundedInvocation(f.base, dependencies), {
      code: reason === 'deadline' ? 'deadline-exhausted' : 'global-budget-unsettled-or-exhausted' });
    assert.equal(f.calls(), 1);
    await assert.rejects(readFile(f.base.envelopePath), { code: 'ENOENT' });
  }
});

test('two controllers cannot write or seal the same invocation concurrently', async t => {
  const f = await continuationFixture(t);
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  const first = boundedInvocation(f.base, { ...f.dependencies, work: async options => { enter(); await gate; return f.dependencies.work(options); } });
  await entered;
  try { await assert.rejects(boundedInvocation(f.base, f.dependencies), { code: 'EEXIST' }); }
  finally { resume(); }
  await first;
  assert.equal(f.calls(), 1);
});


test('W15 prerequisites pause without proof, refuse hosted proof admission, and bind local proof to trusted bytes and run', async t => {
  const module = await import('../../scripts/e2e-staging/continue-run.mjs');
  assert.equal(typeof module.invoicePrerequisite, 'function');
  const f = await businessFixture(t);
  const runId = 'synthetic_' + sha;
  const admit = environment => module.invoicePrerequisite({ output: f.run.root, binding, runId, environment });
  assert.equal((await admit({})).status, 'PAUSED_LOCAL_INVOICE_FIXTURE');
  const proofPath = join(f.run.root, 'proof.json');
  await writeFile(proofPath, '{}', { mode: 0o600 });
  const descriptorPath = join(f.run.root, 'admission.json');
  const descriptor = { schema: 'doctorcre-local-invoice-admission.v1', checkout: sha,
    sourcePair: { source_commit: sha, carr_source_commit: binding.carr }, runId,
    fixtureRun: f.plan.run, proofPath, proofSha256: createHash('sha256').update('{}').digest('hex'),
    verifiedTarget: { project: { id: 'synthetic-project', name: 'carr-staging-replacement-test' },
      branch: { id: 'synthetic-branch', name: 'main' }, endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.neon.tech' }, database: 'neondb' } };
  const bytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, bytes, { mode: 0o600 });
  const environment = { E2E_INVOICE_ADMISSION: descriptorPath,
    E2E_INVOICE_ADMISSION_SHA256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal((await admit(environment)).status, 'READY');
  await assert.rejects(admit({ ...environment, GITHUB_ACTIONS: 'true' }), { code: 'invoice-proof-local-only' });
  await assert.rejects(admit({ ...environment, E2E_INVOICE_ADMISSION_SHA256: 'f'.repeat(64) }), { code: 'invoice-admission-unproved' });
  await writeFile(proofPath, '{"changed":true}', { mode: 0o600 });
  await assert.rejects(admit(environment), { code: 'invoice-admission-unproved' });
  await writeFile(proofPath, '{}', { mode: 0o600 });
  f.plan.run = 'different-fixture-run';
  await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
  await assert.rejects(admit(environment), { code: 'invoice-admission-unproved' });
});

test('business caller invokes W15 separately on Home with invoice-deal and canonical proof import before navigation', async t => {
  const f = await businessFixture(t), calls = [];
  const supplied = { ...f.supplied,
    invoicePrerequisite: async () => ({ status: 'READY', verifiedTarget: {}, proofPath: '/synthetic/private/proof.json', proofSha256: digest }),
    journeys: async options => { calls.push(options); return { completed: options.journeys, steps: [], full_v1_qualified: false }; } };
  f.fixtureGuard.admitBusinessJourneyStep = async spec => {
    assert.equal(spec.journey, 'W15'); assert.equal(spec.deal, f.plan.records.invoice.deal_id);
    assert.equal(spec.phase, 'import-fixture'); assert.equal(spec.proofPath, '/synthetic/private/proof.json');
    f.events.push('import-invoice-proof'); return { proof_sha256: digest };
  };
  const result = await runBusinessPhase({ binding, run: f.run }, supplied);
  assert.deepEqual(calls.map(row => row.journeys), [['W4', 'W9'], ['W15']]);
  assert.equal(calls[1].deal, f.plan.records.invoice.deal_id);
  assert.equal(calls[1].page.url(), contract.origin + '/');
  assert.equal(calls[1].invoiceProofPath, undefined, 'runner uses canonically imported proof; no second file read');
  assert.equal(result.full_v1_qualified, false);
});

test('missing local invoice prerequisite seals partial progress but never dispatches business or automatic continuation', async t => {
  const f = await continuationFixture(t, { interrupt: false }), phases = [];
  const result = await boundedInvocation(f.base, { ...f.dependencies,
    invoicePrerequisite: async () => ({ status: 'PAUSED_LOCAL_INVOICE_FIXTURE' }),
    progress: async () => ({ phase: phases.includes('sweep') ? 'complete' : phases.length ? 'sweep' : 'explore' }),
    work: async options => { phases.push(options.phase); return f.dependencies.work(options); } });
  assert.deepEqual(phases, ['explore']);
  assert.equal(result.job_status, 'PAUSED_LOCAL_INVOICE_FIXTURE');
  assert.equal(result.proof_status, 'PARTIAL'); assert.equal(result.accepted_v1, 'false');
  assert.ok((await readFile(f.base.envelopePath)).length > 0);
  const ledger = JSON.parse(await readFile(join(f.base.output, 'run-budget.json'), 'utf8'));
  assert.equal(ledger.startedAt, f.base.startedAt); assert.equal(ledger.deadline, f.base.deadline);
});


test('local invoice pause restores the same budget/deadline and revalidates business through canonical runner', async t => {
  const f = await continuationFixture(t, { interrupt: false }), phases = [];
  const first = await boundedInvocation(f.base, { ...f.dependencies,
    invoicePrerequisite: async () => ({ status: 'PAUSED_LOCAL_INVOICE_FIXTURE' }),
    progress: async () => ({ phase: phases.length ? 'complete' : 'explore' }),
    work: async options => { phases.push(options.phase); return f.dependencies.work(options); } });
  assert.equal(first.job_status, 'PAUSED_LOCAL_INVOICE_FIXTURE');
  const previous = JSON.parse(await readFile(join(f.base.output, 'run-budget.json'), 'utf8'));
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash, size: Number(first.size) };
  const next = { ...f.base, slot: 2, output: join(f.root, 'restored'), publicDir: join(f.root, 'public-two'),
    envelopePath: join(f.root, 'two.enc'), expected, incoming: { ...expected, path: f.base.envelopePath } };
  const resumed = await boundedInvocation(next, { ...f.dependencies,
    progress: async () => ({ phase: 'complete' }),
    work: async options => { phases.push(options.phase); return f.dependencies.work(options); } });
  assert.deepEqual(phases, ['explore', 'business']); assert.equal(resumed.accepted_v1, 'false');
  const after = JSON.parse(await readFile(join(next.output, 'run-budget.json'), 'utf8'));
  assert.equal(after.startedAt, previous.startedAt); assert.equal(after.deadline, previous.deadline);
  assert.equal(after.globalModelCalls, previous.globalModelCalls + 1);
  assert.equal(after.globalHttpRequests, previous.globalHttpRequests + 1);
  assert.ok(after.artifactBytes > previous.artifactBytes);
  for (const name of await readdir(next.publicDir))
    assert.doesNotMatch(await readFile(join(next.publicDir, name), 'utf8'), new RegExp(privateMarker));
});

test('invoice/client restore limitations and invoice alias of active deal refuse before any browser or journey', async t => {
  for (const kind of ['invoice', 'client', 'same-deal']) {
    const f = await businessFixture(t);
    if (kind === 'same-deal') {
      f.plan.records.invoice.deal_id = f.plan.records.deal.id;
      await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
    }
    await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
      prepare: async (...args) => ({ ...await f.supplied.prepare(...args),
        needs_restore: kind === 'same-deal' ? [] : [{ record: kind, reason: 'changed' }] }),
      browserFactory: async () => assert.fail('unproved fixture must not launch browser') }),
    { code: 'business-fixture-requires-reconciliation' });
  }
});

test('retained quarantined invoice binds the same trusted target/proof without requiring or replaying the installer file', async t => {
  const { invoicePrerequisite } = await import('../../scripts/e2e-staging/continue-run.mjs');
  const f = await businessFixture(t), runId = 'synthetic_' + sha;
  const target = { project: { name: 'carr-staging-replacement-test', id: 'synthetic' }, database: 'neondb' };
  const sorted = value => value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  f.plan.fixture_proofs = { invoice: { state: 'quarantined', proof_sha256: digest,
    verified_target_sha256: createHash('sha256').update(JSON.stringify(sorted(target))).digest('hex') } };
  await writeFile(join(f.run.root, 'staging-records-plan.json'), JSON.stringify(f.plan), { mode: 0o600 });
  const descriptor = { schema: 'doctorcre-local-invoice-admission.v1', checkout: sha,
    sourcePair: { source_commit: sha, carr_source_commit: binding.carr }, runId, fixtureRun: f.plan.run,
    proofPath: join(f.run.root, 'removed-original-installer-proof.json'), proofSha256: digest, verifiedTarget: target };
  const path = join(f.run.root, 'trusted.json'), bytes = JSON.stringify(descriptor);
  await writeFile(path, bytes, { mode: 0o600 });
  const environment = { E2E_INVOICE_ADMISSION: path, E2E_INVOICE_ADMISSION_SHA256: createHash('sha256').update(bytes).digest('hex') };
  const result = await invoicePrerequisite({ output: f.run.root, binding, runId, environment });
  assert.equal(result.status, 'READY'); assert.equal(result.proofPath, undefined);
  descriptor.proofSha256 = 'f'.repeat(64);
  const changed = JSON.stringify(descriptor); await writeFile(path, changed, { mode: 0o600 });
  await assert.rejects(invoicePrerequisite({ output: f.run.root, binding, runId,
    environment: { ...environment, E2E_INVOICE_ADMISSION_SHA256: createHash('sha256').update(changed).digest('hex') } }),
  { code: 'invoice-admission-unproved' });
});

test('hosted CLI cannot use local invoice admission or local continuation options', async () => {
  const result = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../scripts/e2e-staging/continue-run.mjs', import.meta.url)), 'local-invocation'],
    { env: { ...process.env, GITHUB_ACTIONS: 'true', E2E_SESSION_SECRET: privateMarker } }).catch(error => error);
  assert.equal(result.code, 1); assert.match(result.stderr, /invoice-proof-local-only/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateMarker));
});


test('worker prerequisite refusal precedes session/browser and changed canonical imported proof cannot dispatch', async t => {
  const f = await businessFixture(t);
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    invoicePrerequisite: async () => ({ status: 'PAUSED_LOCAL_INVOICE_FIXTURE' }),
    prepare: async () => assert.fail('paused worker must not authenticate or read fixtures') }),
  { code: 'invoice-local-prerequisite-required' });
  assert.deepEqual(f.events, ['canonical-coverage']);
  f.fixtureGuard.admitBusinessJourneyStep = async () => ({ proof_sha256: 'f'.repeat(64) });
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    invoicePrerequisite: async () => ({ status: 'READY', verifiedTarget: {},
      proofPath: '/synthetic/private/proof.json', proofSha256: digest }),
    browserFactory: async () => assert.fail('proof substitution must not launch browser') }),
  { code: 'invoice-admission-unproved' });
});

test('private admission, installer proof and local options reject owned FIFOs promptly without changing state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-private-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mkfifo = promisify(execFile);
  const plan = { run: '60000000-0000-4000-8000-000000000003', release: {
    source_commit: binding.app, carr_source_commit: binding.carr } };
  const planPath = join(root, 'staging-records-plan.json');
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const originalPlan = await readFile(planPath);
  const runId = 'synthetic_' + sha, cli = fileURLToPath(new URL('../../scripts/e2e-staging/continue-run.mjs', import.meta.url));
  const invokeAdmission = (path, hashValue = digest) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { invoicePrerequisite } from ${JSON.stringify(new URL('../../scripts/e2e-staging/continue-run.mjs', import.meta.url).href)};\n` +
    `await invoicePrerequisite({ output: ${JSON.stringify(root)}, binding: ${JSON.stringify(binding)}, runId: ${JSON.stringify(runId)}, environment: { E2E_INVOICE_ADMISSION: ${JSON.stringify(path)}, E2E_INVOICE_ADMISSION_SHA256: ${JSON.stringify(hashValue)} } });`],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 1500 });
  const cases = [];
  const admissionFifo = join(root, 'admission.json');
  await mkfifo('mkfifo', [admissionFifo]);
  cases.push({ path: admissionFifo, run: () => invokeAdmission(admissionFifo) });
  const proofFifo = join(root, 'proof.json');
  await mkfifo('mkfifo', [proofFifo]);
  const descriptor = { schema: 'doctorcre-local-invoice-admission.v1', checkout: binding.checkout,
    sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr }, runId,
    fixtureRun: plan.run, proofPath: proofFifo, proofSha256: digest,
    verifiedTarget: { project: { id: 'synthetic', name: 'carr-staging-replacement-test' },
      branch: { id: 'synthetic', name: 'main' }, endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.neon.tech' }, database: 'neondb' } };
  const descriptorPath = join(root, 'admission-regular.json'), descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  cases.push({ path: proofFifo, run: () => invokeAdmission(descriptorPath,
    createHash('sha256').update(descriptorBytes).digest('hex')) });
  const optionsFifo = join(root, 'local-options.json');
  await mkfifo('mkfifo', [optionsFifo]);
  cases.push({ path: optionsFifo, run: () => spawnSync(process.execPath, [cli, 'local-invocation'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 1500,
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', E2E_LOCAL_INVOCATION: optionsFifo,
      E2E_LOCAL_INVOCATION_SHA256: digest } }) });
  for (const item of cases) {
    const before = await (await import('node:fs/promises')).lstat(item.path);
    const result = item.run();
    assert.equal(result.error?.code, undefined, `FIFO reader hung: ${item.path}`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /private-file-invalid/);
    const after = await (await import('node:fs/promises')).lstat(item.path);
    assert.deepEqual([after.dev, after.ino, after.mode, after.nlink], [before.dev, before.ino, before.mode, before.nlink]);
    assert.deepEqual(await readFile(planPath), originalPlan);
  }
});

async function tourProofFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-tour-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRun = '66666666-6666-4666-8666-666666666666';
  const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin,
    state: 'complete', inflight: null, run: fixtureRun,
    observed_at: '2026-10-14T22:00:00.000Z', release: { source_commit: sha, carr_source_commit: binding.carr },
    names: { tour: `Synthetic staging QA ${fixtureRun} draft tour` },
    keys: { tour: '77777777-7777-4777-8777-777777777777' }, receipts: {},
    records: { client: { id: '11111111-1111-4111-8111-111111111111' },
      tour: { id: '22222222-2222-4222-8222-222222222222', name: `Synthetic staging QA ${fixtureRun} draft tour` } } };
  const target = { project: { id: 'synthetic-staging', name: 'carr-staging-replacement-test' },
    branch: { id: 'synthetic-main', name: 'main' }, endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.neon.tech' }, database: 'neondb' };
  const row = { tour_id: plan.records.tour.id, tour_name: plan.names.tour, client_id: plan.records.client.id,
    route_version_id: '33333333-3333-4333-8333-333333333333', route_version: 1,
    route_accepted: false, active_stop_count: 0, excluded_stop_count: 1,
    property_id: '047d2970-7c7b-56d5-bc87-84faa7a55775', property_status: 'unknown',
    stop_id: '92ddebd5-b044-58e0-ac00-ab85fdbb9bba', stop_state: 'excluded', route_sequence: null,
    route_label: null, access_coordinate_status: 'unknown' };
  const proof = { schema: 'doctorcre-staging-fixture-proof.v1',
    provenance: { kind: 'raw-sql-fixture', readback: 'separate-committed-readonly-connection' }, fixture_run: fixtureRun,
    source_pair: plan.release, recorded_plan_observed_at: plan.observed_at, verified_target: target,
    tool_source_sha256: 'c843e55af5a4fa745a2ea593073ff4f89cd0f5ddeb6a9478d66c9f0ac61d097d',
    fixture: { mode: 'excluded-tour-stop', tour_readback: row } };
  const runId = 'synthetic_' + sha, proofPath = join(root, 'tour-proof.json');
  const descriptor = { schema: 'doctorcre-local-tour-admission.v1', checkout: sha,
    sourcePair: plan.release, runId, fixtureRun, proofPath, proofSha256: '', verifiedTarget: target,
    toolSourceCommit: '64564fd3cb0b37b825f6cae3525a699665c66bad' };
  const descriptorPath = join(root, 'tour-admission.json');
  const persist = async () => {
    const bytes = JSON.stringify(proof);
    await writeFile(proofPath, bytes, { mode: 0o600 });
    descriptor.proofSha256 = createHash('sha256').update(bytes).digest('hex');
    const config = JSON.stringify(descriptor);
    await writeFile(descriptorPath, config, { mode: 0o600 });
    return { E2E_TOUR_ADMISSION: descriptorPath, E2E_TOUR_ADMISSION_SHA256: createHash('sha256').update(config).digest('hex') };
  };
  await writeFile(join(root, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return { root, plan, proof, row, descriptor, persist, runId };
}

test('Tour proof adapter uses exact raw installer shape and trusted target/source/run/tool bindings without authority claims', async t => {
  const { tourPrerequisite } = await import('../../scripts/e2e-staging/continue-run.mjs');
  assert.equal(typeof tourPrerequisite, 'function');
  const f = await tourProofFixture(t);
  const admit = environment => tourPrerequisite({ output: f.root, binding, runId: f.runId, environment });
  assert.equal((await admit({})).status, 'UNQUALIFIED_MISSING_TOUR_PROOF');
  const result = await admit(await f.persist());
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.fixtureBinding, { schema: 'doctorcre-staging-tour-fixture-binding.v1',
    provenance: 'private_installer_raw_readback', run: f.plan.run, source_pair: { app: sha, carr: binding.carr },
    tour_id: f.row.tour_id, route_version_id: f.row.route_version_id,
    excluded_stop_id: f.row.stop_id, synthetic_property_id: f.row.property_id });
  const original = structuredClone(f.proof);
  for (const mutate of [p => { p.tool_source_sha256 = 'f'.repeat(64); },
    p => { p.tool_source_sha256 = 'db7e20687718b5defcf6d0014789def63121ef441ab78af5282b198d47c297a4'; },
    p => { p.fixture_run = 'other'; }, p => { p.source_pair.source_commit = 'f'.repeat(40); },
    p => { p.verified_target.endpoint.host = 'ep-other.neon.tech'; },
    p => { p.fixture.tour_readback.stop_id = '44444444-4444-4444-8444-444444444444'; },
    p => { p.fixture.tour_readback.route_accepted = true; }, p => { p.receipt = 'fabricated'; }]) {
    Object.keys(f.proof).forEach(key => delete f.proof[key]); Object.assign(f.proof, structuredClone(original));
    mutate(f.proof);
    await assert.rejects(admit(await f.persist()), { code: 'tour-admission-unproved' });
  }
});

test('completed controls with missing Tour proof stay partial and do not invent W6 qualification', async t => {
  const f = await continuationFixture(t, { interrupt: false });
  const result = await boundedInvocation(f.base, { ...f.dependencies,
    tourPrerequisite: async () => ({ status: 'UNQUALIFIED_MISSING_TOUR_PROOF' }),
    progress: async () => ({ phase: 'complete', completion: { status: 'ACCEPTED_SWEEP' } }) });
  assert.equal(result.job_status, 'PARTIAL'); assert.equal(result.proof_status, 'PARTIAL');
  assert.equal(result.tour_status, 'UNQUALIFIED_MISSING_TOUR_PROOF'); assert.equal(result.accepted_v1, 'false');
});

test('readonly Tour caller uses the existing guarded factory, private binding and fresh normal detail under real HTTP caps 5/4', async t => {
  const { runTourPhase } = await import('../../scripts/e2e-staging/continue-run.mjs');
  assert.equal(typeof runTourPhase, 'function');
  const { stagingFixtureWriteGuard } = await import('../../scripts/e2e-staging/records.mjs');
  const { admitFixtureRun } = await import('./fixture-admission.mjs');
  admitFixtureRun(t);
  for (const cap of [5, 4, 10]) {
    const f = await tourProofFixture(t), environment = await f.persist();
    const run = openRun(f.root, { runId: f.runId, events: null, limits: { ...RUN_LIMITS, httpRequests: cap } });
    t.after(() => run.dispose());
    const journal = await readFile(join(f.root, 'staging-records-plan.json'));
    const guard = stagingFixtureWriteGuard({ output: f.root, release, run });
    const stop = { id: f.row.stop_id, property_id: f.row.property_id, stop_state: 'excluded', route_sequence: null,
      route_label: null, access_coordinate_status: 'unknown' };
    const detail = { id: f.row.tour_id, name: f.plan.names.tour, status: 'draft', subject_type: 'client',
      subject_id: f.plan.records.client.id, route_version_state: 'draft', accepted_route_version: 0,
      route_version_id: f.row.route_version_id, routes: [{ id: f.row.route_version_id, route_version: 1,
        accepted: false, routing_source: 'manual', stops: [stop] }], stops: [stop] };
    const reads = [], body = value => ({ status: () => 200, json: async () => value });
    const read = async (path, value) => {
      const response = await guard.handle({ method: () => 'GET', url: () => contract.origin + path }, async () => {
        reads.push(path); return body(value);
      });
      return response.json();
    };
    const selectors = [];
    const page = { url: () => contract.origin + '/tours', on() {}, off() {},
      evaluate: async fn => {
        if (String(fn).includes('__tourJourneyIdentity__')) return { release: await read('/app-release', release),
          session: await read('/auth/session', { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' }) };
        return read('/api/tours/detail?tour_id=' + f.row.tour_id, detail);
      },
      locator: selector => {
        selectors.push(selector);
        return { count: async () => selector.startsWith('#upcoming-tours') ? 1 : 0,
          click: async () => { await read('/api/tours/detail?tour_id=' + f.row.tour_id, detail); },
          waitFor: async () => {}, textContent: async () => f.plan.names.tour,
          allTextContents: async () => ['draft', '0 stops'] };
      } };
    const factory = { freshPage: async options => {
      assert.equal(options.fixtureGuard, guard); assert.equal(options.path, '/tours'); return page;
    } };
    const invoke = () => runTourPhase({ binding, run, plan: f.plan, fixtureGuard: guard,
      release, factory, target: { name: 'staging-live' }, environment });
    if (cap >= 5) {
      const result = await invoke(); assert.equal(result.full_v1_qualified, false);
      assert.deepEqual(result.unqualified_write_journeys, ['create-tour', 'edit-tour', 'accept-route']);
      await guard.assertCoverage();
      if (cap === 10) {
        const repeated = await invoke();
        assert.equal(repeated.full_v1_qualified, false);
        assert.equal(repeated.backend_readback.excluded_stop_id, result.backend_readback.excluded_stop_id);
        await guard.assertCoverage();
      }
    } else await assert.rejects(invoke(), { code: 'http-request-limit' });
    assert.equal(run.snapshot().globalHttpRequests, cap);
    assert.equal(reads.length, cap); assert.equal(run.snapshot().globalModelCalls, 0);
    assert.ok(selectors.some(selector => selector.startsWith('#upcoming-tours')));
    assert.equal(f.plan.receipts.tour, undefined);
    const after = JSON.parse(await readFile(join(f.root, 'staging-records-plan.json'), 'utf8'));
    assert.equal(after.receipts.tour, undefined); assert.equal(after.browser_write_attempts, undefined);
    assert.deepEqual(await readFile(join(f.root, 'staging-records-plan.json')), journal, 'read-only reruns never create a receipt or replay business writes');
  }
});


test('combined caller installs the existing guard before Tour navigation and disposes all contexts after a qualification refusal', async t => {
  const f = await businessFixture(t), calls = [];
  await assert.rejects(runBusinessPhase({ binding, run: f.run }, { ...f.supplied,
    tourPrerequisite: async () => ({ status: 'READY', fixtureBinding: { synthetic: true } }),
    qualifyTour: async options => {
      assert.equal(options.page.url(), contract.origin + '/tours');
      assert.equal(options.run, f.run); assert.deepEqual(options.sourcePair, { app: sha, carr: binding.carr });
      assert.equal(f.events.filter(event => event === 'install-guard').length, 3);
      calls.push('readonly-tour'); throw Object.assign(new Error('synthetic changed detail'), { code: 'tour-detail-unproved' });
    } }), { code: 'tour-detail-unproved' });
  assert.deepEqual(calls, ['readonly-tour']);
  assert.equal(f.events.filter(event => event === 'business').length, 2, 'W4/W9 and W15 remain separate canonical calls');
  assert.equal(f.events.filter(event => event === 'context-close').length, 3);
  assert.equal(f.events.at(-1), 'browser-close');
});


test('Tour admission rejects an untrusted descriptor digest, old checkout, wrong run, production target and wrong controller source before browser creation', async t => {
  const { tourPrerequisite } = await import('../../scripts/e2e-staging/continue-run.mjs');
  for (const kind of ['digest', 'checkout', 'run', 'production', 'controller', 'old-controller']) {
    const f = await tourProofFixture(t);
    if (kind === 'checkout') f.descriptor.checkout = 'f'.repeat(40);
    if (kind === 'run') f.descriptor.runId = 'other';
    if (kind === 'production') f.descriptor.verifiedTarget.project.id = 'steep-field-48688294';
    if (kind === 'controller') f.descriptor.toolSourceCommit = '2c58a001ee44fa1bf204d65684f3cf3bec52e4c4';
    if (kind === 'old-controller') f.descriptor.toolSourceCommit = '4c1e52086b2c299b9cc4dd79fdc14047fa9fd1f2';
    const environment = await f.persist();
    if (kind === 'digest') environment.E2E_TOUR_ADMISSION_SHA256 = 'f'.repeat(64);
    await assert.rejects(tourPrerequisite({ output: f.root, binding, runId: f.runId, environment }), { code: 'tour-admission-unproved' });
  }
});
