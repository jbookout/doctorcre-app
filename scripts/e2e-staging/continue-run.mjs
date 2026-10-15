import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export const ABSOLUTE_CUTOFF = Date.parse('2026-10-15T12:00:00Z');
const canaryPhases = new Set(['session', 'browser-launch', 'context', 'guard', 'navigation', 'asset-settlement', 'shell', 'source-readback']);
const project = fileURLToPath(new URL('../../', import.meta.url));
const sha40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const execute = promisify(execFile);
const ownFailures = new WeakSet();
const refusal = code => {
  const error = new Error('Staging continuation refused: ' + code);
  error.code = code; ownFailures.add(error); throw error;
};

export function assertSourcePair(release, binding) {
  if (!sha40(binding?.checkout) || !sha40(binding?.app) || binding?.carr !== contract.producer.source_commit ||
      release?.service !== 'doctorcre-app' || release.environment !== 'staging' ||
      release.source_commit !== binding.app || release.carr_source_commit !== binding.carr) refusal('source-pair-mismatch');
}

export function invocationBoundary({ now = Date.now(), deadline, sliceMs }) {
  if (![now, deadline, sliceMs].every(Number.isSafeInteger) || sliceMs < 1 ||
      now >= deadline || now >= ABSOLUTE_CUTOFF) refusal('deadline-exhausted');
  return Math.min(deadline, now + sliceMs, ABSOLUTE_CUTOFF);
}

export function assertTrustedArtifact(offered, expected) {
  if (!expected || !/^[1-9][0-9]*$/.test(expected.artifactId || '') || !sha256(expected.digest) ||
      !Number.isSafeInteger(expected.generation) || expected.generation < 1 ||
      !(expected.predecessor === null || sha256(expected.predecessor)) ||
      ['artifactId', 'digest', 'generation', 'predecessor'].some(key => offered?.[key] !== expected[key]))
    refusal('artifact-chain-mismatch');
}

export function canaryRequestAllowed(method, value) {
  try {
    const url = new URL(value);
    return ['GET', 'HEAD'].includes(method) && url.origin === contract.origin && !url.username && !url.password &&
      !url.search && (['/', '/app-release', '/api/system-work/session'].includes(url.pathname) ||
        /^\/(?:js|css|assets|icons|public-shell|islands)\/[a-zA-Z0-9_./-]+\.(?:m?js|css|woff2?|png|jpe?g|svg|ico)$/.test(url.pathname));
  } catch { return false; }
}

async function privateBytes(path, maximum = 16 * 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) refusal('private-file-invalid');
    return await handle.readFile();
  } finally { await handle.close(); }
}

// A protected runner descriptor pins an independently qualified runtime. Its
// expected digest is supplied by the workflow/host, never by the offered file.
// Presence of a dispatcher or an authentication variable is not qualification.
export function assertQualifiedDesk(entry, descriptor, receipt) {
  if (!entry || entry.kind !== descriptor.kind || entry.kind === 'claude-session' ||
      !isAbsolute(descriptor.cwd || '') || entry.cwd !== descriptor.cwd ||
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(descriptor.effort) ||
      entry.effort !== descriptor.effort || receipt.effort !== descriptor.effort)
    refusal('model-room-desk-unqualified');
  if (['codex-session', 'codex-live'].includes(entry.kind)) {
    // Codex registries retain a family, not the catalog-resolved executor.
    // The independently qualified receipt binds that resolved model as well.
    if (!['sol', 'luna'].includes(descriptor.family) || entry.family !== descriptor.family ||
        receipt.family !== descriptor.family ||
        !new RegExp(`^gpt-[0-9]+(?:\\.[0-9]+)*-${descriptor.family}$`).test(descriptor.model))
      refusal('model-room-desk-unqualified');
  } else if (entry.model !== descriptor.model || descriptor.family !== undefined || receipt.family !== undefined) {
    refusal('model-room-desk-unqualified');
  }
}

export async function qualifiedModelRoom({ descriptorPath, expectedDigest, binding, now = Date.now() }) {
  if (!descriptorPath || !isAbsolute(descriptorPath) || !sha256(expectedDigest)) refusal('model-room-runtime-unqualified');
  const { MODEL_ROOM_DISPATCH_CONTRACT: pinned } = await import('./model-room.mjs');
  const bytes = await privateBytes(descriptorPath, 32 * 1024);
  if (hash(bytes) !== expectedDigest) refusal('model-room-runtime-unqualified');
  const descriptor = JSON.parse(bytes);
  assertSourcePair({ service: 'doctorcre-app', environment: 'staging', source_commit: binding?.app,
    carr_source_commit: binding?.carr }, binding);
  if (descriptor.schema !== 'doctorcre-model-room-qualified-runtime.v1' ||
      descriptor.checkout !== binding.checkout || descriptor.sourcePair?.source_commit !== binding.app ||
      descriptor.sourcePair?.carr_source_commit !== binding.carr ||
      descriptor.dispatcherRevision !== pinned.revision || descriptor.dispatcherSha256 !== pinned.sha256 ||
      descriptor.family !== pinned.family || descriptor.model !== pinned.model || descriptor.effort !== pinned.effort ||
      !isAbsolute(descriptor.dispatcherPath || '') || !isAbsolute(descriptor.registryPath || '') ||
      !isAbsolute(descriptor.repositoryPath || '') || !isAbsolute(descriptor.qualificationReceiptPath || '') ||
      !sha256(descriptor.registrySha256) || !sha256(descriptor.qualificationReceiptSha256) ||
      !Number.isSafeInteger(descriptor.qualifiedAt) || !Number.isSafeInteger(descriptor.expiresAt) ||
      descriptor.qualifiedAt > now || descriptor.expiresAt <= now || descriptor.expiresAt > ABSOLUTE_CUTOFF ||
      !/^[a-z0-9][a-z0-9-]{1,40}$/.test(descriptor.desk || '') ||
      typeof descriptor.model !== 'string' || !descriptor.model || descriptor.completion !== 'synchronous')
    refusal('model-room-runtime-unqualified');
  if (hash(await readFile(descriptor.dispatcherPath)) !== pinned.sha256) refusal('model-room-dispatcher-mismatch');
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: descriptor.repositoryPath })).stdout.trim();
  if (revision !== pinned.revision.split('@')[1] || resolve(descriptor.repositoryPath, pinned.relativePath) !== descriptor.dispatcherPath)
    refusal('model-room-dispatcher-mismatch');
  await execute('git', ['diff', '--quiet', 'HEAD'], { cwd: descriptor.repositoryPath });
  const receiptBytes = await privateBytes(descriptor.qualificationReceiptPath, 32 * 1024);
  if (hash(receiptBytes) !== descriptor.qualificationReceiptSha256) refusal('model-room-runtime-unqualified');
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schema !== 'doctorcre-model-room-qualification.v1' || receipt.status !== 'QUALIFIED' ||
      receipt.desk !== descriptor.desk || receipt.model !== descriptor.model || receipt.kind !== descriptor.kind ||
      receipt.dispatcherSha256 !== pinned.sha256 || receipt.registrySha256 !== descriptor.registrySha256 ||
      receipt.checkout !== descriptor.checkout || receipt.sourcePair?.source_commit !== binding.app ||
      receipt.sourcePair?.carr_source_commit !== binding.carr ||
      receipt.qualifiedAt !== descriptor.qualifiedAt || receipt.expiresAt !== descriptor.expiresAt ||
      receipt.authentication !== 'authenticated' || receipt.completion !== 'synchronous') refusal('model-room-runtime-unqualified');
  const registryBytes = await privateBytes(descriptor.registryPath, 1024 * 1024);
  if (hash(registryBytes) !== descriptor.registrySha256) refusal('model-room-registry-mismatch');
  const registry = JSON.parse(registryBytes);
  const entry = registry.desks?.[descriptor.desk];
  assertQualifiedDesk(entry, descriptor, receipt);
  const appRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: descriptor.cwd })).stdout.trim();
  if (appRevision !== binding.checkout) refusal('model-room-desk-unqualified');
  await execute('git', ['diff', '--quiet', 'HEAD'], { cwd: descriptor.cwd });
  return { CARR_MODEL_ROOM_DISPATCH: descriptor.dispatcherPath, CARR_HERMES_DESKS: descriptor.registryPath,
    E2E_MODEL_ROOM_DESK: descriptor.desk };
}

