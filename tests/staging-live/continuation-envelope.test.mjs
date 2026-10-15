import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { RUN_LIMITS, directoryBytes, openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { restoreContinuation, sealContinuation } from '../../scripts/e2e-staging/continuation-envelope.mjs';
import { assessCurrentEvidence, verifyRetainedEvidence } from '../../scripts/e2e-staging/evidence-manifest.mjs';
import { retainedExplorationSchedule } from '../../scripts/e2e-staging/explore.mjs';

const sourcePair = { source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const secret = 'synthetic-continuation-secret-value-that-is-not-real';
const privateCanary = 'SYNTHETIC_PRIVATE_CONTROL_CANARY_84d177';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture(t, limits = RUN_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-continuation-'));
  const restored = join(root, 'restored');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'source');
  const run = openRun(output, { runId: 'synthetic-continuation-run', events: null, limits });
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

test('FIFO incoming and a retained-file FIFO substitution refuse within a bounded child', async t => {
  for (const kind of ['incoming', 'retained']) {
    const f = await fixture(t);
    const path = kind === 'incoming' ? join(f.root, 'incoming.carr') : join(f.output, 'evidence', 'screens', 'frame.jpg');
    if (kind === 'incoming') assert.equal(spawnSync('mkfifo', [path]).status, 0);
    else {
      await mkdir(join(f.output, 'evidence', 'screens'), { recursive: true, mode: 0o700 });
      await writeFile(path, 'synthetic', { mode: 0o600 });
      const controls = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
      controls.screens = [{ reached: true, controls: [{ evidence_path: path }] }];
      await writeFile(join(f.output, 'controls.json'), JSON.stringify(controls));
    }
    const script = `
      import promises from 'node:fs/promises';
      import { unlinkSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const file = ${JSON.stringify(path)};
      if (${JSON.stringify(kind)} === 'retained') {
        const original = promises.open; let reads = 0;
        promises.open = async (path, ...args) => {
          if (path === file && ++reads === 2) { unlinkSync(file); spawnSync('mkfifo', [file], { stdio: 'ignore' }); }
          return original(path, ...args);
        };
        syncBuiltinESMExports();
      }
      const { sealContinuation, restoreContinuation } = await import(${JSON.stringify(new URL('../../scripts/e2e-staging/continuation-envelope.mjs', import.meta.url).href)});
      const { openRun } = await import(${JSON.stringify(new URL('../../scripts/e2e-staging/run-limits.mjs', import.meta.url).href)});
      const run = openRun(${JSON.stringify(f.output)}, { runId: ${JSON.stringify(f.run.id)}, events: null });
      try {
        if (${JSON.stringify(kind)} === 'incoming') await restoreContinuation({ envelopePath: file, destination: ${JSON.stringify(f.restored)}, secret: ${JSON.stringify(secret)}, expected: {} });
        else await sealContinuation({ output: ${JSON.stringify(f.output)}, envelopePath: ${JSON.stringify(join(f.root, 'fifo.carr'))}, secret: ${JSON.stringify(secret)}, sourcePair: ${JSON.stringify(sourcePair)}, runId: run.id, generation: 1, predecessor: null, run });
        process.exitCode = 2;
      } catch (error) { writeFileSync(${JSON.stringify(join(f.root, 'fifo-result.json'))}, JSON.stringify({ code: error.code })); }
      finally { run.dispose(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', timeout: 3000 });
    assert.equal(child.error?.code, undefined, kind);
    assert.equal(child.status, 0);
    assert.match(JSON.parse(await readFile(join(f.root, 'fifo-result.json'), 'utf8')).code,
      /continuation-(?:envelope-invalid|write-failed)/);
  }
});

test('a refusal after destination rename rolls back publication and preserves incoming ciphertext', async t => {
  const f = await fixture(t), sealed = await seal(f), raw = await readFile(sealed.path);
  const original = fsPromises.rename;
  let injected = false;
  fsPromises.rename = async (from, to) => {
    if (to === f.restored) {
      injected = true;
      const filler = join(f.root, 'synthetic-capacity');
      await writeFile(filler, '', { mode: 0o600 });
      await truncate(filler, 3 * RUN_LIMITS.artifactBytes);
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret, expected: sealed }),
      { code: 'continuation-physical-limit' });
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); assert.equal(injected, true); }
  await assert.rejects(stat(f.restored), { code: 'ENOENT' });
  assert.deepEqual(await readFile(sealed.path), raw);
});

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

test('seal, remove and restore retains measured evidence bytes and refuses missing or changed proof', async t => {
  const f = await fixture(t);
  const path = join(f.output, 'evidence', 'explore', 'synthetic-goal', 'report.json');
  await mkdir(join(f.output, 'evidence', 'explore', 'synthetic-goal'), { recursive: true, mode: 0o700 });
  await writeFile(path, '{"schema":"synthetic-measured-report"}', { mode: 0o600 });
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.explorations = [{ target: 'staging-live', screen: 'Home', path: '/', agent: 'bug-hunter',
    steps: 1, status: 'finished', evidence: join(f.output, 'evidence', 'explore', 'synthetic-goal') }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  await rm(path);
  assert.equal((await assessCurrentEvidence(f.output, checkpoint, f.run.id)).verified, false);
  await assert.rejects(seal(f), /Retained staging evidence invalid/);
  await writeFile(path, '{"schema":"synthetic-measured-report"}', { mode: 0o600 });
  assert.equal((await assessCurrentEvidence(f.output, checkpoint, f.run.id)).verified, true);
  const currentSchedule = await retainedExplorationSchedule({ output: f.output, checkpoint,
    targets: [{ name: 'staging-live', surface: 'app' }],
    routedScreens: [{ name: 'Home', path: '/', surface: 'app' }] });
  assert.equal(currentSchedule.completed.length, 1, 'current unsealed evidence credits the completed goal');
  const alias = join(f.output, 'evidence', 'explore', 'synthetic-goal', 'alias.json');
  await link(path, alias);
  await assert.rejects(seal(f), /Retained staging evidence invalid/);
  await rm(alias);
  const sessionFile = join(f.output, 'evidence', 'explore', 'synthetic-goal', 'session.json');
  await writeFile(sessionFile, '{}', { mode: 0o600 });
  await assert.rejects(seal(f), /Retained staging evidence invalid/);
  await rm(sessionFile);
  const sealed = await seal(f);
  await rm(join(f.output, 'evidence'), { recursive: true });
  await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } });
  const restored = JSON.parse(await readFile(join(f.restored, 'controls.json'), 'utf8'));
  assert.equal((await verifyRetainedEvidence(f.restored, restored)).verified, true);
  const schedule = () => retainedExplorationSchedule({ output: f.restored, checkpoint: restored,
    targets: [{ name: 'staging-live', surface: 'app' }],
    routedScreens: [{ name: 'Home', path: '/', surface: 'app' }] });
  assert.equal((await schedule()).completed.length, 1);
  const restoredPath = join(f.restored, 'evidence', 'explore', 'synthetic-goal', 'report.json');
  await writeFile(restoredPath, '{"schema":"tampered"}');
  assert.equal((await verifyRetainedEvidence(f.restored, restored)).verified, false);
  assert.equal((await schedule()).pending.length, 2);
  await rm(restoredPath);
  assert.equal((await verifyRetainedEvidence(f.restored, restored)).verified, false);
  assert.equal((await schedule()).completed.length, 0);
  await writeFile(restoredPath, '{"schema":"synthetic-measured-report"}');
  const changed = { ...restored, expectedExplorations: 1 };
  assert.equal((await verifyRetainedEvidence(f.restored, changed)).verified, false);
});

test('attestation refuses an evidence path crossing a symlinked parent into private output', async t => {
  const f = await fixture(t);
  const privateDir = join(f.output, 'private');
  const evidenceDir = join(f.output, 'evidence');
  await mkdir(privateDir, { mode: 0o700 });
  await mkdir(evidenceDir, { mode: 0o700 });
  await writeFile(join(privateDir, 'proof.json'), '{"synthetic_private_canary":true}', { mode: 0o600 });
  await symlink(privateDir, join(evidenceDir, 'bridge'));
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.screens = [{ target: 'staging-live', path: '/', reached: true,
    controls: [{ evidence_path: join(evidenceDir, 'bridge', 'proof.json') }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  assert.equal((await assessCurrentEvidence(f.output, checkpoint, f.run.id)).verified, false);
  const rootAlias = join(f.root, 'source-alias');
  await symlink(f.output, rootAlias);
  assert.equal((await assessCurrentEvidence(rootAlias, checkpoint, f.run.id)).verified, false);
  await assert.rejects(seal(f), /Retained staging evidence invalid/);
  await rm(join(evidenceDir, 'bridge'));
  await symlink(join(privateDir, 'proof.json'), join(evidenceDir, 'proof.json'));
  checkpoint.screens[0].controls[0].evidence_path = join(evidenceDir, 'proof.json');
  assert.equal((await assessCurrentEvidence(f.output, checkpoint, f.run.id)).verified, false);
  checkpoint.screens[0].controls[0].evidence_path = join(privateDir, 'proof.json');
  assert.equal((await assessCurrentEvidence(f.output, checkpoint, f.run.id)).verified, false);
});

test('new measured goal after restore extends trusted schedule without replaying old goals', async t => {
  const f = await fixture(t);
  const one = join(f.output, 'evidence', 'explore', 'one');
  await mkdir(one, { recursive: true, mode: 0o700 });
  await writeFile(join(one, 'report.json'), '{}', { mode: 0o600 });
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.explorations = [{ target: 'staging-live', screen: 'Home', path: '/', agent: 'bug-hunter',
    steps: 1, status: 'finished', evidence: one }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  const sealed = await seal(f);
  await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } });
  const next = JSON.parse(await readFile(join(f.restored, 'controls.json'), 'utf8'));
  const two = join(f.restored, 'evidence', 'explore', 'two');
  await mkdir(two, { recursive: true, mode: 0o700 });
  await writeFile(join(two, 'report.json'), '{}', { mode: 0o600 });
  next.explorations.push({ target: 'staging-live', screen: 'Home', path: '/', agent: 'first-time-ux',
    steps: 1, status: 'finished', evidence: two });
  await writeFile(join(f.restored, 'controls.json'), JSON.stringify(next));
  const schedule = await retainedExplorationSchedule({ output: f.restored, checkpoint: next,
    targets: [{ name: 'staging-live', surface: 'app' }],
    routedScreens: [{ name: 'Home', path: '/', surface: 'app' }] });
  assert.equal(schedule.completed.length, 2);
  assert.equal(schedule.pending.length, 0);
  await writeFile(join(f.restored, 'evidence', 'explore', 'one', 'report.json'), '{"tampered":true}');
  assert.equal((await retainedExplorationSchedule({ output: f.restored, checkpoint: next,
    targets: [{ name: 'staging-live', surface: 'app' }],
    routedScreens: [{ name: 'Home', path: '/', surface: 'app' }] })).completed.length, 0);
});

test('incompressible retained evidence transfers within the cumulative byte cap', async t => {
  const limits = { ...RUN_LIMITS, artifactBytes: 80 * 1024 };
  const f = await fixture(t, limits);
  const evidence = join(f.output, 'evidence', 'screens');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const bytes = randomBytes(32 * 1024);
  await writeFile(join(evidence, 'frame.jpg'), bytes, { mode: 0o600 });
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.screens = [{ target: 'staging-live', path: '/', reached: true,
    controls: [{ evidence_path: join(evidence, 'frame.jpg') }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  const sealed = await seal(f);
  assert.ok((await stat(sealed.path)).size < 48 * 1024);
  assert.ok(directoryBytes(f.output) + (await stat(sealed.path)).size <= limits.artifactBytes);
  assert.ok(f.run.snapshot().artifactBytes <= limits.artifactBytes);
  await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: { ...sealed, sourcePair, runId: f.run.id, predecessor: null } });
  assert.deepEqual(await readFile(join(f.restored, 'evidence', 'screens', 'frame.jpg')), bytes);
});

test('an interrupted custody transfer recovers measured originals before resealing', async t => {
  const f = await fixture(t);
  const folder = join(f.output, 'evidence', 'screens');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const picture = join(folder, 'frame-a.jpg'), second = join(folder, 'frame-b.jpg'), bytes = randomBytes(4096);
  await writeFile(picture, bytes, { mode: 0o600 });
  await writeFile(second, bytes, { mode: 0o600 });
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.screens = [{ target: 'staging-live', path: '/', reached: true,
    controls: [{ evidence_path: folder }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  const original = await seal(f);
  const staged = join(f.root, `.continuation-${f.run.id}-1.tmp`);
  await copyFile(original.path, staged);
  const archive = await readFile(staged);
  await truncate(staged, 16 + archive.readUInt32BE(12) + bytes.length + 28);
  await rm(original.path);
  await writeFile(second, bytes, { mode: 0o600 });
  await assert.rejects(readFile(picture), { code: 'ENOENT' });
  const privateDir = join(f.output, 'private');
  await mkdir(privateDir, { mode: 0o700 });
  await rm(folder, { recursive: true });
  await symlink(privateDir, folder);
  await assert.rejects(seal(f), /Retained staging evidence invalid/);
  assert.deepEqual(await readdir(privateDir), []);
  await rm(folder);
  await mkdir(folder, { mode: 0o700 });
  await writeFile(second, bytes, { mode: 0o600 });
  const recovered = await seal(f);
  assert.equal(recovered.sha256.length, 64);
  await restoreContinuation({ envelopePath: recovered.path, destination: f.restored, secret,
    expected: { ...recovered, sourcePair, runId: f.run.id, predecessor: null } });
  assert.deepEqual(await readFile(join(f.restored, 'evidence', 'screens', 'frame-a.jpg')), bytes);
  assert.deepEqual(await readFile(join(f.restored, 'evidence', 'screens', 'frame-b.jpg')), bytes);
});

test('recovery retains its encrypted record until the restored name has a durable parent', async t => {
  const f = await fixture(t);
  const folder = join(f.output, 'evidence', 'screens'), path = join(folder, 'frame.jpg');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const bytes = randomBytes(4096);
  await writeFile(path, bytes, { mode: 0o600 });
  const controls = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  controls.screens = [{ reached: true, controls: [{ evidence_path: path }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(controls));
  const sealed = await seal(f), staged = join(f.root, `.continuation-${f.run.id}-1.tmp`);
  await copyFile(sealed.path, staged);
  const archived = await readFile(staged);
  await rm(sealed.path);
  const original = fsPromises.open;
  fsPromises.open = async (target, ...args) => {
    const handle = await original(target, ...args);
    if (target === folder) handle.sync = async () => { throw Object.assign(new Error('synthetic parent fsync interruption'), { code: 'EIO' }); };
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(seal(f), { code: 'EIO' }); }
  finally { fsPromises.open = original; syncBuiltinESMExports(); }
  assert.deepEqual(await readFile(staged), archived, 'encrypted record remains until its new name is durable');
  await rm(path, { force: true });
  const resealed = await seal(f);
  await restoreContinuation({ envelopePath: resealed.path, destination: f.restored, secret, expected: resealed });
  assert.deepEqual(await readFile(join(f.restored, 'evidence', 'screens', 'frame.jpg')), bytes);
});

test('four synthetic slots adopt exact prior ciphertext once and charge newly measured evidence', async t => {
  const limits = { ...RUN_LIMITS, artifactBytes: 80 * 1024 };
  const f = await fixture(t, limits);
  const folder = join(f.output, 'evidence', 'screens');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, 'frame.jpg'), randomBytes(32 * 1024), { mode: 0o600 });
  const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  checkpoint.screens = [{ target: 'staging-live', path: '/', reached: true,
    controls: [{ evidence_path: join(folder, 'frame.jpg') }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
  let sealed = await seal(f), priorCharge = f.run.snapshot().artifactBytes;
  for (let slot = 2; slot <= 4; slot++) {
    const output = join(f.root, `slot-${slot}`);
    const receipt = await restoreContinuation({ envelopePath: sealed.path, destination: output, secret,
      expected: sealed, adoptIncoming: { artifactId: String(slot - 1), digest: sealed.sha256,
        bytes: (await stat(sealed.path)).size } });
    assert.equal(receipt.adoption.inputConsumed, true);
    await assert.rejects(readFile(sealed.path), { code: 'ENOENT' });
    const run = openRun(output, { runId: f.run.id, events: null, limits, newInvocation: true });
    t.after(() => run.dispose());
    assert.equal(run.snapshot().artifactBytes, priorCharge);
    const newEvidence = join(output, 'evidence', 'screens', `new-${slot}.jpg`);
    await run.writeFile(newEvidence, Buffer.from([slot]), (path, data) => writeFile(path, data, { mode: 0o600 }));
    const current = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
    current.screens[0].controls.push({ evidence_path: newEvidence });
    const controlsPath = join(output, 'controls.json');
    await run.writeFile(controlsPath, JSON.stringify(current), (path, data) => writeFile(path, data, { mode: 0o600 }),
      { replaces: controlsPath });
    const destination = join(f.root, `sealed-${slot}.carr`);
    const beforeSeal = run.snapshot().artifactBytes;
    const next = await sealContinuation({ output, envelopePath: destination, secret, sourcePair,
      runId: f.run.id, generation: slot, predecessor: { generation: slot - 1, sha256: sealed.sha256 },
      run, adoption: receipt.adoption });
    assert.ok(next.accounting.changedEvidenceBytes >= 1);
    assert.equal(run.snapshot().artifactBytes - beforeSeal, next.accounting.framingBytes,
      'already metered evidence is not charged again and every generation pays its full framing');
    assert.equal(next.accounting.framingBytes, next.envelopeBytes - (32 * 1024 + slot - 1));
    assert.ok(run.snapshot().artifactBytes > priorCharge);
    assert.ok(run.snapshot().artifactBytes - priorCharge < (await stat(next.path)).size / 2);
    assert.ok(run.snapshot().artifactBytes <= limits.artifactBytes);
    await assert.rejects(sealContinuation({ output, envelopePath: join(f.root, `replay-${slot}.carr`), secret,
      sourcePair, runId: f.run.id, generation: slot, predecessor: { generation: slot - 1, sha256: sealed.sha256 },
      run, adoption: receipt.adoption }), { code: 'continuation-adoption-replayed' });
    sealed = next;
    priorCharge = run.snapshot().artifactBytes;
    if (slot === 4) {
      const ceiling = limits.artifactBytes - Math.min(limits.artifactMetadataBytes, Math.floor(limits.artifactBytes / 8));
      assert.throws(() => run.reserveBytes(ceiling - priorCharge + 1), { code: 'artifact-byte-limit' });
    }
  }
});

test('foreign, forked and replayed adoption cannot claim predecessor ciphertext', async t => {
  const f = await fixture(t);
  const sealed = await seal(f);
  const incomingBytes = (await stat(sealed.path)).size;
  assert.equal(sealed.chargedBytes, incomingBytes);
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: sealed, adoptIncoming: { artifactId: '1', digest: 'f'.repeat(64), bytes: incomingBytes } }),
  { code: 'continuation-adoption-binding-mismatch' });
  assert.equal((await stat(sealed.path)).size, incomingBytes);
  const receipt = await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: sealed, adoptIncoming: { artifactId: '1', digest: sealed.sha256, bytes: incomingBytes } });
  const run = openRun(f.restored, { runId: f.run.id, events: null, newInvocation: true });
  t.after(() => run.dispose());
  const call = (adoption, predecessor = { generation: 1, sha256: sealed.sha256 }) =>
    sealContinuation({ output: f.restored, envelopePath: join(f.root, 'successor.carr'), secret,
      sourcePair, runId: f.run.id, generation: 2, predecessor, run, adoption });
  await assert.rejects(call({ ...receipt.adoption }), { code: 'continuation-adoption-replayed' });
  await assert.rejects(call(receipt.adoption, { generation: 1, sha256: 'f'.repeat(64) }),
    { code: 'continuation-adoption-binding-mismatch' });
  const next = await call(receipt.adoption);
  assert.equal(next.generation, 2);
  await assert.rejects(call(receipt.adoption), { code: 'continuation-adoption-replayed' });
  assert.equal((await stat(next.path)).size, next.envelopeBytes);
});

test('unchanged carried payload pays the complete new framing without another content charge', async t => {
  const f = await fixture(t), path = join(f.output, 'evidence', 'frame.jpg');
  await mkdir(join(f.output, 'evidence'), { mode: 0o700 });
  await f.run.writeFile(path, Buffer.alloc(1024, 7), (destination, bytes) => writeFile(destination, bytes, { mode: 0o600 }));
  const controls = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
  controls.screens = [{ reached: true, controls: [{ evidence_path: path }] }];
  await writeFile(join(f.output, 'controls.json'), JSON.stringify(controls));
  const first = await seal(f);
  const restored = await restoreContinuation({ envelopePath: first.path, destination: f.restored, secret, expected: first,
    adoptIncoming: { artifactId: '1', digest: first.sha256, bytes: first.envelopeBytes } });
  const run = openRun(f.restored, { runId: f.run.id, events: null });
  t.after(() => run.dispose());
  const before = run.snapshot().artifactBytes;
  const next = await sealContinuation({ output: f.restored, envelopePath: join(f.root, 'next.carr'), secret,
    run, runId: run.id, sourcePair, generation: 2, predecessor: { generation: 1, sha256: first.sha256 }, adoption: restored.adoption });
  assert.equal(next.accounting.unmeteredEvidenceBytes, 0);
  assert.equal(next.accounting.framingBytes, next.envelopeBytes - 1024);
  assert.equal(run.snapshot().artifactBytes - before, next.accounting.framingBytes);
});

test('seal admits the exact logical ceiling and refuses one byte beyond it before transferring evidence', async t => {
  const limits = { ...RUN_LIMITS, artifactBytes: 80 * 1024 };
  const prepare = async () => {
    const f = await fixture(t, limits), path = join(f.output, 'evidence', 'frame.jpg');
    await mkdir(join(f.output, 'evidence'), { mode: 0o700 });
    const bytes = Buffer.alloc(1024, 9);
    await writeFile(path, bytes, { mode: 0o600 });
    const controls = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
    controls.screens = [{ reached: true, controls: [{ evidence_path: path }] }];
    await writeFile(join(f.output, 'controls.json'), JSON.stringify(controls));
    return { ...f, path, bytes };
  };
  const reference = await prepare();
  reference.run.reserveBytes(40000 - directoryBytes(reference.output, { excludeEvidence: true }));
  const framing = (await seal(reference)).accounting.framingBytes;
  const ceiling = limits.artifactBytes - Math.min(limits.artifactMetadataBytes, Math.floor(limits.artifactBytes / 8));
  for (const extra of [0, 1]) {
    const f = await prepare(), target = ceiling - framing - f.bytes.length + extra;
    f.run.reserveBytes(target - directoryBytes(f.output, { excludeEvidence: true }));
    assert.equal(f.run.snapshot().artifactBytes, target);
    if (extra) {
      await assert.rejects(seal(f), { code: 'artifact-byte-limit' });
      assert.deepEqual(await readFile(f.path), f.bytes);
      await assert.rejects(stat(join(f.root, 'resume.carr')), { code: 'ENOENT' });
      assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
    } else {
      const sealed = await seal(f);
      assert.equal(sealed.accounting.unmeteredEvidenceBytes, f.bytes.length);
      assert.equal(f.run.snapshot().artifactBytes, ceiling);
    }
  }
});

test('undercharged successor fails closed and retains exact prior ciphertext in custody', async t => {
  const f = await fixture(t);
  const sealed = await seal(f);
  const raw = await readFile(sealed.path);
  const receipt = await restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
    expected: sealed, adoptIncoming: { artifactId: '7', digest: sealed.sha256, bytes: raw.length } });
  const run = openRun(f.restored, { runId: f.run.id, events: null, newInvocation: true });
  t.after(() => run.dispose());
  const undercharged = { ...run, snapshot: () => ({ ...run.snapshot(), artifactBytes: 0 }) };
  await assert.rejects(sealContinuation({ output: f.restored, envelopePath: join(f.root, 'undercharged.carr'), secret,
    sourcePair, runId: f.run.id, generation: 2, predecessor: { generation: 1, sha256: sealed.sha256 },
    run: undercharged, adoption: receipt.adoption }), { code: 'continuation-budget-invalid' });
  const custody = (await readdir(f.root)).filter(name => name.startsWith('.adopted-'));
  assert.equal(custody.length, 1);
  const held = await readFile(join(f.root, custody[0]));
  assert.equal(held.subarray(0, 12).toString(), 'CARR-HOLD-2\0');
  assert.deepEqual(held.subarray(12), raw.subarray(12));
  for (const path of [join(f.root, custody[0]), join(f.root, 'copied-custody.carr')]) {
    if (path.endsWith('copied-custody.carr')) await copyFile(join(f.root, custody[0]), path);
    await assert.rejects(restoreContinuation({ envelopePath: path, destination: join(f.root, 'replayed-restore'), secret,
      expected: sealed, adoptIncoming: { artifactId: '8', digest: sealed.sha256, bytes: raw.length } }),
    { code: 'continuation-envelope-invalid' });
  }
  await assert.rejects(sealContinuation({ output: f.restored, envelopePath: join(f.root, 'retry.carr'), secret,
    sourcePair, runId: f.run.id, generation: 2, predecessor: { generation: 1, sha256: sealed.sha256 },
    run, adoption: receipt.adoption }), { code: 'continuation-adoption-replayed' });
});

test('failed incoming consumption returns no receipt and rolls back the published destination', async t => {
  const f = await fixture(t), sealed = await seal(f), raw = await readFile(sealed.path);
  const original = fsPromises.rename;
  fsPromises.rename = async (from, to) => {
    if (to.includes('/.adopted-')) throw Object.assign(new Error('synthetic consumption interruption'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret,
      expected: sealed, adoptIncoming: { artifactId: '7', digest: sealed.sha256, bytes: raw.length } }),
    { code: 'continuation-restore-failed' });
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
  await assert.rejects(stat(f.restored), { code: 'ENOENT' });
  const held = await readFile(sealed.path);
  assert.equal(held.subarray(0, 12).toString(), 'CARR-HOLD-2\0');
  assert.deepEqual(held.subarray(12), raw.subarray(12));
  await assert.rejects(restoreContinuation({ envelopePath: sealed.path, destination: f.restored, secret, expected: sealed }),
    { code: 'continuation-envelope-invalid' });
});

test('5,140 incompressible image-sized artifacts and new content fit four complete format slots',
  { skip: process.env.E2E_FULL_CORPUS_TEST !== '1', timeout: 300_000 }, async t => {
    const f = await fixture(t);
    const folder = join(f.output, 'evidence', 'screens');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 5140; index++)
      await writeFile(join(folder, `${String(index).padStart(5, '0')}.jpg`), randomBytes(40 * 1024), { mode: 0o600 });
    const checkpoint = JSON.parse(await readFile(join(f.output, 'controls.json'), 'utf8'));
    checkpoint.screens = [{ target: 'staging-live', path: '/', reached: true,
      controls: [{ evidence_path: folder }] }];
    await writeFile(join(f.output, 'controls.json'), JSON.stringify(checkpoint));
    let sealed = await seal(f);
    const envelopeBytes = (await stat(sealed.path)).size;
    const remainingBytes = directoryBytes(f.output), chargedBytes = f.run.snapshot().artifactBytes;
    console.log(JSON.stringify({ corpusBytes: 5140 * 40 * 1024, envelopeBytes, remainingBytes, chargedBytes,
      sealPeakLocalBytes: sealed.accounting.peakLocalBytes, sealPeakMemoryBytes: sealed.accounting.peakMemoryBytes }));
    assert.ok(envelopeBytes <= RUN_LIMITS.artifactBytes);
    assert.ok(remainingBytes + envelopeBytes <= RUN_LIMITS.artifactBytes);
    assert.ok(chargedBytes <= RUN_LIMITS.artifactBytes);
    for (let slot = 2; slot <= 4; slot++) {
      const output = join(f.root, `slot-${slot}`);
      const restored = await restoreContinuation({ envelopePath: sealed.path, destination: output, secret,
        expected: sealed, adoptIncoming: { artifactId: String(slot - 1), digest: sealed.sha256, bytes: sealed.envelopeBytes } });
      assert.ok(restored.peakLocalBytes <= 3 * RUN_LIMITS.artifactBytes);
      assert.ok(restored.peakMemoryBytes <= 6 * RUN_LIMITS.artifactBytes);
      assert.equal((await readdir(join(output, 'evidence', 'screens'))).length, 5140 + slot - 2);
      const run = openRun(output, { runId: f.run.id, events: null, newInvocation: true });
      t.after(() => run.dispose());
      const before = run.snapshot().artifactBytes;
      await run.writeFile(join(output, 'evidence', 'screens', `new-${slot}.jpg`), randomBytes(1024),
        (path, bytes) => writeFile(path, bytes, { mode: 0o600 }));
      assert.equal(run.snapshot().artifactBytes - before, 1024);
      const next = await sealContinuation({ output, envelopePath: join(f.root, `sealed-${slot}.carr`), secret,
        sourcePair, runId: run.id, generation: slot, predecessor: { generation: slot - 1, sha256: sealed.sha256 },
        run, adoption: restored.adoption });
      assert.equal(next.accounting.unmeteredEvidenceBytes, 0);
      assert.equal(run.snapshot().artifactBytes - before, 1024 + next.accounting.framingBytes);
      assert.ok(next.envelopeBytes <= RUN_LIMITS.artifactBytes);
      assert.ok(run.snapshot().artifactBytes <= RUN_LIMITS.artifactBytes);
      console.log(JSON.stringify({ slot, envelopeBytes: next.envelopeBytes, logicalBytes: run.snapshot().artifactBytes,
        framingBytes: next.accounting.framingBytes, peakLocalBytes: Math.max(restored.peakLocalBytes, next.accounting.peakLocalBytes),
        peakMemoryBytes: Math.max(restored.peakMemoryBytes, next.accounting.peakMemoryBytes) }));
      sealed = next;
    }
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
  const data = Buffer.from(await readFile(sealed.path));
  const headerLength = data.readUInt32BE(12);
  const header = JSON.parse(data.subarray(16, 16 + headerLength).toString('utf8'));
  header.ciphertext = (header.ciphertext[0] === 'A' ? 'B' : 'A') + header.ciphertext.slice(1);
  Buffer.from(JSON.stringify(header)).copy(data, 16);
  await writeFile(corrupted, data, { mode: 0o600 });
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
  await rm(linked);

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
