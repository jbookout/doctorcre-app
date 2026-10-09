import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

test('cancellation kills the direct dispatcher before its group exists', async () => {
  const dispatcher = new URL('./sigterm-resistant-dispatcher.py', import.meta.url).pathname;
  const controller = new AbortController();
  const spawn = childProcess.spawn, kill = process.kill;
  let directAlive = true, groupAlive = false, killed = false, detached;
  const child = new EventEmitter(); child.pid = 999999;
  child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  childProcess.spawn = () => {
    detached = setTimeout(() => { if (directAlive) groupAlive = true; }, 20);
    controller.abort();
    return child;
  };
  process.kill = (pid, signal) => {
    if (pid < 0 ? !groupAlive : !directAlive) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    if (signal !== 0) { directAlive = false; groupAlive = false; killed = true; }
    return true;
  };
  syncBuiltinESMExports();
  try {
    const { dispatchThroughModelRoom, MODEL_ROOM_DISPATCH_CONTRACT } = await import('../../scripts/e2e-staging/model-room.mjs');
    const run = { id: 'synthetic-launch-run', signal: new AbortController().signal, check() {}, reserveModel() {}, reserveBytes() {} };
    await assert.rejects(dispatchThroughModelRoom({ desk: 'doctorcre-e2e', task: 'synthetic', fresh: true,
      signal: controller.signal, run, environment: { E2E_RUN_ID: run.id, E2E_ALLOW_MODEL_CALLS: run.id },
      dispatcherPath: dispatcher, dispatcherContract: { ...MODEL_ROOM_DISPATCH_CONTRACT,
        sha256: createHash('sha256').update(await readFile(dispatcher)).digest('hex') },
    }), /aborted/);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(groupAlive, false, 'cleanup must not permit a later setsid');
    assert.equal(directAlive, false);
    assert.equal(killed, true);
  } finally { clearTimeout(detached); childProcess.spawn = spawn; process.kill = kill; syncBuiltinESMExports(); }
});
