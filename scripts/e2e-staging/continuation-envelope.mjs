import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { RUN_LIMITS, RunLimitError, directoryBytes, validEvidenceCharges } from './run-limits.mjs';
import { assertStagingWriteCoverage } from './records.mjs';
import { assertRetainedEvidenceParent, protectedRows, rebaseEvidenceReferences, retainedEvidenceFiles, snapshotRetainedEvidence } from './evidence-manifest.mjs';

const SCHEMA = 'doctorcre-staging-continuation.v1';
const MAGIC = Buffer.from('CARR-CONT-2\0');
const CUSTODY_MAGIC = Buffer.from('CARR-HOLD-2\0');
const ADOPTION_SCHEMA = 'doctorcre-staging-continuation-adoption.v1';
const MAX_LOCAL_BYTES = 3 * RUN_LIMITS.artifactBytes;
const MAX_RSS_BYTES = 6 * RUN_LIMITS.artifactBytes;
// This is a local seal capability. The caller owns durable artifact-chain exclusion.
const adoptionTickets = new WeakMap();
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
let observedPeakRss = 0;
const checkedMemory = () => {
  const bytes = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  observedPeakRss = Math.max(observedPeakRss, bytes);
  if (bytes > MAX_RSS_BYTES) fail('continuation-memory-limit');
  return observedPeakRss;
};
const syncDirectory = async path => {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
};
const envelopeFraming = (size, records) => size - records.reduce((sum, [, meta]) => sum + meta.size, 0);
const withinDirectory = (directory, path) => {
  const part = relative(directory, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

async function custodyFile(path, { digest, bytes, consume = false }) {
  const handle = await open(path, (consume ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes || (info.mode & 0o777) !== 0o600 ||
        typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('continuation-custody-invalid');
    const prefix = Buffer.alloc(MAGIC.length);
    await handle.read(prefix, 0, prefix.length, 0);
    if (!prefix.equals(consume ? MAGIC : CUSTODY_MAGIC)) fail('continuation-custody-invalid');
    const hash = createHash('sha256').update(MAGIC), buffer = Buffer.alloc(64 * 1024);
    let position = MAGIC.length;
    while (position < bytes) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!read.bytesRead) fail('continuation-custody-invalid');
      hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
    }
    if (hash.digest('hex') !== digest) fail('continuation-custody-invalid');
    if (consume) { await handle.write(CUSTODY_MAGIC, 0, CUSTODY_MAGIC.length, 0); await handle.sync(); }
  } finally { await handle.close(); }
}

function adoptionForSeal(adoption, { runId, sourcePair, generation, predecessor, planHash }) {
  if (adoption === undefined) {
    if (generation !== 1) fail('continuation-adoption-required');
    return null;
  }
  const ticket = adoptionTickets.get(adoption);
  if (!ticket || ticket.used) fail('continuation-adoption-replayed');
  if (adoption.schema !== ADOPTION_SCHEMA || adoption.inputConsumed !== true ||
      adoption.generation !== generation - 1 || adoption.sha256 !== predecessor?.sha256 ||
      adoption.runId !== runId || json(adoption.sourcePair) !== json(sourcePair) ||
      adoption.planHash !== planHash || adoption.envelopeBytes !== ticket.envelopeBytes ||
      adoption.chargedBytes !== ticket.chargedBytes ||
      adoption.priorLedgerArtifactBytes !== ticket.priorLedgerArtifactBytes)
    fail('continuation-adoption-binding-mismatch');
  return ticket;
}

function validateTransfer(transfer, header) {
  if (header.generation === 1) {
    if (transfer !== null) fail('continuation-adoption-binding-mismatch');
    return;
  }
  if (!exactKeys(transfer, ['schema', 'artifactId', 'generation', 'sha256', 'runId', 'sourcePair',
    'contractHash', 'planHash', 'envelopeBytes', 'chargedBytes', 'priorLedgerArtifactBytes', 'inputConsumed']) ||
      transfer.schema !== ADOPTION_SCHEMA || !/^[1-9][0-9]{0,19}$/.test(transfer.artifactId) ||
      transfer.generation !== header.generation - 1 || transfer.sha256 !== header.predecessor.sha256 ||
      transfer.runId !== header.runId || json(transfer.sourcePair) !== json(header.sourcePair) ||
      transfer.contractHash !== header.contractHash || transfer.planHash !== header.planHash ||
      !Number.isSafeInteger(transfer.envelopeBytes) || transfer.envelopeBytes < 1 ||
      transfer.envelopeBytes !== transfer.chargedBytes ||
      !Number.isSafeInteger(transfer.priorLedgerArtifactBytes) ||
      transfer.priorLedgerArtifactBytes < transfer.chargedBytes || transfer.inputConsumed !== true)
    fail('continuation-adoption-binding-mismatch');
}

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
    'globalHttpRequests', 'globalModelCalls', 'artifactBytes', 'evidenceCharges', 'activeHttp', 'queuedHttp', 'processGroups', 'stopReason', 'invocations'];
  if (!exactKeys(value, keys) || value.schema !== 'doctorcre-run-budget.v1' || value.id !== runId || !RUN_ID.test(value.id) ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.deadline) || !validLimits(value.limits) ||
      value.deadline !== value.startedAt + value.limits.runTimeoutMs ||
      !['httpRequests', 'modelCalls', 'globalHttpRequests', 'globalModelCalls', 'artifactBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      value.globalHttpRequests > value.limits.httpRequests || value.globalModelCalls > value.limits.modelCalls ||
      value.artifactBytes > value.limits.artifactBytes || !validEvidenceCharges(value.evidenceCharges) ||
      Object.values(value.evidenceCharges).reduce((sum, meta) => sum + meta.size, 0) > value.artifactBytes || value.stopReason !== null ||
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
      !Number.isSafeInteger(generation) || generation < 1 || generation > 4 ||
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
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { fail('continuation-payload-invalid'); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > RUN_LIMITS.artifactBytes) fail('continuation-payload-invalid');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function readRetainedSource(path, meta) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => fail('continuation-payload-invalid'));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== meta.size ||
        typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('continuation-payload-invalid');
    const bytes = await handle.readFile();
    const current = await lstat(path);
    if (current.dev !== info.dev || current.ino !== info.ino || sha256(bytes) !== meta.sha256)
      fail('continuation-payload-invalid');
    return bytes;
  } finally { await handle.close(); }
}

