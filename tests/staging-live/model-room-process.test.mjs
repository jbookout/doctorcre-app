import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for synthetic dispatcher state');
};

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

test('abort terminates a SIGTERM-resistant dispatcher process group and awaits every descendant exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-model-room-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidsPath = join(root, 'pids.json');
  const dispatcher = fileURLToPath(new URL('./sigterm-resistant-dispatcher.py', import.meta.url));

  const controller = new AbortController();
  let pids;
  try {
    const { dispatchThroughModelRoom } = await import('../../scripts/e2e-staging/model-room.mjs');
    const result = dispatchThroughModelRoom({
      desk: 'doctorcre-e2e',
      task: 'synthetic task',
      fresh: true,
      signal: controller.signal,
      dispatcherPath: dispatcher,
      environment: { ...process.env, SYNTHETIC_PROCESS_STATE: pidsPath },
    });
    let earlyFailure;
    result.catch(error => { earlyFailure = error; });
    await waitFor(async () => {
      if (earlyFailure) throw earlyFailure;
      try { pids = JSON.parse(await readFile(pidsPath, 'utf8')); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    assert.deepEqual(pids.argv, ['send', 'doctorcre-e2e', '-', '--fresh']);
    controller.abort();
    await assert.rejects(result, /aborted/);
    await waitFor(() => !alive(pids.dispatcher) && !alive(pids.grandchild));
    assert.equal(alive(pids.dispatcher), false);
    assert.equal(alive(pids.grandchild), false);
  } finally {
    for (const pid of [pids?.grandchild, pids?.dispatcher]) {
      if (!pid || !alive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});
