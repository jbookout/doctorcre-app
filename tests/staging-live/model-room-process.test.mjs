import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
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

const syntheticContract = async path => {
  const { MODEL_ROOM_DISPATCH_CONTRACT } = await import('../../scripts/e2e-staging/model-room.mjs');
  return { ...MODEL_ROOM_DISPATCH_CONTRACT, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
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
      dispatcherContract: await syntheticContract(dispatcher),
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

test('normal exploration SIGTERM aborts the active dispatcher process group', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-model-room-sigterm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidsPath = join(root, 'pids.json');
  const dispatcher = fileURLToPath(new URL('./sigterm-resistant-dispatcher.py', import.meta.url));
  const events = new EventEmitter();
  const { createExplorationRunSignals } = await import('../../scripts/e2e-staging/explore.mjs');
  const { dispatchThroughModelRoom } = await import('../../scripts/e2e-staging/model-room.mjs');
  const signals = createExplorationRunSignals(events);
  t.after(() => signals.dispose());
  let pids;
  try {
    const result = dispatchThroughModelRoom({
      desk: 'doctorcre-e2e', task: 'synthetic task', fresh: true,
      signal: signals.interruptSignal, dispatcherPath: dispatcher,
      dispatcherContract: await syntheticContract(dispatcher),
      environment: { ...process.env, SYNTHETIC_PROCESS_STATE: pidsPath },
    });
    await waitFor(async () => {
      try { pids = JSON.parse(await readFile(pidsPath, 'utf8')); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    events.emit('SIGTERM');
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

test('a shape-compatible but unpinned dispatcher is refused before execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-model-room-unpinned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dispatcher = join(root, 'compatible.py');
  await writeFile(dispatcher, `import json,sys\ntask=sys.stdin.read()\nprint(json.dumps({"msg_id":"synthetic","desk":"doctorcre-e2e","kind":"codex-session","task":task,"dispatched_at":"2026-10-08T12:00:00Z","status":"completed","result":"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"{}\\"}]}"}))\n`);
  const { dispatchThroughModelRoom } = await import('../../scripts/e2e-staging/model-room.mjs');
  await assert.rejects(dispatchThroughModelRoom({
    desk: 'doctorcre-e2e', task: 'synthetic task', fresh: true, dispatcherPath: dispatcher,
  }), /does not match the pinned Model Room dispatcher/);
});
