import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { supervise } from '../../scripts/e2e-staging/supervise.mjs';

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