function budgetForEnvelope(snapshot, runId, evidenceCharges = snapshot.evidenceCharges) {
  if (!snapshot || typeof snapshot !== 'object') fail('continuation-budget-invalid');
  const budget = {
    schema: snapshot.schema, id: snapshot.id, startedAt: snapshot.startedAt, deadline: snapshot.deadline, limits: snapshot.limits,
    httpRequests: snapshot.httpRequests, modelCalls: snapshot.modelCalls,
    globalHttpRequests: snapshot.globalHttpRequests, globalModelCalls: snapshot.globalModelCalls,
    artifactBytes: snapshot.artifactBytes, evidenceCharges, activeHttp: snapshot.activeHttp, queuedHttp: snapshot.queuedHttp,
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

function encryptedRecord(bytes, header, name, meta, secret) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', deriveKey(secret, header.runId), nonce);
  cipher.setAAD(Buffer.from(json([header, name, meta])));
  return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

function decryptedRecord(bytes, header, name, meta, secret) {
  if (bytes.length !== meta.size + 28) fail('continuation-envelope-invalid');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, header.runId), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(json([header, name, meta])));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const clear = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    if (sha256(clear) !== meta.sha256) fail('continuation-payload-invalid');
    return clear;
  } catch { fail('continuation-auth-failed'); }
}

function binaryEnvelope(encoded, recordBytes = []) {
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(encoded.length, MAGIC.length);
  return Buffer.concat([prefix, encoded, ...recordBytes]);
}

function envelopeParts(raw) {
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) fail('continuation-envelope-invalid');
  const length = raw.readUInt32BE(MAGIC.length), start = MAGIC.length + 4;
  if (length > raw.length - start) fail('continuation-envelope-invalid');
  let envelope;
  try { envelope = JSON.parse(raw.subarray(start, start + length).toString('utf8')); }
  catch { fail('continuation-envelope-invalid'); }
  return { envelope, offset: start + length };
}

function decryptPayload(envelope, secret) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, envelope.header.runId), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(json(envelope.header)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()]).toString('utf8'));
  } catch { fail('continuation-auth-failed'); }
}