export async function canary({ binding, run }, supplied = {}) {
  const session = supplied.session || (await import('./session.mjs')).stagingSession;
  const releaseProbe = supplied.releaseProbe || (await import('./session.mjs')).stagingRelease;
  const browserFactory = supplied.browserFactory || (async () => (await import('playwright')).chromium.launch());
  const phase = supplied.onPhase || (async () => {});
  await phase('session');
  const { state, release } = await session(contract.origin, { run });
  assertSourcePair(release, binding);
  let browser, context;
  try {
    await phase('browser-launch');
    browser = await browserFactory();
    await phase('context');
    context = await browser.newContext({ storageState: state, serviceWorkers: 'block' });
    await phase('guard');
    await context.route('**/*', async route => {
      const request = route.request();
      if (!canaryRequestAllowed(request.method(), request.url())) return route.abort();
      const response = await run.http(() => route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: run.limits.httpTimeoutMs }));
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    let scriptFailed = false;
    page.on('pageerror', () => { scriptFailed = true; });
    await phase('navigation');
    const response = await page.goto(contract.origin + '/', { waitUntil: 'domcontentloaded', timeout: run.limits.httpTimeoutMs });
    await phase('asset-settlement');
    await page.waitForLoadState('networkidle', { timeout: run.limits.httpTimeoutMs });
    await phase('shell');
    await page.locator('#appShell .app-shell-navigation').waitFor({ state: 'visible', timeout: run.limits.httpTimeoutMs });
    if (!response?.ok() || scriptFailed || page.url() !== contract.origin + '/' || await page.locator('main').count() !== 1)
      refusal('canary-shell-refused');
    await phase('source-readback');
    assertSourcePair(await releaseProbe(undefined, contract.origin, { run }), binding);
    run.check();
    return { schema: 'doctorcre-staging-startup-canary.v1', status: 'AUTHENTICATED_READ_ONLY_CANARY',
      acceptedV1: false, checkout: binding.checkout, app: binding.app, carr: binding.carr };
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

export async function assertCheckout(expected, repository = project) {
  const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  if (!sha40(expected) || actual !== expected) refusal('checkout-mismatch');
  try { await execute('git', ['diff', '--quiet', 'HEAD'], { cwd: repository }); }
  catch { refusal('checkout-source-changed'); }
}

// Public release reads only: no session, browser context or credentials. Keep
// the full response read inside the canonical HTTP admission and timeout.
export async function verifyFrozenSource({ binding, run, repository = project, fetcher = fetch }) {
  await assertCheckout(binding.checkout, repository);
  const read = url => run.http(async () => {
    const response = await fetcher(url, { redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([run.signal, AbortSignal.timeout(run.limits.httpTimeoutMs)]) });
    if (!response.ok) refusal('source-pair-readback-refused');
    return response.json();
  });
  const app = await read(contract.origin + '/app-release');
  const carr = await read(contract.carr_origin + '/release');
  if (carr.env?.value !== 'staging') refusal('source-pair-mismatch');
  assertSourcePair({ ...app, carr_source_commit: carr.git_sha?.value }, binding);
  await assertCheckout(binding.checkout, repository);
  run.check();
}

function bindings(environment) {
  const binding = { checkout: environment.GITHUB_SHA, app: environment.E2E_EXPECTED_APP_SHA,
    carr: contract.producer.source_commit };
  assertSourcePair({ service: 'doctorcre-app', environment: 'staging', source_commit: binding.app,
    carr_source_commit: binding.carr }, binding);
  return binding;
}

async function canaryJob(environment) {
  const { openRun } = await import('./run-limits.mjs');
  const { supervise } = await import('./supervise.mjs');
  const binding = bindings(environment);
  await assertCheckout(binding.checkout);
  const duration = invocationBoundary({ deadline: ABSOLUTE_CUTOFF, sliceMs: 120_000 }) - Date.now();
  if (duration < 1) refusal('deadline-exhausted');
  const limits = await canaryLimits(duration);
  const output = resolve(environment.E2E_V2_OUTPUT);
  let state;
  try {
    state = await supervise({ command: process.execPath, args: [fileURLToPath(import.meta.url), 'canary-worker'],
      output, environment, limits });
  } catch (error) {
    let marker;
    try { marker = JSON.parse(await privateBytes(join(output, 'private', 'startup-canary.json'), 4096)); } catch {}
    const diagnostic = canaryFailure(marker, error?.code);
    refusal(`canary-${diagnostic.phase}-${diagnostic.stopReason}`);
  }
  invocationBoundary({ deadline: ABSOLUTE_CUTOFF, sliceMs: 1 });
  const receipt = JSON.parse(await readFile(join(output, 'private', 'startup-canary.json'), 'utf8'));
  assertSourcePair({ service: 'doctorcre-app', environment: 'staging', source_commit: receipt.app,
    carr_source_commit: receipt.carr }, binding);
  if (receipt.status !== 'AUTHENTICATED_READ_ONLY_CANARY' || receipt.acceptedV1 !== false || receipt.checkout !== binding.checkout)
    refusal('canary-receipt-invalid');
  const publicDir = resolve(environment.E2E_EVIDENCE_PACKAGE);
  if (publicDir === output || publicDir.startsWith(output + '/')) refusal('public-private-overlap');
  const budget = openRun(output, { limits: state.limits, runId: state.id, events: null });
  try {
    try { await verifyFrozenSource({ binding, run: budget }); }
    catch (error) {
      const diagnostic = canaryFailure({ schema: 'doctorcre-staging-canary-phase.v1', phase: 'source-readback' }, error?.code);
      refusal(`canary-${diagnostic.phase}-${diagnostic.stopReason}`);
    }
    const settled = budget.snapshot();
    const safe = JSON.stringify({ schema: 'doctorcre-staging-startup-canary.v1', status: receipt.status,
      acceptedV1: false, checkout: binding.checkout, app: binding.app, carr: binding.carr,
      httpRequests: settled.globalHttpRequests, modelCalls: 0 }, null, 2) + '\n';
    budget.reserveBytes(Buffer.byteLength(safe));
    await mkdir(publicDir, { mode: 0o700 });
    await writeFile(join(publicDir, 'startup-canary.json'), safe, { mode: 0o600, flag: 'wx' });
  } finally { budget.dispose(); }
  await assertCheckout(binding.checkout);
  invocationBoundary({ deadline: state.deadline, sliceMs: 1 });
  return { job_status: 'CANARY_PASSED', proof_status: 'STARTUP_ONLY', accepted_v1: 'false' };
}

export async function canaryLimits(duration) {
  const { RUN_LIMITS } = await import('./run-limits.mjs');
  return { ...RUN_LIMITS, modelCalls: 0, httpRequests: 300, artifactBytes: 8 * 1024 * 1024,
    runTimeoutMs: duration, testTimeoutMs: duration };
}

export function canaryFailure(marker, reason) {
  const closed = new Set(['worker-exit-1', 'stop-signal', 'whole-run-deadline', 'http-request-limit',
    'http-admission-timeout', 'http-timeout', 'artifact-byte-limit', 'process-cleanup-unverified',
    'process-inspection-unavailable', 'run-ledger-invalid', 'run-ledger-busy', 'source-pair-mismatch',
    'source-pair-readback-refused', 'checkout-mismatch', 'checkout-source-changed']);
  const phase = marker?.schema === 'doctorcre-staging-canary-phase.v1' && canaryPhases.has(marker.phase)
    ? marker.phase : marker?.schema === 'doctorcre-staging-startup-canary.v1' &&
      marker.status === 'AUTHENTICATED_READ_ONLY_CANARY' && marker.acceptedV1 === false ? 'cleanup' : 'startup';
  return { phase, stopReason: closed.has(reason) ? reason : 'worker-failed' };
}

function sessionSecretPath(environment) {
  if (!isAbsolute(environment.RUNNER_TEMP || '') || /[\r\n]/.test(environment.RUNNER_TEMP) ||
      !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID || ''))
    refusal('session-secret-path-invalid');
  const slot = environment.E2E_SLOT || 'canary';
  if (!/^(?:canary|[1-4])$/.test(slot)) refusal('session-secret-path-invalid');
  const path = join(environment.RUNNER_TEMP, `doctorcre-session-${environment.GITHUB_RUN_ID}-${slot}`);
  if (path !== environment.E2E_SESSION_SECRET_FILE) refusal('session-secret-path-invalid');
  return path;
}

async function sessionSecret(environment, remove = false) {
  const path = sessionSecretPath(environment);
  if (remove) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return {};
  }
  if (typeof environment.E2E_SESSION_SECRET !== 'string' || environment.E2E_SESSION_SECRET.trim().length < 32)
    refusal('session-secret-unavailable');
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) refusal('session-secret-path-invalid');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(environment.E2E_SESSION_SECRET.trim()); }
  finally { await handle.close(); }
  return {};
}

