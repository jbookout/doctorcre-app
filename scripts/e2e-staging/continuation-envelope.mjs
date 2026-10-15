import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { RUN_LIMITS, RunLimitError } from './run-limits.mjs';
import { assertStagingWriteCoverage } from './records.mjs';
import { rebaseEvidenceReferences, retainedEvidenceFiles, snapshotRetainedEvidence } from './evidence-manifest.mjs';

const SCHEMA = 'doctorcre-staging-continuation.v1';
const FILES = Object.freeze(['controls.json', 'staging-records.json', 'staging-records-plan.json']);
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const SENSITIVE_KEY = /(?:authorization|(?:access|refresh|session|api)?token|cookie|storage.?state|local.?storage|session.?storage|secret|password|headers|stdout|stderr|trace|raw.?log|transcript)/i;
const PRIVATE_KEY = /^(?:auth|authentication|credentials|session|browsercontext|playwrightcontext)$/i;
const contractPath = fileURLToPath(new URL('../../contracts/e2e-staging.v1.json', import.meta.url));
const contractHash = createHash('sha256').update(await readFile(contractPath)).digest('hex');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value);
const fail = code => { throw new RunLimitError(code); };

async function requireWriteCoverage(path) {
  try { await assertStagingWriteCoverage(path); }
  catch { fail('continuation-write-coverage-incomplete'); }
}

async function privateDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of resolve(path).slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) fail('continuation-path-refused');
  }
  const info = await lstat(path);
  if ((info.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && info.uid !== process.getuid())
    fail('continuation-private-permissions-refused');
  return info;
}

async function pathAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function safeObject(value) {
  if (Array.isArray(value)) return value.every(safeObject);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !SENSITIVE_KEY.test(key) && !PRIVATE_KEY.test(key) && safeObject(child));
}

function validSourcePair(value) {
  return exactKeys(value, ['source_commit', 'carr_source_commit']) && COMMIT.test(value.source_commit) &&
    value.carr_source_commit === contract.producer.source_commit;
}

function validLimits(value) {
  return exactKeys(value, Object.keys(RUN_LIMITS)) && Object.entries(value).every(([key, amount]) =>
    Number.isSafeInteger(amount) && amount >= (['retries', 'modelCalls'].includes(key) ? 0 : 1) && amount <= RUN_LIMITS[key]);
}

function validateBudget(value, runId) {
  const keys = ['schema', 'id', 'startedAt', 'deadline', 'limits', 'httpRequests', 'modelCalls',
    'globalHttpRequests', 'globalModelCalls', 'artifactBytes', 'activeHttp', 'queuedHttp', 'processGroups', 'stopReason', 'invocations'];
  if (!exactKeys(value, keys) || value.schema !== 'doctorcre-run-budget.v1' || value.id !== runId || !RUN_ID.test(value.id) ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.deadline) || !validLimits(value.limits) ||
      value.deadline !== value.startedAt + value.limits.runTimeoutMs ||
      !['httpRequests', 'modelCalls', 'globalHttpRequests', 'globalModelCalls', 'artifactBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      value.globalHttpRequests > value.limits.httpRequests || value.globalModelCalls > value.limits.modelCalls ||
      value.artifactBytes > value.limits.artifactBytes || value.stopReason !== null ||
      !exactKeys(value.activeHttp, []) || !exactKeys(value.queuedHttp, []) || !exactKeys(value.processGroups, []) || !Array.isArray(value.invocations))
    fail('continuation-budget-unsettled');
  let http = value.httpRequests, models = value.modelCalls;
  for (const invocation of value.invocations) {
    if (!exactKeys(invocation, ['startedAt', 'deadline', 'httpRequests', 'modelCalls', 'stopReason', 'limits']) ||
        !Number.isSafeInteger(invocation.startedAt) || !Number.isSafeInteger(invocation.deadline) || !validLimits(invocation.limits) ||
        !Number.isSafeInteger(invocation.httpRequests) || invocation.httpRequests < 0 ||
        !Number.isSafeInteger(invocation.modelCalls) || invocation.modelCalls < 0 ||
        (invocation.stopReason !== null && !/^[a-z][a-z0-9-]*$/.test(invocation.stopReason))) fail('continuation-budget-unsettled');
    http += invocation.httpRequests; models += invocation.modelCalls;
  }
  if (http !== value.globalHttpRequests || models !== value.globalModelCalls) fail('continuation-budget-invalid');
  if (!safeObject(value)) fail('continuation-sensitive-field-refused');
}

