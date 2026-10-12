import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';

const wrapper = fileURLToPath(new URL('../../scripts/e2e-staging/launch-worker.py', import.meta.url));
function launch(t, timeout = RUN_LIMITS.launchTimeoutMs) {
  const command = ['python3', '-c', 'import os,json,time;print(json.dumps({"pid":os.getpid(),"group":os.getpgrp()}),flush=True);time.sleep(30)'];
  const child = spawn('python3', [wrapper, '3', String(timeout), JSON.stringify(command)], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} child.kill('SIGKILL'); await closed; });
  return { child, closed };
}

test('launch gate never detaches or executes until ownership is acknowledged', { timeout: 4_000 }, async t => {
  const { child, closed } = launch(t);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(output, '');
  const ready = once(child.stdout, 'data');
  child.stdio[3].end('1');
  const [data] = await ready;
  const identity = JSON.parse(String(data));
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.group, child.pid);
  process.kill(-child.pid, 'SIGKILL');
  await closed;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

for (const mode of ['eof', 'timeout', 'stop']) test(`launch gate ${mode} ends the waiting child without executing work`, { timeout: 4_000 }, async t => {
  const { child, closed } = launch(t, 100);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  if (mode === 'eof') child.stdio[3].end();
  if (mode === 'stop') child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(output, '');
  if (mode === 'stop') assert.equal(signal, 'SIGTERM'); else assert.equal(code, 125);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