export function assertBudget(state, { runId, startedAt, deadline, limits, now = Date.now() }) {
  invocationBoundary({ now, deadline, sliceMs: 1 });
  if (state.id !== runId || state.startedAt !== startedAt || state.deadline !== deadline ||
      JSON.stringify(state.limits) !== JSON.stringify(limits) ||
      ['globalHttpRequests', 'globalModelCalls', 'artifactBytes'].some(key => !Number.isSafeInteger(state[key]) || state[key] < 0) ||
      state.globalHttpRequests >= limits.httpRequests ||
      (limits.modelCalls === 0 ? state.globalModelCalls !== 0 : state.globalModelCalls >= limits.modelCalls) ||
      state.artifactBytes >= limits.artifactBytes ||
      ['activeHttp', 'queuedHttp', 'processGroups'].some(key => !state[key] || Object.keys(state[key]).length))
    refusal('global-budget-unsettled-or-exhausted');
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function privateParent(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      await realpath(path) !== resolve(path) || typeof process.getuid === 'function' && info.uid !== process.getuid())
    refusal('private-parent-invalid');
}

export async function assertSeparated({ output, publicDir, envelopePath }) {
  const paths = [output, publicDir, envelopePath];
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path)) ||
      paths.some((path, index) => paths.some((other, j) => index !== j &&
        (resolve(path) === resolve(other) || resolve(path).startsWith(resolve(other) + '/'))))) refusal('public-private-overlap');
  for (const parent of new Set(paths.map(path => dirname(resolve(path))))) await privateParent(parent);
  if (!await absent(envelopePath) || !await absent(publicDir)) refusal('continuation-destination-exists');
}