async function recoverStagedEvidence(temp, root, header, secret) {
  if (await pathAbsent(temp)) return;
  const handle = await open(temp, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > RUN_LIMITS.artifactBytes)
      fail('continuation-recovery-refused');
    const raw = await handle.readFile();
    const { envelope, offset } = envelopeParts(raw);
    if (!Number.isSafeInteger(envelope.header?.chargedBytes) || envelope.header.chargedBytes < raw.length ||
        json({ ...envelope.header, chargedBytes: 0 }) !== json({ ...header, chargedBytes: 0 })) fail('continuation-recovery-refused');
    const payload = decryptPayload(envelope, secret);
    const records = [];
    let cursor = offset;
    for (const [name, meta] of Object.entries(payload.evidence?.files || {})) {
      const path = resolve(root, name), part = relative(join(root, 'evidence'), path);
      if (!name.startsWith('evidence/') || !part || part === '..' || part.startsWith(`..${sep}`) ||
          isAbsolute(part) || !Number.isSafeInteger(meta?.size) || meta.size < 0 || !HASH.test(meta.sha256 || ''))
        fail('continuation-recovery-refused');
      const end = cursor + meta.size + 28;
      if (end > raw.length) break;
      const clear = decryptedRecord(raw.subarray(cursor, end), envelope.header, name, meta, secret);
      records.push({ name, meta, clear, start: cursor });
      cursor = end;
    }
    await handle.truncate(cursor); await handle.sync();
    for (const record of records.reverse()) {
      const path = join(root, record.name);
      await assertRetainedEvidenceParent(root, path);
      if (await pathAbsent(path)) {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(record.clear); await file.sync(); } finally { await file.close(); }
      } else {
        await readRetainedSource(path, record.meta);
      }
      await syncDirectory(dirname(path));
      await handle.truncate(record.start); await handle.sync();
    }
  } finally { await handle.close(); }
  await unlink(temp);
  await syncDirectory(dirname(temp));
}