function validateFiles(files, sourcePair, planHash) {
  if (!exactKeys(files, FILES)) fail('continuation-path-refused');
  const parsed = {};
  for (const name of FILES) {
    if (typeof files[name] !== 'string' || Buffer.byteLength(files[name]) > RUN_LIMITS.artifactBytes) fail('continuation-payload-invalid');
    try { parsed[name] = JSON.parse(files[name]); } catch { fail('continuation-payload-invalid'); }
    if (!safeObject(parsed[name])) fail('continuation-sensitive-field-refused');
  }
  const controls = parsed['controls.json'];
  if (!controls || !controls.release || controls.release.service !== 'doctorcre-app' || controls.release.environment !== 'staging' ||
      controls.release.source_commit !== sourcePair.source_commit || controls.release.carr_source_commit !== sourcePair.carr_source_commit ||
      !['screens', 'history', 'explorations', 'findings', 'stateObligations'].every(key => Array.isArray(controls[key])) ||
      !['expectedScreens', 'expectedExplorations', 'expectedStates'].every(key => Number.isSafeInteger(controls[key]) && controls[key] >= 0))
    fail('continuation-payload-invalid');
  const setup = parsed['staging-records.json'];
  if (!setup || setup.schema !== 'doctorcre-staging-records.v1' || setup.origin !== contract.origin || setup.complete !== true ||
      setup.release?.source_commit !== sourcePair.source_commit || setup.release?.carr_source_commit !== sourcePair.carr_source_commit ||
      !setup.records || typeof setup.records !== 'object' || !Array.isArray(setup.findings) || !Array.isArray(setup.needs_restore))
    fail('continuation-payload-invalid');
  const plan = parsed['staging-records-plan.json'];
  if (!plan || plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== contract.origin || plan.state !== 'complete' ||
      plan.release?.source_commit !== sourcePair.source_commit || plan.release?.carr_source_commit !== sourcePair.carr_source_commit ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(plan.run || '') ||
      !plan.records || typeof plan.records !== 'object' || !plan.receipts || typeof plan.receipts !== 'object' ||
      plan.state === 'inflight' || plan.inflight) fail('continuation-payload-invalid');
  if (sha256(files['staging-records-plan.json']) !== planHash) fail('continuation-plan-mismatch');
  return parsed;
}

function validateBinding({ runId, sourcePair, generation, predecessor, expectedContractHash = contractHash, planHash }) {
  if (!RUN_ID.test(runId || '') || !validSourcePair(sourcePair) || expectedContractHash !== contractHash || !HASH.test(planHash || '') ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      (generation === 1 ? predecessor !== null : !exactKeys(predecessor, ['generation', 'sha256']) ||
        predecessor.generation !== generation - 1 || !HASH.test(predecessor.sha256 || '')))
    fail('continuation-invalid-binding');
}

function deriveKey(secret, runId) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) fail('continuation-key-unavailable');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('doctorcre-e2e-continuation-v1'),
    Buffer.from(`doctorcre-staging-continuation/aes-256-gcm/${runId}`), 32));
}