async function progress(output, binding) {
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { phase: 'explore' }; throw error; }
  assertSourcePair(checkpoint.release, binding);
  const { screens, targets } = await import('./screens.mjs');
  const { createSweepRun } = await import('./resume.mjs');
  const { completionContract } = await import('./completion-contract.mjs');
  const routedScreens = await screens(), run = createSweepRun({ targets, routedScreens, prior: checkpoint });
  run.assertRelease(checkpoint.release);
  const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
  const verdict = run.verdict(allowlist);
  if (verdict.failedExplorations.length || verdict.failedScreens.length || verdict.failedStateObligations.length || verdict.newDeadControls.length)
    refusal('measured-failure');
  if (verdict.pendingExplorations.length || verdict.skippedExplorations.length ||
      verdict.completedExplorations !== verdict.expectedExplorations || !verdict.explorationsSourceBound)
    return { phase: 'explore', verdict };
  let setup;
  try { setup = JSON.parse(await readFile(join(output, 'staging-records.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const completion = completionContract({ verdict, release: checkpoint.release, fixtureWriteScopeComplete: true, setup, targets, routedScreens });
  if (['FAILED', 'NEEDS_RECONCILIATION'].includes(completion.status)) refusal('measured-failure');
  return { phase: completion.status === 'ACCEPTED_SWEEP' ? 'complete' : 'sweep', verdict, completion };
}

async function supervisePhase({ phase, output, environment, limits, boundary }) {
  const { supervise } = await import('./supervise.mjs');
  let interrupted = false;
  const timer = setTimeout(() => { interrupted = true; process.emit('SIGTERM'); }, Math.max(1, boundary - Date.now()));
  try {
    await supervise({ command: process.execPath, args: [fileURLToPath(import.meta.url), 'phase-worker', phase], output, environment, limits });
    return { boundary: false };
  } catch (error) {
    if (!interrupted || error.code !== 'stop-signal') throw error;
    return { boundary: true };
  } finally { clearTimeout(timer); }
}

// Local operator configuration is a separate trusted input, never inferred
// from installer output. No database connection or installer runs here.
export async function invoicePrerequisite({ output, binding, runId, environment = process.env }) {
  if (!environment.E2E_INVOICE_ADMISSION && !environment.E2E_INVOICE_ADMISSION_SHA256)
    return { status: 'PAUSED_LOCAL_INVOICE_FIXTURE' };
  if (environment.GITHUB_ACTIONS === 'true') refusal('invoice-proof-local-only');
  const path = environment.E2E_INVOICE_ADMISSION;
  if (!isAbsolute(path || '') || !sha256(environment.E2E_INVOICE_ADMISSION_SHA256)) refusal('invoice-admission-unproved');
  await privateParent(dirname(path));
  const bytes = await privateBytes(path, 16 * 1024);
  if (hash(bytes) !== environment.E2E_INVOICE_ADMISSION_SHA256) refusal('invoice-admission-unproved');
  const descriptor = JSON.parse(bytes);
  const plan = JSON.parse(await privateBytes(join(output, 'staging-records-plan.json')));
  const keys = ['schema', 'checkout', 'sourcePair', 'runId', 'fixtureRun', 'proofPath', 'proofSha256', 'verifiedTarget'];
  if (Object.keys(descriptor).sort().join() !== keys.sort().join() ||
      descriptor.schema !== 'doctorcre-local-invoice-admission.v1' || descriptor.checkout !== binding.checkout ||
      descriptor.runId !== runId || !descriptor.fixtureRun || descriptor.fixtureRun !== plan.run ||
      descriptor.sourcePair?.source_commit !== binding.app || descriptor.sourcePair?.carr_source_commit !== binding.carr ||
      plan.release?.source_commit !== binding.app || plan.release?.carr_source_commit !== binding.carr ||
      !sha256(descriptor.proofSha256) || !descriptor.verifiedTarget || !isAbsolute(descriptor.proofPath || ''))
    refusal('invoice-admission-unproved');
  const retained = plan.fixture_proofs?.invoice;
  if (retained) {
    if (retained.proof_sha256 !== descriptor.proofSha256 ||
        hash(JSON.stringify(stable(descriptor.verifiedTarget))) !== retained.verified_target_sha256)
      refusal('invoice-admission-unproved');
  } else {
    await privateParent(dirname(descriptor.proofPath));
    if (hash(await privateBytes(descriptor.proofPath, 65536)) !== descriptor.proofSha256) refusal('invoice-admission-unproved');
  }
  return { status: 'READY', verifiedTarget: descriptor.verifiedTarget,
    proofPath: retained ? undefined : descriptor.proofPath, proofSha256: descriptor.proofSha256 };
}

export async function boundedInvocation(options, dependencies = {}) {
  const { RUN_LIMITS, openRun, directoryBytes } = await import('./run-limits.mjs');
  const { sealContinuation, restoreContinuation } = await import('./continuation-envelope.mjs');
  const { assertStagingWriteCoverage } = await import('./records.mjs');
  const { packageEvidence } = await import('./package-evidence.mjs');
  const { binding, slot, runId, startedAt, deadline, secret, output, envelopePath, publicDir, incoming, expected } = options;
  const now = dependencies.now || Date.now;
  const coverage = dependencies.coverage || assertStagingWriteCoverage;
  const inspect = dependencies.progress || progress;
  const work = dependencies.work || supervisePhase;
  const checkout = dependencies.checkout || assertCheckout;
  await assertSeparated({ output, publicDir, envelopePath });
  assertSourcePair({ service: 'doctorcre-app', environment: 'staging', source_commit: binding?.app,
    carr_source_commit: binding?.carr }, binding);
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 4 || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(runId) || !runId.endsWith('_' + binding.checkout) ||
      !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline) || startedAt > now() ||
      deadline <= startedAt || deadline - startedAt > RUN_LIMITS.runTimeoutMs || deadline > ABSOLUTE_CUTOFF)
    refusal('invocation-binding-invalid');
  const limits = { ...RUN_LIMITS, runTimeoutMs: deadline - startedAt, batchGoals: 1 };
  // Stop before the existing per-test ceiling; a test timeout is a failure,
  // not a continuation boundary. Use the existing goal window as headroom.
  const boundary = invocationBoundary({ now: now(), deadline, sliceMs: limits.testTimeoutMs - limits.goalTimeoutMs });
  const budgetBinding = { runId, startedAt, deadline, limits };
  const qualification = {
    descriptorPath: options.environment?.E2E_MODEL_ROOM_DESCRIPTOR,
    expectedDigest: options.environment?.E2E_MODEL_ROOM_DESCRIPTOR_SHA256, binding };
  const qualify = () => (dependencies.qualify || qualifiedModelRoom)({ ...qualification, now: now() });
  const runtime = await qualify();
  const freeze = dependencies.freeze || (async run => {
    await verifyFrozenSource({ binding, run });
    await qualify();
  });
  const leasePath = join(dirname(envelopePath), '.continuation-writer');
  const lease = await open(leasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let budget;
  try {
    const sourcePair = { source_commit: binding.app, carr_source_commit: binding.carr };
    const contractHash = hash(await readFile(new URL('../../contracts/e2e-staging.v1.json', import.meta.url)));
    if (slot > 1) {
      if (!expected || expected.generation !== slot - 1 || !sha256(expected.planHash) ||
          (slot === 2 ? expected.predecessor !== null : !sha256(expected.predecessor))) refusal('artifact-chain-mismatch');
      assertTrustedArtifact(incoming, expected);
      const restored = await restoreContinuation({ envelopePath: incoming.path, destination: output, secret,
        expected: { sha256: expected.digest, generation: expected.generation,
          predecessor: expected.predecessor === null ? null : { generation: expected.generation - 1, sha256: expected.predecessor },
          runId, sourcePair, contractHash, planHash: expected.planHash } });
      if (restored.generation !== slot - 1) refusal('artifact-chain-mismatch');
    } else {
      if (expected || incoming || !await absent(output)) refusal('genesis-replay-refused');
      // Initialize once from trusted workflow start/deadline, then immediately
      // dispose the initializer. All subsequent checks use the real clock.
      const initial = openRun(output, { limits, runId, events: null, now: () => startedAt });
      initial.dispose();
    }
    budget = openRun(output, { limits, runId, events: null });
    assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
    if (budget.snapshot().stopReason !== null) refusal('prior-worker-failed');
    if (incoming) {
      budget.reserveBytes((await lstat(incoming.path)).size);
      await coverage(output);
    }
    const environment = { ...options.environment, ...runtime, E2E_RUN_ID: runId, E2E_ALLOW_MODEL_CALLS: runId,
      E2E_RUN_LIMITS: JSON.stringify(limits), E2E_STAGING_RESUME: '1', E2E_V2_OUTPUT: output,
      E2E_EXPECTED_APP_SHA: binding.app, GITHUB_SHA: binding.checkout };
    for (const key of ['E2E_SESSION_SECRET', 'GH_TOKEN', 'GITHUB_TOKEN',
      'DATABASE_URL', 'NEON_API_KEY', 'CLOUDFLARE_API_TOKEN']) delete environment[key];
    // Revalidate retained journey observations through the real runner once per
    // invocation. Its canonical journal skips only observed, source-bound steps;
    // no new checkpoint file or inferred completion bit is introduced.
    let businessValidated = false, paused = false;
    const inspectCurrent = async () => {
      const state = await inspect(output, binding);
      return !businessValidated && ['sweep', 'complete'].includes(state.phase)
        ? { ...state, phase: 'business' } : state;
    };
    let current = await inspectCurrent();
    while (current.phase !== 'complete' && now() < boundary) {
      assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
      if (slot > 1 || await absent(join(output, 'staging-records-plan.json')) === false) await coverage(output);
      if (current.phase === 'business') {
        const admission = await (dependencies.invoicePrerequisite || invoicePrerequisite)({
          output, binding, runId, environment: options.environment || {} });
        if (admission.status !== 'READY') { paused = true; break; }
      }
      const outcome = await work({ phase: current.phase, output, environment, limits, boundary });
      if (!await absent(join(output, '.run-owner'))) refusal('source-worker-not-quiescent');
      assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
      await coverage(output);
      if (outcome?.boundary === true) {
        if (budget.snapshot().stopReason !== 'stop-signal') refusal('unexpected-worker-stop');
        // Only our bounded timer's verified, reconciled stop is resumable.
        // It remains in invocation history; resource and global counters remain.
        budget.dispose();
        budget = openRun(output, { limits, runId, events: null, newInvocation: true });
        await freeze(budget);
        break;
      }
      if (budget.snapshot().stopReason !== null) refusal('prior-worker-failed');
      await freeze(budget);
      if (current.phase === 'business') businessValidated = true;
      current = await inspectCurrent();
    }
    assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
    if (!await absent(join(output, '.run-owner'))) refusal('source-worker-not-quiescent');
    await coverage(output);
    current = await inspectCurrent();
    const { writeReport } = await import('./report.mjs');
    const checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
    await writeReport(output, { ...checkpoint, run: budget });
    const { screens, targets } = await import('./screens.mjs');
    const routes = await screens();
    const pairs = targets.reduce((count, target) => count + routes.filter(screen => screen.surface === target.surface).length, 0);
    // The current typed package has fixed aggregate reports and less than a
    // KiB per canonical screen pair. Reserve its bounded allocation before it
    // is materialized; conservative unused bytes remain charged to the run.
    const publicAllocation = limits.artifactMetadataBytes + pairs * 1024;
    budget.reserveBytes(publicAllocation);
    await packageEvidence({ sourceDir: output, outputDir: publicDir });
    if (directoryBytes(publicDir) > publicAllocation) refusal('public-package-size-refused');
    // Reserve the bounded output receipt before sealing so its bytes are part
    // of the authenticated cumulative budget restored by the next job.
    budget.reserveBytes(1024);
    await freeze(budget);
    await checkout(binding.checkout);
    assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
    const predecessor = expected ? { generation: expected.generation, sha256: expected.digest } : null;
    const sealed = await sealContinuation({ output, envelopePath, secret, sourcePair, runId, generation: slot, predecessor, run: budget });
    // Seal may await disk publication across a clock/source change. Retain any
    // resulting private envelope, but never return a usable success receipt.
    assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
    await checkout(binding.checkout);
    await qualify();
    assertBudget(budget.snapshot(), { ...budgetBinding, now: now() });
    return { digest: sealed.sha256, generation: String(slot), predecessor: predecessor?.sha256 || '', plan_hash: sealed.planHash,
      job_status: paused ? 'PAUSED_LOCAL_INVOICE_FIXTURE' : current.phase === 'complete' ? 'SWEEP_ACCEPTED' : 'CONTINUE',
      accepted_v1: 'false', proof_status: paused ? 'PARTIAL' : current.completion?.status || 'PARTIAL' };
  } finally {
    budget?.dispose();
    await lease.close();
    await unlink(leasePath);
  }
}

export async function runBusinessPhase({ binding, run, environment = process.env }, supplied = {}) {
  const records = await import('./records.mjs');
  const session = await import('./session.mjs');
  const prepare = supplied.prepare || records.prepareStagingRecords;
  const authenticate = supplied.session || session.stagingSession;
  const releaseProbe = supplied.releaseProbe || session.stagingRelease;
  const coverage = supplied.coverage || records.assertStagingWriteCoverage;
  const guardFactory = supplied.guardFactory || records.stagingFixtureWriteGuard;
  const journeys = supplied.journeys || (await import('./business-journeys.mjs')).runBusinessJourneys;
  const { createFreshPageFactory } = await import('./playwright-fixtures.mjs');
  const { screens, targets } = await import('./screens.mjs');
  run.check();
  // Refuse an uncertain prior effect before any fresh authentication/readback.
  await coverage(run.root);
  const admission = await (supplied.invoicePrerequisite || invoicePrerequisite)({ output: run.root, binding,
    runId: run.snapshot ? run.snapshot().id : undefined, environment });
  if (admission.status !== 'READY') refusal('invoice-local-prerequisite-required');
  let state;
  const setup = await prepare(run.root, { reuseOnly: true, run, signal: run.signal,
    session: async (origin, options) => {
      const authenticated = await authenticate(origin, options);
      assertSourcePair(authenticated.release, binding);
      state = authenticated.state;
      return authenticated;
    } });
  assertSourcePair(setup.release, binding);
  const plan = JSON.parse(await privateBytes(join(run.root, 'staging-records-plan.json')));
  const deal = plan.records?.deal?.id, invoiceDeal = plan.records?.invoice?.deal_id;
  if (!state || setup.complete !== true || !Array.isArray(setup.needs_restore) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deal || '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invoiceDeal || '') ||
      invoiceDeal === deal || setup.records?.invoice?.deal_id !== invoiceDeal ||
      setup.records?.deal?.id !== deal || plan.state !== 'complete' || plan.inflight ||
      plan.release?.source_commit !== binding.app || plan.release?.carr_source_commit !== binding.carr)
    refusal('business-fixture-requires-reconciliation');
  await coverage(run.root);
  const release = setup.release;
  const fixtureGuard = guardFactory({ output: run.root, release, run, invoiceFixtureTarget: admission.verifiedTarget });
  const businessContract = (await import('../../contracts/e2e-staging-business-journeys.v1.json', { with: { type: 'json' } })).default;
  for (const limitation of setup.needs_restore.filter(row => row.record === 'deal')) {
    // A fully observed move awaiting its canonical undo is resumable progress,
    // not an unexplained fixture change. Re-admission validates the retained
    // binding without dispatching or manufacturing a new journey intent.
    const retained = plan.browser_write_attempts?.find(row => row.operation === 'patch-deal-field' &&
      row.journey?.state === 'observed' && row.response?.binding?.effect?.new_value === limitation.current_phase);
    const definition = businessContract.journeys.find(row => row.id === retained?.journey?.id);
    const undo = definition?.steps.find(row => row.predecessor === retained?.journey?.step && row.operation === 'revert-deal-field');
    if (limitation.reason !== 'phase_changed' || !retained || !undo ||
        plan.browser_write_attempts.some(row => row.journey?.id === definition.id && row.journey?.step === undo.id))
      refusal('business-fixture-requires-reconciliation');
    await fixtureGuard.admitBusinessJourneyStep({ phase: 'admit', journey: definition.id,
      step: retained.journey.step, deal, release });
  }
  if (setup.needs_restore.some(row => ['client', 'invoice'].includes(row.record)))
    refusal('business-fixture-requires-reconciliation');
  // Canonical import validates installer/source/target/creation receipts and
  // durably binds exact bytes before any Home read or possible browser write.
  if (admission.proofPath) {
    const imported = await fixtureGuard.admitBusinessJourneyStep({ phase: 'import-fixture',
      journey: 'W15', step: 'paid', deal: invoiceDeal, release, proofPath: admission.proofPath });
    if (imported?.proof_sha256 !== admission.proofSha256) refusal('invoice-admission-unproved');
  }
  const target = targets.find(row => row.name === 'staging-live');
  const screen = (await screens()).find(row => row.path === '/deals' && row.surface === 'app');
  const home = (await screens()).find(row => row.path === '/' && row.surface === 'app');
  if (!target || !screen || !home) refusal('business-fixture-route-missing');
  const browser = await (supplied.browserFactory || (async () => (await import('playwright')).chromium.launch()))();
  const removeStop = run.onStop(() => browser.close());
  const factory = createFreshPageFactory({ run,
    // The existing factory installs canonical route accounting before creating
    // a page. Add only this invocation's fresh in-memory session to its context.
    browser: { newContext: options => browser.newContext({ ...options, storageState: state, serviceWorkers: 'block' }) },
    releaseProbe: async () => {
      const actual = await releaseProbe(undefined, contract.origin, { run });
      assertSourcePair(actual, binding);
      return actual;
    } });
  try {
    const page = await factory.freshPage({ target, screen, release, fixtureGuard,
      path: `/deals?deal=${encodeURIComponent(deal)}` });
    const result = await journeys({ page, fixtureGuard, release, deal, run, journeys: ['W4', 'W9'] });
    await fixtureGuard.assertCoverage();
    await coverage(run.root);
    if (result?.full_v1_qualified !== false) refusal('business-result-unqualified');
    // A distinct guarded context starts W15 at Home. The canonical runner
    // revalidates retained observations and quarantines paid fixtures; it alone
    // admits durable intent and independent normal tracker readback.
    const invoicePage = await factory.freshPage({ target, screen: home, release, fixtureGuard, path: '/' });
    const invoice = await journeys({ page: invoicePage, fixtureGuard, release, deal: invoiceDeal, run, journeys: ['W15'] });
    await fixtureGuard.assertCoverage();
    await coverage(run.root);
    if (invoice?.full_v1_qualified !== false) refusal('business-result-unqualified');
    return { schema: 'staging-business-journey-result.v1', release: result.release,
      completed: [...result.completed, ...invoice.completed], steps: [...result.steps, ...invoice.steps],
      full_v1_qualified: false, unqualified_journeys: businessContract.unqualified_journeys };
  } finally {
    try { await factory.dispose(); }
    finally { removeStop(); await browser.close(); }
  }
}

async function phaseWorker(environment, phase) {
  const { currentRun } = await import('./run-limits.mjs');
  const { stagingSession } = await import('./session.mjs');
  const { writeReport } = await import('./report.mjs');
  const { createSweepRun } = await import('./resume.mjs');
  const { targets, screens } = await import('./screens.mjs');
  const binding = bindings(environment), run = currentRun();
  const { release } = await stagingSession(contract.origin, { run });
  assertSourcePair(release, binding);
  if (await absent(join(run.root, 'controls.json'))) {
    const initial = createSweepRun({ targets, routedScreens: await screens() });
    initial.assertRelease(release);
    await writeReport(run.root, { ...initial.snapshot(), release, run });
  }
  if (phase === 'explore') return (await import('./explore.mjs')).exploreAll();
  if (phase === 'business') {
    await runBusinessPhase({ binding, run, environment });
    return;
  }
  if (phase !== 'sweep') refusal('unknown-phase');
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['node_modules/playwright/cli.js', 'test', '--config', 'playwright.staging.config.mjs'],
      { cwd: project, env: environment, stdio: 'inherit' });
    child.once('error', () => reject(new Error('sweep-process-failed')));
    child.once('exit', code => code === 0 ? done() : reject(new Error('sweep-process-failed')));
  });
}

