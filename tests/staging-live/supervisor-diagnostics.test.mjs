import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { supervise, createWorkerDiagnosticReader } from '../../scripts/e2e-staging/supervise.mjs';
import { businessWorkerFailureCode, retainedBusinessWorkerCause } from '../../scripts/e2e-staging/continue-run.mjs';
import { formatWorkerFailureDiagnostic, markOwnFailureCode, parseWorkerFailureDiagnostic } from '../../scripts/e2e-staging/worker-diagnostics.mjs';

const safeSource = fileURLToPath(new URL('../../scripts/e2e-staging/session.mjs', import.meta.url));

async function runFailingWorker(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-supervisor-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failure;
  try {
    await supervise({
      command: process.execPath,
      args: ['-e', source],
      output: join(root, 'output'),
      environment: { PATH: process.env.PATH, HOME: root },
    });
  } catch (error) { failure = error; }
  assert.ok(failure, 'synthetic worker exits unsuccessfully');
  const log = await readFile(join(root, 'output', 'run.log'), 'utf8');
  return { failure, log };
}

test('worker startup diagnostics expose allowlisted cause and stack location, never canaries', async t => {
  const secretCanary = 'SYNTHETIC_SESSION_CANARY_7f9d2e';
  const worker = [
    `process.stdout.write(${JSON.stringify(`raw stdout ${secretCanary}\n`)});`,
    `process.stderr.write(${JSON.stringify(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${secretCanary}'\n    at loadSession (file://${safeSource}:43:7)\nraw stderr ${secretCanary}\n`)});`,
    'process.exitCode = 1;',
  ].join('\n');
  const { failure, log } = await runFailingWorker(t, worker);

  assert.equal(failure.code, 'worker-exit-1');
  assert.match(failure.message, /cause=node-module-resolution-failed/);
  assert.match(failure.message, /location=scripts\/e2e-staging\/session\.mjs:43:7/);
  assert.match(log, /worker-diagnostic cause=node-module-resolution-failed/);
  assert.match(log, /worker-diagnostic location=scripts\/e2e-staging\/session\.mjs:43:7/);
  assert.doesNotMatch(failure.message, new RegExp(secretCanary));
  assert.doesNotMatch(log, new RegExp(secretCanary));
});

test('session preflight diagnostics expose only the closed failure code', async t => {
  const secretCanary = 'SYNTHETIC_SESSION_EXCHANGE_CANARY_4cd21b';
  const worker = [
    `process.stderr.write(${JSON.stringify(`Error: staging session preflight failed: session-exchange-refused-401\n${secretCanary}\n`)});`,
    'process.exitCode = 1;',
  ].join('\n');
  const { failure, log } = await runFailingWorker(t, worker);

  assert.equal(failure.code, 'worker-exit-1');
  assert.match(failure.message, /cause=session-exchange-refused-401/);
  assert.doesNotMatch(failure.message, new RegExp(secretCanary));
  assert.doesNotMatch(log, new RegExp(secretCanary));
});

test('unknown worker exceptions remain unreported and raw streams are not packaged', async t => {
  const secretCanary = 'SYNTHETIC_UNKNOWN_CANARY_b84a31';
  const worker = [
    `process.stdout.write(${JSON.stringify(`unknown stdout ${secretCanary}\n`)});`,
    `process.stderr.write(${JSON.stringify(`Error: unknown synthetic failure ${secretCanary}\n    at unsafe (file:///tmp/${secretCanary}.mjs:9:2)\n`)});`,
    'process.exitCode = 1;',
  ].join('\n');
  const { failure, log } = await runFailingWorker(t, worker);

  assert.equal(failure.code, 'worker-exit-1');
  assert.equal(failure.message, 'Staging run stopped: worker-exit-1');
  assert.doesNotMatch(log, /worker-diagnostic/);
  assert.doesNotMatch(log, new RegExp(secretCanary));
});

test('unclassified TypeError retains one bounded secret-free frame diagnostic', async t => {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const secretCanary = 'SYNTHETIC_UNCLASSIFIED_SECRET_a821';
  const failure = new TypeError(`private message ${secretCanary}`);
  failure.code = 'unexpected-worker-failure';
  markOwnFailureCode(failure, failure.code);
  failure.stack = `TypeError: ${failure.message}\n    at run (file://${safeSource}:91:4)`;
  const diagnostic = formatWorkerFailureDiagnostic(failure, projectRoot);
  assert.match(diagnostic,
    /^Staging worker failure name=TypeError code=unexpected-worker-failure frame=scripts\/e2e-staging\/session\.mjs:91$/);
  assert.ok(Buffer.byteLength(diagnostic) <= 320);
  assert.doesNotMatch(diagnostic, /private message|SYNTHETIC_UNCLASSIFIED_SECRET_a821/);

  const worker = [
    `process.stderr.write(${JSON.stringify(`${diagnostic}\n`)});`,
    'process.exitCode = 1;',
  ].join('\n');
  const { failure: stopped, log } = await runFailingWorker(t, worker);
  assert.equal(stopped.code, 'worker-exit-1');
  assert.ok(log.includes(`worker-diagnostic ${diagnostic}`));
  assert.doesNotMatch(stopped.message, /private message|SYNTHETIC_UNCLASSIFIED_SECRET_a821/);
  assert.doesNotMatch(log, /private message|SYNTHETIC_UNCLASSIFIED_SECRET_a821/);
});