export async function sealContinuation({ output, envelopePath, secret = process.env.E2E_SESSION_SECRET,
  sourcePair, runId, generation, predecessor, run, adoption }) {
  const root = resolve(output), destination = resolve(envelopePath || '');
  const outputRelative = relative(root, destination);
  const insideOutput = outputRelative === '' ||
    (outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`));
  if (!isAbsolute(output || '') || !envelopePath || insideOutput || isAbsolute(outputRelative)) fail('continuation-path-refused');
  await privateDirectory(root);
  const planText = await readPrivateSource(join(root, 'staging-records-plan.json'));
  const planHash = sha256(planText);
  validateBinding({ runId, sourcePair, generation, predecessor, planHash });
  const ticket = adoptionForSeal(adoption, { runId, sourcePair, generation, predecessor, planHash });
  if (ticket) ticket.used = true;
  if (ticket) await privateDirectory(dirname(ticket.custody));
  if (ticket) await custodyFile(ticket.custody, { digest: adoption.sha256, bytes: ticket.envelopeBytes });
  const header = { schema: SCHEMA, runId, sourcePair, contractHash, planHash, generation, predecessor,
    chargedBytes: 0 };
  const parent = dirname(destination), temp = join(parent, `.continuation-${runId}-${generation}.tmp`);
  const physicalRoot = dirname(root);
  if (!withinDirectory(physicalRoot, destination) || ticket && !withinDirectory(physicalRoot, ticket.custody))
    fail('continuation-path-refused');
  await privateDirectory(parent);
  if (!(await pathAbsent(destination))) fail('continuation-destination-exists');
  await recoverStagedEvidence(temp, root, header, secret);
  const files = Object.fromEntries(await Promise.all(FILES.map(async name => [name, await readPrivateSource(join(root, name))])));
  validateFiles(files, sourcePair, planHash);
  await requireWriteCoverage(root);
  const evidence = await snapshotRetainedEvidence(root, JSON.parse(files['controls.json']), sourcePair, runId);
  retainedEvidenceFiles(evidence, JSON.parse(files['controls.json']), sourcePair, runId);
  if (!run || typeof run.accountEvidence !== 'function' || typeof run.reserveContinuationFraming !== 'function' ||
      typeof run.snapshot !== 'function' || run.id !== runId || resolve(run.root || '') !== root)
    fail('continuation-budget-invalid');
  const records = Object.entries(evidence.files);
  const metadata = { ...evidence, files: Object.fromEntries(records.map(([name, { size, sha256: digest }]) =>
    [name, { size, sha256: digest }])) };
  const contentBytes = records.reduce((sum, [, meta]) => sum + meta.size, 0);
  const changedEvidenceBytes = ticket ? records.reduce((sum, [name, meta]) =>
    sum + (ticket.files[name]?.sha256 === meta.sha256 && ticket.files[name]?.size === meta.size ? 0 : meta.size), 0) : contentBytes;
  const unmeteredEvidenceBytes = run.accountEvidence(metadata.files).chargedBytes;
  const beforeFraming = budgetForEnvelope(run.snapshot(), runId, metadata.files);
  let encoded, framing = 0, envelopeBytes;
  for (let attempt = 0; attempt < 8; attempt++) {
    header.chargedBytes = contentBytes + framing;
    const payload = { files, budget: { ...beforeFraming, artifactBytes: beforeFraming.artifactBytes + framing }, evidence: metadata,
      transfer: adoption || null };
    encoded = encryptPayload(payload, header, secret);
    envelopeBytes = MAGIC.length + 4 + encoded.length + contentBytes + records.length * 28;
    const measuredFraming = envelopeFraming(envelopeBytes, records);
    if (envelopeBytes > run.limits.artifactBytes)
      fail('continuation-size-limit');
    if (measuredFraming === framing) break;
    framing = measuredFraming;
    if (attempt === 7) fail('continuation-size-limit');
  }
  if (header.chargedBytes !== envelopeBytes ||
      beforeFraming.artifactBytes < (ticket ? ticket.priorLedgerArtifactBytes : 0))
    fail('continuation-budget-invalid');
  run.reserveContinuationFraming(framing, beforeFraming.artifactBytes);
  let handle, transferred = false, peakLocalBytes = directoryBytes(physicalRoot);
  if (peakLocalBytes + envelopeBytes > MAX_LOCAL_BYTES) fail('continuation-physical-limit');
  const artifactHash = createHash('sha256');
  let digest, peakMemoryBytes;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const prefix = binaryEnvelope(encoded);
    artifactHash.update(prefix);
    await handle.writeFile(prefix); await handle.sync();
    const parentHandle = await open(parent, constants.O_RDONLY);
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    for (const [name, meta] of records) {
      const source = join(root, name);
      await assertRetainedEvidenceParent(root, source);
      const bytes = await readRetainedSource(source, meta);
      const encrypted = encryptedRecord(bytes, header, name, metadata.files[name], secret);
      artifactHash.update(encrypted);
      await handle.writeFile(encrypted);
      await handle.sync();
      peakLocalBytes = Math.max(peakLocalBytes, directoryBytes(physicalRoot));
      if (peakLocalBytes > MAX_LOCAL_BYTES)
        fail('continuation-size-limit');
      await unlink(source);
      await syncDirectory(dirname(source));
      transferred = true;
    }
    await handle.close(); handle = null;
    const encodedSize = (await lstat(temp)).size;
    peakLocalBytes = Math.max(peakLocalBytes, directoryBytes(physicalRoot));
    if (encodedSize !== envelopeBytes || encodedSize > run.limits.artifactBytes || peakLocalBytes > MAX_LOCAL_BYTES)
      fail('continuation-size-limit');
    digest = artifactHash.digest('hex');
    peakMemoryBytes = checkedMemory();
    await link(temp, destination);
    await unlink(temp);
    const dir = await open(parent, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  } catch {
    if (handle) await handle.close().catch(() => {});
    if (transferred) await recoverStagedEvidence(temp, root, header, secret).catch(() => {});
    else await unlink(temp).catch(() => {});
    fail('continuation-write-failed');
  }
  if (ticket) {
    ticket.used = true;
    await unlink(ticket.custody);
    await syncDirectory(dirname(ticket.custody));
  }
  return Object.freeze({ path: destination, sha256: digest, generation, predecessor, runId, sourcePair,
    contractHash, planHash, envelopeBytes, chargedBytes: envelopeBytes,
    accounting: Object.freeze({ schema: 'doctorcre-staging-logical-evidence-budget.v1',
      changedEvidenceBytes, unmeteredEvidenceBytes, framingBytes: framing,
      chargedBytes: run.snapshot().artifactBytes, peakMemoryBytes, peakLocalBytes }) });
}

function expectedBinding(expected, header) {
  if (!expected || typeof expected !== 'object' || expected.sha256 !== undefined && !HASH.test(expected.sha256) ||
      !['sha256', 'generation', 'predecessor', 'runId', 'sourcePair', 'contractHash', 'planHash'].every(key => Object.hasOwn(expected, key)) ||
      expected.sha256 !== header.artifactSha256 || expected.generation !== header.generation || expected.runId !== header.runId ||
      expected.contractHash !== header.contractHash || expected.planHash !== header.planHash ||
      json(expected.sourcePair) !== json(header.sourcePair) || json(expected.predecessor) !== json(header.predecessor))
    fail('continuation-binding-mismatch');
}

export async function restoreContinuation({ envelopePath, destination, secret = process.env.E2E_SESSION_SECRET,
  expected, adoptIncoming }) {
  const incoming = resolve(envelopePath || '');
  if (adoptIncoming) await privateDirectory(dirname(incoming));
  let raw;
  try {
    const handle = await open(incoming, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
          typeof process.getuid === 'function' && info.uid !== process.getuid() ||
          info.size > RUN_LIMITS.artifactBytes) fail('continuation-envelope-invalid');
      raw = await handle.readFile();
    } finally { await handle.close(); }
  } catch { fail('continuation-envelope-invalid'); }
  const envelopeBytes = raw.length;
  const { envelope, offset } = envelopeParts(raw);
  if (!exactKeys(envelope, ['header', 'nonce', 'tag', 'ciphertext']) || !exactKeys(envelope.header,
      ['schema', 'runId', 'sourcePair', 'contractHash', 'planHash', 'generation', 'predecessor', 'chargedBytes']) ||
      envelope.header.schema !== SCHEMA || !/^[A-Za-z0-9+/]{16}$/.test(envelope.nonce) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(envelope.tag) || typeof envelope.ciphertext !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)) fail('continuation-envelope-invalid');
  const digest = sha256(raw), header = { ...envelope.header, artifactSha256: digest };
  if (!Number.isSafeInteger(header.chargedBytes) || header.chargedBytes !== raw.length) fail('continuation-envelope-invalid');
  if (adoptIncoming && (!exactKeys(adoptIncoming, ['artifactId', 'digest', 'bytes']) ||
      !/^[1-9][0-9]{0,19}$/.test(adoptIncoming.artifactId) ||
      adoptIncoming.digest !== digest || adoptIncoming.bytes !== raw.length)) fail('continuation-adoption-binding-mismatch');
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
  if (!exactKeys(payload, ['files', 'budget', 'evidence', 'transfer'])) fail('continuation-payload-invalid');
  validateFiles(payload.files, header.sourcePair, header.planHash);
  validateBudget(payload.budget, header.runId);
  if (json(payload.budget.evidenceCharges) !== json(payload.evidence?.files)) fail('continuation-budget-invalid');
  validateTransfer(payload.transfer, header);
  if (payload.transfer && payload.budget.artifactBytes < payload.transfer.priorLedgerArtifactBytes)
    fail('continuation-budget-invalid');
  if (payload.budget.artifactBytes < header.chargedBytes) fail('continuation-budget-invalid');
  let cursor = offset;
  for (const [name, meta] of Object.entries(payload.evidence?.files || {})) {
    if (!Number.isSafeInteger(meta?.size) || meta.size < 0 || cursor + meta.size + 28 > raw.length)
      fail('continuation-envelope-invalid');
    const bytes = decryptedRecord(raw.subarray(cursor, cursor + meta.size + 28), envelope.header, name, meta, secret);
    meta.bytes = bytes.toString('base64');
    cursor += meta.size + 28;
  }
  if (cursor !== raw.length) fail('continuation-envelope-invalid');
  let retained;
  try { retained = retainedEvidenceFiles(payload.evidence, JSON.parse(payload.files['controls.json']), header.sourcePair, header.runId); }
  catch { fail('continuation-payload-invalid'); }
  for (const meta of Object.values(payload.evidence.files)) delete meta.bytes;
  raw = null;
  checkedMemory();
  const root = resolve(destination || '');
  if (!isAbsolute(destination || '') || !destination) fail('continuation-path-refused');
  const parent = dirname(root), lockPath = `${root}.restore.lock`;
  await privateDirectory(parent);
  const physicalBytes = () => directoryBytes(parent) + (withinDirectory(parent, incoming) ? 0 : envelopeBytes);
  const restoredControls = rebaseEvidenceReferences(JSON.parse(payload.files['controls.json']), payload.evidence.source_root, root);
  const restoredFiles = Object.fromEntries([...FILES, 'run-budget.json'].map(name => [name,
    name === 'run-budget.json' ? json(payload.budget) + '\n' : name === 'controls.json'
      ? json(restoredControls) + '\n' : payload.files[name]]));
  const manifest = retained.size ? { ...payload.evidence, source_root: root,
    checkpoint_sha256: sha256(json(restoredControls)), protected_rows: protectedRows(restoredControls),
    files: payload.budget.evidenceCharges } : null;
  const manifestText = manifest ? json(manifest) + '\n' : '';
  const plannedBytes = Object.values(restoredFiles).reduce((sum, value) => sum + Buffer.byteLength(value), 0) +
    [...retained.values()].reduce((sum, value) => sum + value.length, 0) + Buffer.byteLength(manifestText);
  let peakLocalBytes = physicalBytes();
  if (peakLocalBytes + plannedBytes > MAX_LOCAL_BYTES || checkedMemory() > MAX_RSS_BYTES)
    fail('continuation-physical-limit');
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail('continuation-destination-busy'); }
  const temporary = join(parent, `.restore-${randomBytes(12).toString('hex')}.tmp`);
  const custody = adoptIncoming ? join(dirname(incoming), `.adopted-${header.runId}-${header.generation}-${randomBytes(12).toString('hex')}.carr`) : null;
  let published = false, peakMemoryBytes;
  try {
    if (!(await pathAbsent(root))) fail('continuation-destination-exists');
    await mkdir(temporary, { mode: 0o700 });
    for (const [name, content] of Object.entries(restoredFiles)) {
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
      const handle = await open(join(temporary, 'evidence', 'manifest.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(manifestText); await handle.sync(); } finally { await handle.close(); }
      for (const path of [...evidenceDirectories].sort((a, b) => b.length - a.length)) {
        const handle = await open(path, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    await requireWriteCoverage(temporary);
    const dir = await open(temporary, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    peakLocalBytes = Math.max(peakLocalBytes, physicalBytes());
    if (peakLocalBytes > MAX_LOCAL_BYTES) fail('continuation-physical-limit');
    peakMemoryBytes = checkedMemory();
    if (!(await pathAbsent(root))) fail('continuation-destination-exists');
    await rename(temporary, root);
    published = true;
    const parentHandle = await open(parent, constants.O_RDONLY); try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    peakLocalBytes = Math.max(peakLocalBytes, physicalBytes());
    if (peakLocalBytes > MAX_LOCAL_BYTES ||
        checkedMemory() > MAX_RSS_BYTES) fail('continuation-physical-limit');
    if (custody) {
      if (!(await pathAbsent(custody))) fail('continuation-adoption-binding-mismatch');
      await custodyFile(incoming, { digest, bytes: envelopeBytes, consume: true });
      await rename(incoming, custody);
      await syncDirectory(dirname(incoming));
    }
  } catch (error) {
    if (published) {
      await rename(root, temporary);
      await syncDirectory(parent);
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    await syncDirectory(parent);
    if (error instanceof RunLimitError) throw error;
    fail('continuation-restore-failed');
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
  const adoption = custody ? Object.freeze({ schema: ADOPTION_SCHEMA, artifactId: adoptIncoming.artifactId,
    generation: header.generation, sha256: digest, runId: header.runId, sourcePair: header.sourcePair,
    contractHash: header.contractHash, planHash: header.planHash, envelopeBytes,
    chargedBytes: header.chargedBytes, priorLedgerArtifactBytes: payload.budget.artifactBytes,
    inputConsumed: true }) : undefined;
  if (adoption) adoptionTickets.set(adoption, { custody, envelopeBytes, chargedBytes: header.chargedBytes,
    priorLedgerArtifactBytes: payload.budget.artifactBytes, files: Object.fromEntries(Object.entries(payload.evidence.files)
      .map(([name, meta]) => [name, { size: meta.size, sha256: meta.sha256 }])), used: false });
  return Object.freeze({ destination: root, sha256: digest, generation: header.generation, predecessor: header.predecessor,
    runId: header.runId, sourcePair: header.sourcePair, contractHash: header.contractHash, planHash: header.planHash,
    envelopeBytes, chargedBytes: header.chargedBytes,
    priorLedgerArtifactBytes: payload.budget.artifactBytes, adoption,
    peakMemoryBytes, peakLocalBytes });
}