function directories(environment) {
  const output = resolve(environment.E2E_V2_OUTPUT || ''), publicDir = resolve(environment.E2E_EVIDENCE_PACKAGE || '');
  const encrypted = resolve(environment.E2E_CONTINUATION_DIRECTORY || ''), incoming = resolve(environment.E2E_RESTORE_DIRECTORY || '');
  const paths = [output, publicDir, encrypted, incoming];
  if (paths.some(path => path === project) || paths.some((path, index) => paths.some((other, j) => index !== j &&
      (path === other || path.startsWith(other + '/')))) || paths.some(path => dirname(path) !== dirname(output)))
    refusal('public-private-overlap');
  return { output, publicDir, encrypted, incoming, parent: dirname(output) };
}

async function prepareDirectories(environment) {
  const paths = directories(environment);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  const parent = await lstat(paths.parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) refusal('private-parent-invalid');
  for (const path of [paths.encrypted, paths.incoming]) await mkdir(path, { mode: 0o700 });
  if (!await absent(paths.output) || !await absent(paths.publicDir)) refusal('genesis-replay-refused');
  return {};
}

function expectedArtifact(environment) {
  const expected = { artifactId: environment.E2E_PREVIOUS_ARTIFACT_ID, digest: environment.E2E_PREVIOUS_DIGEST,
    generation: Number(environment.E2E_PREVIOUS_GENERATION), predecessor: environment.E2E_PREVIOUS_PREDECESSOR || null,
    planHash: environment.E2E_PREVIOUS_PLAN_HASH };
  assertTrustedArtifact(expected, expected);
  if (!sha256(expected.planHash)) refusal('artifact-chain-mismatch');
  return expected;
}