test('worker diagnostics include only a code this harness attached', () => {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const invalid = new Error('private message');
  invalid.code = 'Private-Provider-Code';
  assert.equal(formatWorkerFailureDiagnostic(invalid, projectRoot),
    'Staging worker failure name=Error code=none frame=none');
  const lexicalSecret = new Error('private message');
  lexicalSecret.code = 'secretvalue123';
  assert.equal(formatWorkerFailureDiagnostic(lexicalSecret, projectRoot),
    'Staging worker failure name=Error code=none frame=none');
  const own = markOwnFailureCode(new Error('private message'), 'journal-directory-unsafe');
  own.code = 'journal-directory-unsafe';
  assert.equal(formatWorkerFailureDiagnostic(own, projectRoot),
    'Staging worker failure name=Error code=journal-directory-unsafe frame=none');
  own.code = 'secretvalue123';
  assert.equal(formatWorkerFailureDiagnostic(own, projectRoot),
    'Staging worker failure name=Error code=journal-directory-unsafe frame=none');
  class SecretTokenabc123 extends Error {}
  assert.equal(formatWorkerFailureDiagnostic(new SecretTokenabc123('x'), projectRoot),
    'Staging worker failure name=Error code=none frame=none');
  assert.equal(parseWorkerFailureDiagnostic('Staging worker failure name=SecretTokenabc123 code=none frame=none'), null);
  const trap = new Proxy({}, { get(_target, key) {
    return typeof key === 'symbol' || key === 'code' ? 'secretvalue123' : undefined;
  } });
  assert.equal(formatWorkerFailureDiagnostic(trap, projectRoot),
    'Staging worker failure name=Error code=none frame=none');
  const forged = { stack: `Error: x\n    at request (file://${projectRoot}scripts/e2e-staging/secretvalue123.mjs:43:7)` };
  assert.equal(formatWorkerFailureDiagnostic(forged, projectRoot),
    'Staging worker failure name=Object code=none frame=none');
  assert.equal(parseWorkerFailureDiagnostic(
    'Staging worker failure name=Error code=none frame=scripts/e2e-staging/secretvalue123.mjs:43'), null);
  assert.ok(parseWorkerFailureDiagnostic(
    'Staging worker failure name=Error code=none frame=scripts/e2e-staging/session.mjs:43'));
  const inherited = Object.assign(Object.create({ code: 'hidden-secret' }), { stack: 'Error: private' });
  assert.equal(formatWorkerFailureDiagnostic(inherited, projectRoot),
    'Staging worker failure name=Object code=none frame=none');
});

test('business readback failure crosses worker diagnostic seam only as a closed code', () => {
  assert.equal(businessWorkerFailureCode({ code: 'write-coverage-incomplete' }), 'business-journey-readback-incomplete');
  assert.equal(businessWorkerFailureCode({ message: 'Business journey coverage incomplete; reconciliation required' }),
    'business-journey-readback-incomplete');
  assert.equal(businessWorkerFailureCode({ code: 'secret-value', message: 'private row' }), null);
  const secretCanary = 'SYNTHETIC_BUSINESS_CANARY_83d47e';
  const diagnostics = [];
  const read = createWorkerDiagnosticReader(value => diagnostics.push(value));
  read(Buffer.from('Staging continuation stopped: business-journey-readback-incomplete; no full V1 acceptance is established.\n'));
  read(Buffer.from(`${secretCanary}\n`));
  assert.deepEqual(diagnostics, ['cause=business-journey-readback-incomplete']);
  const failure = { code: 'worker-exit-1',
    message: `Staging run stopped: worker-exit-1 (${diagnostics.join('; ')})` };
  assert.equal(retainedBusinessWorkerCause(failure), 'business-journey-readback-incomplete');
  assert.equal(retainedBusinessWorkerCause({ code: 'worker-exit-1',
    message: 'Staging run stopped: worker-exit-1 (cause=unknown)' }), null);
  assert.doesNotMatch(failure.message, new RegExp(secretCanary));
  assert.doesNotMatch(diagnostics.join('; '), new RegExp(secretCanary));
});

test('presence settlement and cleanup failures survive as separate fixed diagnostics', () => {
  assert.equal(businessWorkerFailureCode({ code: 'presence-settlement-timeout', message: 'provider detail' }),
    'presence-settlement-timeout');
  const diagnostics = [];
  const read = createWorkerDiagnosticReader(value => diagnostics.push(value));
  read(Buffer.from('Staging continuation stopped: presence-settlement-timeout; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging cleanup stopped: write-coverage-incomplete.\n'));
  read(Buffer.from('Staging cleanup stopped: provider-secret.\n'));
  assert.deepEqual(diagnostics, ['cause=presence-settlement-timeout', 'cleanup=write-coverage-incomplete']);
});

test('startup and fixture refusal diagnostics expose only exact closed codes', () => {
  const diagnostics = [];
  const read = createWorkerDiagnosticReader(value => diagnostics.push(value));
  read(Buffer.from('Staging continuation stopped: canary-shell-script-failed; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-candidate-refused; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-rpc-unresolved; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-stage-prerequisite; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-taxonomy-prerequisite; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-category-prerequisite; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-rpc-unresolved; provider=private-canary; no full V1 acceptance is established.\n'));
  read(Buffer.from('Staging continuation stopped: staging-fixture-candidate-refused; candidate=private name; no full V1 acceptance is established.\n'));
  assert.deepEqual(diagnostics, ['cause=canary-shell-script-failed', 'cause=staging-fixture-candidate-refused',
    'cause=staging-fixture-rpc-unresolved', 'cause=staging-fixture-stage-prerequisite',
    'cause=staging-fixture-taxonomy-prerequisite', 'cause=staging-fixture-category-prerequisite']);
});
