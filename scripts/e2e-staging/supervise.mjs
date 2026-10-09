import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeSync, readSync, fstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRun, RUN_LIMITS, RunLimitError } from './run-limits.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));

// macOS answers EPERM, not ESRCH, for a signal sent to a zombie that its parent has not yet
// reaped (and to a group whose leader is such a zombie). The entry still exists, so it counts
// as alive until the kernel drops it; the cleanup loop then verifies it actually disappears.
function probe(target) {
  try { process.kill(target, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

const groupAlive = pid => probe(-pid);
const pidAlive = pid => probe(pid);

// A refused signal leaves the target's liveness to the verification loop, which fails closed.
function signalTarget(target, signal) {
  try { process.kill(target, signal); }
  catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
}

const ownedAlive = pid => pidAlive(pid) || groupAlive(pid);

function processBirths(pids, timeout) {
  if (!pids.length) return new Map();
  const result = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=', '-o', 'lstart='], { encoding: 'utf8', timeout });
  if (result.error || ![0, 1].includes(result.status)) throw new RunLimitError('process-cleanup-unverified');
  const births = new Map();
  for (const line of (result.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new RunLimitError('process-cleanup-unverified');
    births.set(Number(match[1]), match[2]);
  }
  return births;
}

export async function supervise({ command, args = [], output, environment = process.env, limits = RUN_LIMITS, events = process }) {
  const run = openRun(output, { limits, runId: environment.E2E_RUN_ID, events: null });
  const leasePath = join(run.root, '.run-owner');
  const registry = join(run.root, 'owned-process-groups-' + randomUUID() + '.jsonl');
  const groups = new Map();
  let lease, log, child, monitor, deadline, hardTimer, killDeadline, cleanupPromise, resolveExit, rejectStopped;
  let journalOffset = 0, journalTail = '', closed = false, workerCode, workerError;
  let reason = null, ownershipUnverified = false;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // A stop can arrive during synchronous setup, before the race below attaches.
  void stopped.catch(() => {});

  const retire = pid => {
    if (!ownedAlive(pid)) groups.delete(pid);
  };
  const refreshGroups = () => {
    let handle;
    try { handle = openSync(registry, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let invalid = false;
    try {
      const remaining = fstatSync(handle).size - journalOffset;
      if (remaining < 0 || remaining > limits.dispatcherOutputBytes) throw new RunLimitError('process-ownership-invalid');
      const data = Buffer.alloc(remaining);
      const size = readSync(handle, data, 0, remaining, journalOffset);
      journalOffset += size;
      const rows = (journalTail + data.subarray(0, size).toString('utf8')).split('\n');
      journalTail = rows.pop();
      for (const line of rows) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { invalid = true; continue; }
        if (!Number.isSafeInteger(row.pid) || row.pid <= 1 ||
            row.retired !== true && (typeof row.birth !== 'string' || !row.birth.trim())) {
          invalid = true; continue;
        }
        if (row.retired === true) retire(row.pid);
        else groups.set(row.pid, row.birth.trim());
      }
    } finally { closeSync(handle); }
    // Corrupt ownership evidence is consumed once read, so remember it for the cleanup verdict.
    if (invalid) { ownershipUnverified = true; throw new RunLimitError('process-ownership-invalid'); }
    if (groups.size > limits.processGroups) throw new RunLimitError('process-group-limit');
  };
  const refreshForCleanup = () => {
    try { refreshGroups(); }
    catch { ownershipUnverified = true; }
  };
  const signalGroups = signal => {
    refreshForCleanup();
    const active = [];
    for (const pid of groups.keys()) {
      try { if (ownedAlive(pid)) active.push(pid); else groups.delete(pid); }
      catch { ownershipUnverified = true; }
    }
    let births;
    try { births = processBirths(active, limits.dispatcherGraceMs); }
    catch { ownershipUnverified = true; births = null; }
    for (const pid of active) {
      const expected = groups.get(pid), current = births?.get(pid);
      const ownedWorker = pid === child?.pid && !closed;
      if (!expected && !ownedWorker) { ownershipUnverified = true; continue; }
      if (current && expected && expected !== current) { groups.delete(pid); continue; }
      if (!births && !ownedWorker) continue;
      try {
        // A launch-gated wrapper can be registered before setsid creates its group.
        if (pidAlive(pid)) {
          if (!current && !ownedWorker) { ownershipUnverified = true; continue; }
          signalTarget(pid, signal);
        }
        if (groupAlive(pid)) {
          signalTarget(-pid, signal);
        }
        retire(pid);
      } catch { ownershipUnverified = true; }
    }
  };
  const hardKill = () => {
    if (killDeadline !== undefined) return;
    killDeadline = Date.now() + limits.cleanupVerifyMs;
    signalGroups('SIGKILL');
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      hardTimer ||= setTimeout(hardKill, limits.stopGraceMs);
      signalGroups('SIGTERM');
      await pause(limits.stopGraceMs);
      hardKill();
      for (;;) {
        refreshForCleanup();
        for (const pid of groups.keys()) {
          try { retire(pid); } catch { ownershipUnverified = true; }
        }
        if (!groups.size && closed) break;
        if (Date.now() >= killDeadline) throw new RunLimitError('process-cleanup-unverified');
        await pause(10);
      }
      if (journalTail || ownershipUnverified) throw new RunLimitError('process-cleanup-unverified');
      run.releaseProcessGroups();
    })();
    return cleanupPromise;
  };
  const stop = code => {
    if (reason) return;
    reason = code;
    hardTimer = setTimeout(hardKill, limits.stopGraceMs);
    try { run.stop(code); } catch (error) { reason = error.code || 'run-stop-record-failed'; }
    void cleanup().then(() => rejectStopped(new RunLimitError(reason)), rejectStopped);
  };
  const interrupt = () => stop('stop-signal');
  try {
    lease = openSync(leasePath, 'wx', 0o600);
    writeSync(lease, String(process.pid));
    log = openSync(join(run.root, 'run.log'), 'a', 0o600);
    events.on('SIGINT', interrupt); events.on('SIGTERM', interrupt);
    deadline = setTimeout(() => stop('whole-run-deadline'), Math.max(1, run.deadline - Date.now()));
    run.checkArtifacts();
    try {
      if (!processBirths([process.pid], limits.dispatcherGraceMs).has(process.pid)) throw new Error('Missing supervisor identity');
    } catch { throw new RunLimitError('process-inspection-unavailable'); }
    child = spawn(command, args, {
      cwd: project, detached: true,
      env: { ...environment, E2E_RUN_ID: run.id, E2E_RUN_LIMITS: JSON.stringify(limits), E2E_V2_OUTPUT: run.root,
        E2E_RUN_SUPERVISED: '1', E2E_PROCESS_REGISTRY: registry,
        NODE_OPTIONS: `${environment.NODE_OPTIONS || ''} --import=${fileURLToPath(new URL('./preload.mjs', import.meta.url))}`.trim() },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.once('error', error => { workerError = error; });
    child.once('exit', code => { workerCode = code; resolveExit(); });
    child.once('close', () => { closed = true; resolveExit(); });
    if (child.pid) {
      // The live ChildProcess handle establishes ownership even if inspection fails.
      groups.set(child.pid, null);
      const birth = processBirths([child.pid], limits.dispatcherGraceMs).get(child.pid);
      if (!birth) throw new RunLimitError('process-ownership-invalid');
      groups.set(child.pid, birth);
    }
    child.on('message', row => {
      try {
        if (row?.type === 'staging-dispatcher-exit' && Number.isSafeInteger(row.pid) && row.pid > 1) retire(row.pid);
      } catch { stop('process-cleanup-unverified'); }
    });
    const record = chunk => {
      if (reason) return;
      try { run.reserveBytes(chunk.length); writeSync(log, chunk); }
      catch (error) { stop(error.code || 'log-write-failed'); }
    };
    child.stdout.on('data', record); child.stderr.on('data', record);
    monitor = setInterval(() => {
      try { refreshGroups(); run.checkArtifacts(); }
      catch (error) { stop(error.code || 'run-monitor-failed'); }
    }, limits.monitorIntervalMs);
    await Promise.race([exited, stopped]);
    clearInterval(monitor);
    await cleanup();
    if (reason) throw new RunLimitError(reason);
    if (workerError) throw new RunLimitError('worker-spawn-failed');
    if (workerCode !== 0) throw new RunLimitError('worker-exit-' + workerCode);
    run.checkArtifacts();
    return run.snapshot();
  } finally {
    clearInterval(monitor); clearTimeout(deadline);
    try { if (child) await cleanup(); }
    finally {
      clearTimeout(hardTimer);
      events.off('SIGINT', interrupt); events.off('SIGTERM', interrupt);
      if (log !== undefined) closeSync(log);
      if (lease !== undefined) { closeSync(lease); unlinkSync(leasePath); }
      run.dispose();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const output = resolve(process.env.E2E_V2_OUTPUT || join(project, '.e2e', 'bounded-run'));
  const args = mode === 'explore' ? ['scripts/e2e-staging/explore.mjs'] :
    mode === 'sweep' ? ['node_modules/playwright/cli.js', 'test', '--config', 'playwright.staging.config.mjs'] : null;
  if (!args) throw new Error('Choose staging supervisor mode sweep or explore');
  supervise({ command: process.execPath, args, output }).then(state => console.log(`Staging run ${state.id} completed inside finite limits`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