export function assertGitHubArtifact(metadata, { id, runId, checkout, generation }) {
  if (!metadata || String(metadata.id) !== id || metadata.expired !== false ||
      metadata.name !== `staging-continuation-${runId}-${generation}` ||
      String(metadata.workflow_run?.id) !== runId || metadata.workflow_run?.head_sha !== checkout ||
      !Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes < 1 || metadata.size_in_bytes > 256 * 1024 * 1024)
    refusal('artifact-identity-mismatch');
}

async function verifyGitHubArtifact(environment) {
  if (environment.GITHUB_REPOSITORY !== 'jbookout/doctorcre-app' || !environment.GH_TOKEN) refusal('artifact-identity-mismatch');
  const expected = expectedArtifact(environment), binding = bindings(environment);
  if (expected.generation !== Number(environment.E2E_SLOT) - 1) refusal('artifact-chain-mismatch');
  const response = await fetch(`https://api.github.com/repos/jbookout/doctorcre-app/actions/artifacts/${expected.artifactId}`,
    { headers: { authorization: `Bearer ${environment.GH_TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) refusal('artifact-identity-unavailable');
  const metadata = await response.json();
  assertGitHubArtifact(metadata, { id: expected.artifactId, runId: environment.GITHUB_RUN_ID,
    checkout: binding.checkout, generation: expected.generation });
  await writeFile(join(directories(environment).parent, 'artifact-download-binding.json'),
    JSON.stringify({ artifactId: String(metadata.id), checkout: binding.checkout, workflowRunId: environment.GITHUB_RUN_ID }),
    { mode: 0o600, flag: 'wx' });
  return {};
}

async function invocationJob(environment) {
  const binding = bindings(environment);
  await assertCheckout(binding.checkout);
  if (environment.GITHUB_RUN_ATTEMPT !== '1') refusal('workflow-replay-refused');
  const paths = directories(environment), slot = Number(environment.E2E_SLOT);
  let expected, incoming;
  if (slot > 1) {
    expected = expectedArtifact(environment);
    const downloaded = JSON.parse(await privateBytes(join(paths.parent, 'artifact-download-binding.json'), 4096));
    if (downloaded.artifactId !== expected.artifactId || downloaded.checkout !== binding.checkout ||
        downloaded.workflowRunId !== environment.GITHUB_RUN_ID) refusal('artifact-identity-mismatch');
    const { readdir } = await import('node:fs/promises');
    if (JSON.stringify((await readdir(paths.incoming)).sort()) !== JSON.stringify(['continuation.enc'])) refusal('artifact-content-refused');
    const path = join(paths.incoming, 'continuation.enc');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let digest;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) refusal('artifact-content-refused');
      digest = hash(await handle.readFile());
    } finally { await handle.close(); }
    incoming = { artifactId: downloaded.artifactId, digest, generation: expected.generation,
      predecessor: expected.predecessor, path };
  }
  const { readSessionSecret } = await import('./session.mjs');
  return boundedInvocation({ binding, slot, runId: environment.E2E_RUN_ID,
    startedAt: Number(environment.E2E_STARTED_AT), deadline: Number(environment.E2E_DEADLINE),
    secret: await readSessionSecret(environment.E2E_SESSION_SECRET_FILE), output: paths.output, envelopePath: join(paths.encrypted, 'continuation.enc'),
    publicDir: paths.publicDir, incoming, expected, environment });
}

// A fresh check at each workflow export edge. It makes no post-seal HTTP
// reservation: the live release pair was checked under the sealed budget.
export async function publicationBoundary(environment, supplied = {}) {
  const binding = bindings(environment), checkout = supplied.checkout || assertCheckout;
  const now = supplied.now || Date.now;
  await checkout(binding.checkout);
  const output = resolve(environment.E2E_V2_OUTPUT || '');
  if (!await absent(join(output, '.run-owner'))) refusal('source-worker-not-quiescent');
  const { RUN_LIMITS } = await import('./run-limits.mjs');
  const state = JSON.parse(await privateBytes(join(output, 'run-budget.json')));
  const full = environment.E2E_SLOT !== undefined;
  if (full && !/^[1-4]$/.test(environment.E2E_SLOT)) refusal('publication-binding-invalid');
  const startedAt = full ? Number(environment.E2E_STARTED_AT) : state.startedAt;
  const deadline = full ? Number(environment.E2E_DEADLINE) : state.deadline;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline) ||
      deadline <= startedAt || deadline - startedAt > (full ? RUN_LIMITS.runTimeoutMs : 120_000))
    refusal('publication-binding-invalid');
  const limits = full ? { ...RUN_LIMITS, runTimeoutMs: deadline - startedAt, batchGoals: 1 }
    : await canaryLimits(deadline - startedAt);
  const expected = { runId: environment.E2E_RUN_ID, startedAt, deadline, limits, now: now() };
  assertBudget(state, expected);
  if (state.stopReason !== null) refusal('prior-worker-failed');
  if (full) {
    const paths = directories(environment);
    if (!sha256(environment.E2E_PUBLICATION_DIGEST) ||
        hash(await privateBytes(join(paths.encrypted, 'continuation.enc'), limits.artifactBytes)) !== environment.E2E_PUBLICATION_DIGEST)
      refusal('publication-binding-invalid');
    const checkpoint = JSON.parse(await privateBytes(join(output, 'controls.json')));
    assertSourcePair(checkpoint.release, binding);
    await (supplied.qualify || qualifiedModelRoom)({ descriptorPath: environment.E2E_MODEL_ROOM_DESCRIPTOR,
      expectedDigest: environment.E2E_MODEL_ROOM_DESCRIPTOR_SHA256, binding, now: now() });
  } else {
    const receipt = JSON.parse(await privateBytes(join(output, 'private', 'startup-canary.json'), 4096));
    if (receipt.status !== 'AUTHENTICATED_READ_ONLY_CANARY' || receipt.acceptedV1 !== false || receipt.checkout !== binding.checkout)
      refusal('canary-receipt-invalid');
    assertSourcePair({ service: 'doctorcre-app', environment: 'staging', source_commit: receipt.app,
      carr_source_commit: receipt.carr }, binding);
  }
  await checkout(binding.checkout);
  const finalState = JSON.parse(await privateBytes(join(output, 'run-budget.json')));
  assertBudget(finalState, { ...expected, now: now() });
  if (finalState.stopReason !== null || !await absent(join(output, '.run-owner'))) refusal('source-worker-not-quiescent');
  invocationBoundary({ now: now(), deadline, sliceMs: 1 });
}

async function main(environment = process.env, command = process.argv[2]) {
  if (command === 'canary-worker') {
    const { currentRun } = await import('./run-limits.mjs');
    const run = currentRun();
    await mkdir(join(run.root, 'private'), { recursive: true, mode: 0o700 });
    const retain = receipt => run.writeFile(join(run.root, 'private', 'startup-canary.json'), JSON.stringify(receipt),
      (path, value) => writeFile(path, value, { mode: 0o600,
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW }));
    const receipt = await canary({ binding: bindings(environment), run }, { onPhase: phase => {
      if (!canaryPhases.has(phase)) refusal('canary-phase-invalid');
      return retain({ schema: 'doctorcre-staging-canary-phase.v1', phase });
    } });
    await retain(receipt);
    return {};
  }
  if (command === 'phase-worker') return phaseWorker(environment, process.argv[3]);
  if (command === 'session-path') {
    if (!environment.GITHUB_ENV) refusal('session-secret-path-invalid');
    await appendFile(environment.GITHUB_ENV, `E2E_SESSION_SECRET_FILE=${sessionSecretPath(environment)}\n`);
    return {};
  }
  if (command === 'session-secret') return sessionSecret(environment);
  if (command === 'remove-session-secret') return sessionSecret(environment, true);
  if (command === 'qualify') return void await qualifiedModelRoom({ descriptorPath: environment.E2E_MODEL_ROOM_DESCRIPTOR,
    expectedDigest: environment.E2E_MODEL_ROOM_DESCRIPTOR_SHA256, binding: bindings(environment) });
  if (command === 'prepare') return prepareDirectories(environment);
  if (command === 'verify-artifact') return verifyGitHubArtifact(environment);
  if (command === 'canary') return canaryJob(environment);
  if (command === 'invocation') return invocationJob(environment);
  if (command === 'local-invocation') {
    if (environment.GITHUB_ACTIONS === 'true' || environment.GITHUB_OUTPUT) refusal('invoice-proof-local-only');
    const path = environment.E2E_LOCAL_INVOCATION;
    if (!isAbsolute(path || '') || !sha256(environment.E2E_LOCAL_INVOCATION_SHA256)) refusal('local-invocation-unproved');
    await privateParent(dirname(path));
    const bytes = await privateBytes(path, 32 * 1024);
    if (hash(bytes) !== environment.E2E_LOCAL_INVOCATION_SHA256) refusal('local-invocation-unproved');
    const options = JSON.parse(bytes);
    const keys = ['binding', 'slot', 'runId', 'startedAt', 'deadline', 'output', 'envelopePath', 'publicDir', 'incoming', 'expected'];
    if (Object.keys(options).sort().join() !== keys.sort().join()) refusal('local-invocation-unproved');
    await assertCheckout(options.binding?.checkout);
    const { readSessionSecret } = await import('./session.mjs');
    const result = await boundedInvocation({ ...options, environment,
      secret: await readSessionSecret(environment.E2E_SESSION_SECRET_FILE) });
    const localBoundary = async () => {
      await assertCheckout(options.binding.checkout);
      const { RUN_LIMITS } = await import('./run-limits.mjs');
      assertBudget(JSON.parse(await privateBytes(join(options.output, 'run-budget.json'))), {
        runId: options.runId, startedAt: options.startedAt, deadline: options.deadline,
        limits: { ...RUN_LIMITS, runTimeoutMs: options.deadline - options.startedAt, batchGoals: 1 } });
      if (!await absent(join(options.output, '.run-owner')) ||
          hash(await privateBytes(options.envelopePath, RUN_LIMITS.artifactBytes)) !== result.digest)
        refusal('publication-binding-invalid');
      invocationBoundary({ deadline: options.deadline, sliceMs: 1 });
    };
    // Closed receipt only; consumers must require exit zero as on GitHub.
    await localBoundary();
    console.log(JSON.stringify(result));
    await localBoundary();
    return;
  }
  if (command === 'publication-boundary') return publicationBoundary(environment);
  if (command === 'plan') {
    bindings(environment);
    await assertCheckout(environment.GITHUB_SHA);
    if (!['canary', 'full'].includes(environment.E2E_MODE) || environment.E2E_MODE === 'full' && environment.GITHUB_RUN_ATTEMPT !== '1')
      refusal('workflow-replay-refused');
    const startedAt = Date.now();
    const deadline = invocationBoundary({ now: startedAt, deadline: startedAt + 20 * 60 * 60 * 1000,
      sliceMs: 20 * 60 * 60 * 1000 });
    return { started_at: String(startedAt), deadline: String(deadline) };
  }
  refusal('unknown-command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(async values => {
    if (process.env.GITHUB_OUTPUT && values) {
      const command = process.argv[2];
      if (['invocation', 'canary'].includes(command)) await publicationBoundary({ ...process.env,
        E2E_PUBLICATION_DIGEST: values.digest });
      const allowed = new Set(['started_at', 'deadline', 'digest', 'generation', 'predecessor', 'plan_hash', 'job_status', 'proof_status', 'accepted_v1']);
      const lines = [];
      for (const [key, value] of Object.entries(values)) {
        if (!allowed.has(key) || typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > 128)
          refusal('output-receipt-invalid');
        lines.push(`${key}=${value}\n`);
      }
      if (lines.length) await appendFile(process.env.GITHUB_OUTPUT, lines.join(''));
      // A late append is not a successful step; its dependent upload gates and
      // jobs remain blocked. Keep existing artifacts for explicit reconciliation.
      if (['invocation', 'canary'].includes(command)) await publicationBoundary({ ...process.env,
        E2E_PUBLICATION_DIGEST: values.digest });
    }
  }).catch(error => {
    const closed = new Set(['whole-run-deadline', 'http-request-limit', 'model-call-limit', 'artifact-byte-limit',
      'process-cleanup-unverified', 'process-inspection-unavailable', 'run-ledger-invalid', 'run-ledger-busy',
      'worker-exit-1', 'continuation-binding-mismatch', 'continuation-auth-failed', 'continuation-write-coverage-incomplete',
      'continuation-budget-unsettled', 'continuation-size-limit', 'continuation-path-refused', 'write-coverage-incomplete']);
    const code = ownFailures.has(error) || closed.has(error?.code) ? error.code : 'source-check-failed';
    console.error(`Staging continuation stopped: ${code}; no full V1 acceptance is established.`);
    process.exitCode = 1;
  });
}