async function readPrivateSource(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { fail('continuation-payload-invalid'); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > RUN_LIMITS.artifactBytes) fail('continuation-payload-invalid');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function budgetForEnvelope(snapshot, runId) {
  if (!snapshot || typeof snapshot !== 'object') fail('continuation-budget-invalid');
  const budget = {
    schema: snapshot.schema, id: snapshot.id, startedAt: snapshot.startedAt, deadline: snapshot.deadline, limits: snapshot.limits,
    httpRequests: snapshot.httpRequests, modelCalls: snapshot.modelCalls,
    globalHttpRequests: snapshot.globalHttpRequests, globalModelCalls: snapshot.globalModelCalls,
    artifactBytes: snapshot.artifactBytes, activeHttp: snapshot.activeHttp, queuedHttp: snapshot.queuedHttp,
    processGroups: snapshot.processGroups, stopReason: snapshot.stopReason, invocations: snapshot.invocations || [],
  };
  validateBudget(budget, runId);
  return budget;
}

function encryptPayload(payload, header, secret) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', deriveKey(secret, header.runId), nonce);
  cipher.setAAD(Buffer.from(json(header)));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(json(payload))), cipher.final()]);
  return Buffer.from(json({ header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
}

export async function sealContinuation({ output, envelopePath, secret = process.env.E2E_SESSION_SECRET,
  sourcePair, runId, generation, predecessor, run }) {
  const root = resolve(output), destination = resolve(envelopePath || '');
  const outputRelative = relative(root, destination);
  const insideOutput = outputRelative === '' ||
    (outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`));
  if (!isAbsolute(output || '') || !envelopePath || insideOutput || isAbsolute(outputRelative)) fail('continuation-path-refused');
  await privateDirectory(root);
  const planText = await readPrivateSource(join(root, 'staging-records-plan.json'));
  const planHash = sha256(planText);
  validateBinding({ runId, sourcePair, generation, predecessor, planHash });
  const files = Object.fromEntries(await Promise.all(FILES.map(async name => [name, await readPrivateSource(join(root, name))])));
  validateFiles(files, sourcePair, planHash);
  await requireWriteCoverage(root);
  const evidence = await snapshotRetainedEvidence(root, JSON.parse(files['controls.json']), sourcePair, runId);
  retainedEvidenceFiles(evidence, JSON.parse(files['controls.json']), sourcePair, runId);
  if (!run || typeof run.reserveBytes !== 'function' || typeof run.snapshot !== 'function' || run.id !== runId || resolve(run.root || '') !== root)
    fail('continuation-budget-invalid');
  const header = { schema: SCHEMA, runId, sourcePair, contractHash, planHash, generation, predecessor };
  let safeBudget = budgetForEnvelope(run.snapshot(), runId);
  const plaintextBytes = Buffer.byteLength(json({ files, budget: safeBudget, evidence }));
  if (Math.ceil(plaintextBytes / 3) * 4 + 4096 > Math.min(RUN_LIMITS.artifactBytes, run.limits.artifactBytes))
    fail('continuation-size-limit');
  let encoded = encryptPayload({ files, budget: safeBudget, evidence }, header, secret);
  let charged = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (encoded.length > RUN_LIMITS.artifactBytes) fail('continuation-size-limit');
    const additional = encoded.length + 128 - charged;
    if (additional > 0) { run.reserveBytes(additional); charged += additional; }
    safeBudget = budgetForEnvelope(run.snapshot(), runId);
    encoded = encryptPayload({ files, budget: safeBudget, evidence }, header, secret);
    if (encoded.length <= charged) break;
  }
  if (encoded.length > charged) fail('continuation-size-limit');
  if (encoded.length > RUN_LIMITS.artifactBytes) fail('continuation-size-limit');
  const parent = dirname(destination), temp = join(parent, `.continuation-${randomBytes(12).toString('hex')}.tmp`);
  await privateDirectory(parent);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
    await link(temp, destination);
    await unlink(temp);
    const dir = await open(parent, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  } catch {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    fail('continuation-write-failed');
  }
  return Object.freeze({ path: destination, sha256: sha256(encoded), generation, predecessor, runId, sourcePair,
    contractHash, planHash });
}

function expectedBinding(expected, header) {
  if (!expected || typeof expected !== 'object' || expected.sha256 !== undefined && !HASH.test(expected.sha256) ||
      !['sha256', 'generation', 'predecessor', 'runId', 'sourcePair', 'contractHash', 'planHash'].every(key => Object.hasOwn(expected, key)) ||
      expected.sha256 !== header.artifactSha256 || expected.generation !== header.generation || expected.runId !== header.runId ||
      expected.contractHash !== header.contractHash || expected.planHash !== header.planHash ||
      json(expected.sourcePair) !== json(header.sourcePair) || json(expected.predecessor) !== json(header.predecessor))
    fail('continuation-binding-mismatch');
}

export async function restoreContinuation({ envelopePath, destination, secret = process.env.E2E_SESSION_SECRET, expected }) {
  let raw;
  try { raw = await readPrivateSource(resolve(envelopePath)); } catch { fail('continuation-envelope-invalid'); }
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail('continuation-envelope-invalid'); }
  if (!exactKeys(envelope, ['header', 'nonce', 'tag', 'ciphertext']) || !exactKeys(envelope.header,
      ['schema', 'runId', 'sourcePair', 'contractHash', 'planHash', 'generation', 'predecessor']) ||
      envelope.header.schema !== SCHEMA || !/^[A-Za-z0-9+/]{16}$/.test(envelope.nonce) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(envelope.tag) || typeof envelope.ciphertext !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)) fail('continuation-envelope-invalid');
  const digest = sha256(raw), header = { ...envelope.header, artifactSha256: digest };
  expectedBinding(expected, header);
  validateBinding({ runId: header.runId, sourcePair: header.sourcePair, generation: header.generation,
    predecessor: header.predecessor, expectedContractHash: header.contractHash, planHash: header.planHash });
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, header.runId), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(json(envelope.header)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch { fail('continuation-auth-failed'); }
  let payload;
  try { payload = JSON.parse(plaintext.toString('utf8')); } catch { fail('continuation-payload-invalid'); }
  if (!exactKeys(payload, ['files', 'budget', 'evidence'])) fail('continuation-payload-invalid');
  validateFiles(payload.files, header.sourcePair, header.planHash);
  validateBudget(payload.budget, header.runId);
  let retained;
  try { retained = retainedEvidenceFiles(payload.evidence, JSON.parse(payload.files['controls.json']), header.sourcePair, header.runId); }
  catch { fail('continuation-payload-invalid'); }
  const root = resolve(destination || '');
  if (!isAbsolute(destination || '') || !destination) fail('continuation-path-refused');
  const parent = dirname(root), lockPath = `${root}.restore.lock`;
  await privateDirectory(parent);
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('continuation-destination-busy'); }
  const temporary = join(parent, `.restore-${randomBytes(12).toString('hex')}.tmp`);
  try {
    if (!(await pathAbsent(root))) fail('continuation-destination-exists');
    await mkdir(temporary, { mode: 0o700 });
    const restoredControls = rebaseEvidenceReferences(JSON.parse(payload.files['controls.json']),
      payload.evidence.source_root, root);
    for (const name of [...FILES, 'run-budget.json']) {
      const content = name === 'run-budget.json' ? json(payload.budget) + '\n' : name === 'controls.json'
        ? json(restoredControls) + '\n' : payload.files[name];
      const handle = await open(join(temporary, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }
    if (retained.size) {
      const evidenceDirectories = new Set();
      for (const [name, content] of retained) {
        const path = join(temporary, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        for (let parent = dirname(path); parent !== temporary; parent = dirname(parent)) evidenceDirectories.add(parent);
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      }
      const manifest = { ...payload.evidence, source_root: root,
        checkpoint_sha256: sha256(json(restoredControls)),
        files: Object.fromEntries(Object.entries(payload.evidence.files).map(([name, meta]) => [name,
          { size: meta.size, sha256: meta.sha256 }])) };
      const handle = await open(join(temporary, 'evidence', 'manifest.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(json(manifest) + '\n'); await handle.sync(); } finally { await handle.close(); }
      for (const path of [...evidenceDirectories].sort((a, b) => b.length - a.length)) {
        const handle = await open(path, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    await requireWriteCoverage(temporary);
    const dir = await open(temporary, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    if (!(await pathAbsent(root))) fail('continuation-destination-exists');
    await rename(temporary, root);
    const parentHandle = await open(parent, constants.O_RDONLY); try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (error instanceof RunLimitError) throw error;
    fail('continuation-restore-failed');
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
  return Object.freeze({ destination: root, sha256: digest, generation: header.generation, predecessor: header.predecessor,
    runId: header.runId, sourcePair: header.sourcePair, contractHash: header.contractHash, planHash: header.planHash });
}
