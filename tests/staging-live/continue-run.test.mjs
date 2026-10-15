import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canary, canaryRequestAllowed, canaryLimits, canaryFailure, qualifiedModelRoom, assertQualifiedDesk, assertBudget, assertGitHubArtifact,
  assertSeparated, boundedInvocation, runBusinessPhase, assertCheckout, verifyFrozenSource, publicationBoundary,
  assertSourcePair, invocationBoundary, assertTrustedArtifact } from '../../scripts/e2e-staging/continue-run.mjs';
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
  const expected = { artifactId: '123', digest, generation: 1, predecessor: null };
  assert.doesNotThrow(() => assertTrustedArtifact({ ...expected }, expected));
  for (const delta of [{ artifactId: '124' }, { digest: 'c'.repeat(64) }, { generation: 0 }, { predecessor: digest }])
    assert.throws(() => assertTrustedArtifact({ ...expected, ...delta }, expected));
  for (const delta of [{ artifactId: '' }, { digest: '' }, { generation: '1' }])
    assert.throws(() => assertTrustedArtifact(expected, { ...expected, ...delta }));
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

test('qualified Codex desks bind registry family and effort to the measured resolved model, not a nonexistent registry model', () => {
  const entry = { kind: 'codex-session', family: 'luna', effort: 'medium', cwd: '/synthetic/private-app' };
  const descriptor = { ...entry, model: 'gpt-6-luna' };
  const receipt = { family: 'luna', effort: 'medium' };
  assert.doesNotThrow(() => assertQualifiedDesk(entry, descriptor, receipt));
  for (const delta of [{ family: 'sol' }, { effort: 'high' }, { cwd: '/other-source' }, { kind: 'claude-session' }])
    assert.throws(() => assertQualifiedDesk({ ...entry, ...delta }, descriptor, receipt), { code: 'model-room-desk-unqualified' });
  for (const delta of [{ family: 'sol' }, { effort: undefined }])
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
  let workerCalls = 0;
  const dependencies = { invoicePrerequisite: async () => ({ status: 'READY' }), qualify: async () => ({}), checkout: async () => {}, freeze: async () => {},
    progress: async () => ({ phase: 'explore' }),
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
  return { root, base, dependencies, calls: () => workerCalls };
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
  const f = await continuationFixture(t);
  const encrypted = join(f.root, 'encrypted'), incoming = join(f.root, 'incoming');
  await mkdir(encrypted, { mode: 0o700 }); await mkdir(incoming, { mode: 0o700 });
  f.base.envelopePath = join(encrypted, 'continuation.enc');
  const first = await boundedInvocation(f.base, f.dependencies);
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
  for (let n = 1; n <= 4; n++) {
    const section = workflow.split(`\n  part_${n}:`)[1].split(/\n  (?:part_\d|full_v1_proof):/)[0];
    assert.equal(section.match(/continue-run\.mjs publication-boundary/g)?.length, 3);
    assert.ok(section.indexOf('publication-boundary') < section.indexOf('- id: encrypted'));
    assert.ok(section.lastIndexOf('publication-boundary') > section.lastIndexOf('retention-days: 14'));
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
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash };
  const secondOptions = { ...f.base, slot: 2, output: join(f.root, 'progress-two'), publicDir: join(f.root, 'public-two'),
    envelopePath: join(f.root, 'two.enc'), expected, incoming: { ...expected, path: f.base.envelopePath } };
  const second = await boundedInvocation(secondOptions, f.dependencies);
  const secondBudget = JSON.parse(await readFile(join(secondOptions.output, 'run-budget.json'), 'utf8'));
  assert.equal(secondBudget.globalHttpRequests, 2);
  assert.equal(secondBudget.globalModelCalls, 2);
  assert.equal(secondBudget.deadline, firstBudget.deadline);
  assert.ok(secondBudget.artifactBytes > firstBudget.artifactBytes + encrypted.length);
  assert.equal(second.predecessor, first.digest);
  assert.equal(second.generation, '2');
  assert.equal(second.accepted_v1, 'false');
  assert.equal(f.calls(), 2);
  assert.deepEqual((await readdir(secondOptions.publicDir)).sort(), ['controls.json', 'coverage.md', 'evidence-package.json', 'explorations.json', 'findings.json']);
  for (const name of await readdir(secondOptions.publicDir)) {
    const text = await readFile(join(secondOptions.publicDir, name), 'utf8');
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE|cookies|storageState|staging-records-plan/);
  }
});

test('wrong id, digest, generation, predecessor, plan or source never reaches a restored worker', async t => {
  const f = await continuationFixture(t), first = await boundedInvocation(f.base, f.dependencies);
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash };
  for (const delta of [{ artifactId: '124' }, { digest: 'd'.repeat(64) }, { generation: 2 }, { predecessor: 'd'.repeat(64) }])
    await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'rejected'), publicDir: join(f.root, 'rejected-public'),
      envelopePath: join(f.root, 'rejected.enc'), expected, incoming: { ...expected, ...delta, path: f.base.envelopePath } }, f.dependencies),
    { code: 'artifact-chain-mismatch' });
  await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'wrong-source'),
    publicDir: join(f.root, 'wrong-source-public'), envelopePath: join(f.root, 'wrong-source.enc'),
    binding: { ...binding, app: 'c'.repeat(40) }, expected, incoming: { ...expected, path: f.base.envelopePath } }, f.dependencies),
  { code: 'continuation-binding-mismatch' });
  await assert.rejects(boundedInvocation({ ...f.base, slot: 2, output: join(f.root, 'wrong-plan'), expected: { ...expected, planHash: 'e'.repeat(64) },
    publicDir: join(f.root, 'wrong-plan-public'), envelopePath: join(f.root, 'wrong-plan.enc'),
    incoming: { ...expected, path: f.base.envelopePath } }, f.dependencies), { code: 'continuation-binding-mismatch' });
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
  const plan = { state: 'complete', run: '60000000-0000-4000-8000-000000000003', release,
    records: { deal: { id: deal }, invoice: { deal_id: '60000000-0000-4000-8000-000000000002' } } };
  await writeFile(join(root, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const run = { root, signal: new AbortController().signal, limits: RUN_LIMITS,
    check() {}, onStop: () => () => {}, http: async operation => { events.push('http'); return operation(); } };
  const state = { cookies: [{ name: 'synthetic-session', value: privateMarker }] };
  let guarded = false, routeHandler;
  let currentURL;
  const page = { url: () => currentURL,
    goto: async url => {
      assert.equal(guarded, true);
      assert.ok([`${contract.origin}/deals?deal=${deal}`, contract.origin + '/'].includes(url));
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
      events.push('business');
      return { completed: options.journeys, steps: [], full_v1_qualified: false, unqualified_journeys: ['W6'] };
    },
  };
  return { run, supplied, events, plan, fixtureGuard };
}

test('business caller reuses the real private fixture plan, fresh session and existing guarded page factory with route accounting', async t => {
  const f = await businessFixture(t);
  const result = await runBusinessPhase({ binding, run: f.run }, f.supplied);
  assert.equal(result.full_v1_qualified, false);
  assert.deepEqual(f.events, ['canonical-coverage', 'prepare', 'authenticate', 'canonical-coverage',
    'install-guard', 'navigate', 'http', 'business', 'guard-coverage', 'canonical-coverage',
    'install-guard', 'navigate', 'http', 'business', 'guard-coverage', 'canonical-coverage',
    'context-close', 'context-close', 'guard-coverage', 'browser-close']);
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
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash };
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
  const expected = { artifactId: '123', digest: first.digest, generation: 1, predecessor: null, planHash: first.plan_hash };
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
