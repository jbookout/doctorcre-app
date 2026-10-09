import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { currentRun, artifactWriteIsAccounted, withAccountedArtifactWrite, artifactCopyBytes, RUN_LIMITS, RunLimitError } from './run-limits.mjs';

// SDK writers and detached browsers must obey the same run boundary as fixtures.
if (process.env.E2E_RUN_SUPERVISED === '1') {
  const root = resolve(process.env.E2E_V2_OUTPUT);
  const rawAppend = fs.appendFileSync;
  const needsAccounting = path => {
    if (artifactWriteIsAccounted()) return false;
    if (typeof path !== 'string' && !(path instanceof URL)) return false;
    const name = relative(root, resolve(path instanceof URL ? fileURLToPath(path) : path));
    if (name.startsWith('..') || isAbsolute(name)) return false;
    return name !== 'run-budget.json' && !/^run-budget\.json\.\d+\.tmp$/.test(name);
  };
  const account = (path, data) => {
    if (!needsAccounting(path)) return;
    if (typeof data !== 'string' && !ArrayBuffer.isView(data)) throw new RunLimitError('artifact-size-unavailable');
    currentRun().reserveBytes(Buffer.byteLength(data));
  };
  const accountCopy = (source, destination) => {
    if (!needsAccounting(destination)) return false;
    currentRun().reserveBytes(artifactCopyBytes(source));
    return true;
  };
  for (const method of ['copyFileSync', 'cpSync']) {
    const original = fs[method];
    fs[method] = function (source, destination, ...args) {
      const accounted = accountCopy(source, destination);
      const copy = () => original.call(this, source, destination, ...args);
      return accounted ? withAccountedArtifactWrite(copy) : copy();
    };
  }
  for (const method of ['copyFile', 'cp']) {
    const original = promises[method];
    promises[method] = async function (source, destination, ...args) {
      const accounted = accountCopy(source, destination);
      const copy = () => original.call(this, source, destination, ...args);
      return accounted ? withAccountedArtifactWrite(copy) : copy();
    };
    const callbackCopy = fs[method];
    fs[method] = function (source, destination, ...args) {
      let accounted;
      try { accounted = accountCopy(source, destination); }
      catch (error) { const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; } throw error; }
      const copy = () => callbackCopy.call(this, source, destination, ...args);
      return accounted ? withAccountedArtifactWrite(copy) : copy();
    };
  }
  for (const method of ['writeFileSync', 'appendFileSync']) {
    const original = fs[method];
    fs[method] = function (path, data, ...args) { account(path, data); return original.call(this, path, data, ...args); };
  }
  for (const method of ['writeFile', 'appendFile']) {
    const original = promises[method];
    promises[method] = async function (path, data, ...args) { account(path, data); return original.call(this, path, data, ...args); };
  }
  for (const method of ['writeFile', 'appendFile']) {
    const original = fs[method];
    fs[method] = function (path, data, ...args) {
      try { account(path, data); }
      catch (error) { const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return; } throw error; }
      return original.call(this, path, data, ...args);
    };
  }
  const stream = fs.createWriteStream;
  fs.createWriteStream = function (path, ...args) {
    const writer = stream.call(this, path, ...args), write = writer._write, writev = writer._writev;
    writer._write = function (data, encoding, callback) {
      try { account(path, data); } catch (error) { callback(error); return; }
      return write.call(this, data, encoding, callback);
    };
    if (writev) writer._writev = function (chunks, callback) {
      try { account(path, Buffer.concat(chunks.map(chunk => Buffer.from(chunk.chunk)))); }
      catch (error) { callback(error); return; }
      return writev.call(this, chunks, callback);
    };
    return writer;
  };
  const spawn = childProcess.spawn;

  process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});
  childProcess.spawn = function (...args) {
    const options = Array.isArray(args[1]) ? args[2] : args[1];
    const inspect = pid => {
      const result = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: RUN_LIMITS.dispatcherGraceMs });
      if (result.error || result.status !== 0 || !result.stdout?.trim()) throw new RunLimitError('process-inspection-unavailable');
      return result.stdout.trim();
    };
    if (options?.detached) inspect(process.pid);
    const release = options?.detached ? currentRun().reserveProcessGroup() : null;
    let child, ack;
    if (options?.detached) {
      if (options.shell) { release?.(); throw new RunLimitError('process-shell-refused'); }
      const stdio = Array.isArray(options.stdio) ? [...options.stdio] : Array(3).fill(options.stdio || 'pipe');
      ack = stdio.length; stdio.push('pipe');
      const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
      args = ['python3', [fileURLToPath(new URL('./launch-worker.py', import.meta.url)), String(ack), String(currentRun().limits.launchTimeoutMs), JSON.stringify(command)], { ...options, detached: false, stdio }];
    }
    try { child = spawn.apply(this, args); } catch (error) { release?.(); throw error; }
    child.once('error', () => { if (!child.pid) release?.(); });
    if (child.pid && options?.detached) {
      const record = row => rawAppend(process.env.E2E_PROCESS_REGISTRY, JSON.stringify(row) + '\n', { mode: 0o600 });
      try {
        record({ pid: child.pid, birth: inspect(child.pid) });
        currentRun().check();
        child.stdio[ack].end('1');
        // Leader close is not proof that its process group is empty.
        child.once('close', () => {
          const deadline = Date.now() + RUN_LIMITS.stopGraceMs + RUN_LIMITS.cleanupVerifyMs;
          const retire = () => {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') { try { record({ pid: child.pid, retired: true }); release?.(); } catch {} return; }
              // macOS reports EPERM for a group whose leader is an unreaped zombie: still present, so keep polling.
              if (error.code !== 'EPERM') return;
            }
            if (Date.now() < deadline) setTimeout(retire, RUN_LIMITS.monitorIntervalMs).unref();
          };
          retire();
        });
      } catch (error) {
        try { child.kill('SIGKILL'); process.kill(-child.pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw new RunLimitError('process-cleanup-unverified'); }
        const deadline = Date.now() + RUN_LIMITS.cleanupVerifyMs;
        for (;;) {
          try { process.kill(child.pid, 0); }
          catch (failure) { if (failure.code === 'ESRCH') { release?.(); break; } throw new RunLimitError('process-cleanup-unverified'); }
          if (Date.now() >= deadline) throw new RunLimitError('process-cleanup-unverified');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        throw error;
      }
    }
    return child;
  };
  syncBuiltinESMExports();
}
