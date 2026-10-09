import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

const artifactWrites = new AsyncLocalStorage();
export const artifactWriteIsAccounted = () => artifactWrites.getStore() === true;
export const withAccountedArtifactWrite = operation => artifactWrites.run(true, operation);

export const RUN_LIMITS = Object.freeze({
  workers: 1,
  // Fits routed screen loads and Calendar cases; larger dynamic frontiers resume explicitly.
  httpRequests: 20_000,
  httpConcurrency: 2,
  httpQueue: 32,
  processGroups: 8,
  cleanupVerifyMs: 1_000,
  launchTimeoutMs: 2_000,
  artifactMetadataBytes: 16_384,
  httpTimeoutMs: 30_000,
  preflightAttempts: 3,
  retries: 0,
  runTimeoutMs: 20 * 60 * 60 * 1_000,
  testTimeoutMs: 4 * 60 * 60 * 1_000,
  goalTimeoutMs: 900_000,
  stopGraceMs: 1_000,
  dispatcherGraceMs: 250,
  monitorIntervalMs: 100,
  artifactBytes: 64 * 1024 * 1024,
  dispatcherOutputBytes: 2_000_000,
  modelCalls: 5_000,
  explorationSteps: 40,
  batchGoals: 50,
  controlsPerScreen: 5_000,
  settlementMs: 30_000,
});

export class RunLimitError extends Error {
  constructor(reason) { super(`Staging run stopped: ${reason}`); this.code = reason; }
}

export function modelCallsAllowed(environment = process.env) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(environment.E2E_RUN_ID || '') &&
    environment.E2E_ALLOW_MODEL_CALLS === environment.E2E_RUN_ID;
}

export function directoryBytes(root) {
  let total = 0;
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new RunLimitError('artifact-symlink-refused');
      total += stat.isDirectory() ? directoryBytes(path) : stat.size;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return total;
}

export function artifactCopyBytes(source) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new RunLimitError('artifact-symlink-refused');
  return stat.isDirectory() ? directoryBytes(source) : stat.size;
}

export function openRun(output, { limits = RUN_LIMITS, runId = process.env.E2E_RUN_ID, events = process, now = Date.now, newInvocation = false } = {}) {
  for (const [key, maximum] of Object.entries(RUN_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'retries' ? 0 : 1) || limits[key] > maximum)
      throw new RunLimitError('invalid-run-limits');
  }
  const root = resolve(output), path = join(root, 'run-budget.json'), lock = join(root, '.run-budget.lock');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let initializing = true;
  const update = change => {
    const lockDeadline = Date.now() + limits.stopGraceMs;
    for (;;) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= lockDeadline) throw new RunLimitError('run-ledger-busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      let state, missing = false;
      try { state = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new RunLimitError('run-ledger-unreadable'); missing = true; }
      if (missing) { const startedAt = now(); state = { schema: 'doctorcre-run-budget.v1', id: runId || randomUUID(), startedAt, deadline: startedAt + limits.runTimeoutMs,
        limits, httpRequests: 0, modelCalls: 0, artifactBytes: 0, activeHttp: {}, queuedHttp: {}, processGroups: {}, stopReason: null }; }
      if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== 'doctorcre-run-budget.v1' || runId && state.id !== runId ||
          (!(initializing && newInvocation) && JSON.stringify(state.limits) !== JSON.stringify(limits)) ||
          !state.limits || Object.entries(RUN_LIMITS).some(([key, maximum]) => !Number.isSafeInteger(state.limits[key]) || state.limits[key] < (key === 'retries' ? 0 : 1) || state.limits[key] > maximum) ||
          (state.invocations !== undefined && !Array.isArray(state.invocations)) ||
          !Number.isSafeInteger(state.deadline) || !Number.isSafeInteger(state.startedAt) || state.deadline !== state.startedAt + state.limits.runTimeoutMs ||
          typeof state.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(state.id) ||
          (state.stopReason !== null && typeof state.stopReason !== 'string') ||
          !state.queuedHttp || typeof state.queuedHttp !== 'object' || Array.isArray(state.queuedHttp) ||
          ['httpRequests', 'modelCalls', 'artifactBytes'].some(key => !Number.isSafeInteger(state[key]) || state[key] < 0) ||
          (!state.processGroups || typeof state.processGroups !== 'object' || Array.isArray(state.processGroups)) ||
          !state.activeHttp || typeof state.activeHttp !== 'object' || Array.isArray(state.activeHttp))
        throw new RunLimitError('run-ledger-invalid');
      const value = change(state, missing);
      const temporary = path + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'w' });
      renameSync(temporary, path);
      return value;
    } finally { rmSync(lock, { recursive: true }); }
  };
  const initial = update((state, missing) => {
    if (newInvocation && !missing) {
      if ([state.activeHttp, state.queuedHttp, state.processGroups].some(rows => Object.keys(rows).length))
        throw new RunLimitError('prior-invocation-unsettled');
      state.invocations ||= [];
      state.invocations.push({ startedAt: state.startedAt, deadline: state.deadline, httpRequests: state.httpRequests,
        modelCalls: state.modelCalls, stopReason: state.stopReason, limits: state.limits });
      state.startedAt = now(); state.deadline = state.startedAt + limits.runTimeoutMs;
      state.httpRequests = 0; state.modelCalls = 0; state.stopReason = null; state.limits = limits;
    }
    return structuredClone(state);
  });
  initializing = false;
  const controller = new AbortController();
  const cleanups = new Set();
  const stop = reason => {
    if (controller.signal.aborted) return;
    try { update(state => { state.stopReason ||= reason; }); }
    finally {
      controller.abort(new RunLimitError(reason));
      for (const cleanup of cleanups) Promise.resolve().then(cleanup).catch(() => {});
    }
  };
  const check = () => {
    controller.signal.throwIfAborted();
    const state = update(row => structuredClone(row));
    const reason = state.stopReason || (now() >= state.deadline ? 'whole-run-deadline' : null);
    if (reason) { stop(reason); controller.signal.throwIfAborted(); }
  };
  const reserve = (key, amount, reason) => {
    check();
    const accepted = update(state => {
      if (state.stopReason || now() >= state.deadline) { state.stopReason ||= 'whole-run-deadline'; return false; }
      if (key === 'artifactBytes') state.artifactBytes = Math.max(state.artifactBytes, directoryBytes(root));
      const maximum = key === 'artifactBytes' ? limits.artifactBytes - Math.min(limits.artifactMetadataBytes, Math.floor(limits.artifactBytes / 8)) : limits[key];
      if (state[key] + amount > maximum) { state.stopReason = reason; return false; }
      state[key] += amount; return true;
    });
    if (!accepted) { const stopped = update(state => state.stopReason); stop(stopped); throw new RunLimitError(stopped); }
  };
  const timer = setTimeout(() => { try { stop('whole-run-deadline'); } catch {} }, Math.max(1, initial.deadline - now()));
  timer.unref();
  const interrupt = () => { try { stop('stop-signal'); } catch {} };
  events?.on('SIGINT', interrupt); events?.on('SIGTERM', interrupt);
  const run = {
    root, id: initial.id, limits, signal: controller.signal, deadline: initial.deadline,
    check, stop,
    snapshot: () => update(state => structuredClone(state)),
    onStop(cleanup) { cleanups.add(cleanup); if (controller.signal.aborted) Promise.resolve().then(cleanup).catch(() => {}); return () => cleanups.delete(cleanup); },
    reserveProcessGroup() {
      check();
      const token = randomUUID();
      const accepted = update(state => {
        state.processGroups ||= {};
        if (state.stopReason || now() >= state.deadline) { state.stopReason ||= 'whole-run-deadline'; return false; }
        if (Object.keys(state.processGroups).length >= limits.processGroups - 1) { state.stopReason = 'process-group-limit'; return false; }
        state.processGroups[token] = process.pid; return true;
      });
      if (!accepted) { const reason = update(state => state.stopReason); stop(reason); throw new RunLimitError(reason); }
      return () => update(state => { delete state.processGroups[token]; });
    },
    // Only the supervisor calls this after verifying every owned process disappeared.
    releaseInvocationResources() { update(state => { state.processGroups = {}; state.activeHttp = {}; state.queuedHttp = {}; }); },
    reserveModel() { reserve('modelCalls', 1, 'model-call-limit'); },
    reserveBytes(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RunLimitError('invalid-artifact-size');
      reserve('artifactBytes', bytes, 'artifact-byte-limit');
    },
    checkArtifacts() {
      check();
      if (directoryBytes(root) > limits.artifactBytes) { stop('artifact-byte-limit'); throw new RunLimitError('artifact-byte-limit'); }
    },
    async http(operation) {
      check();
      const token = randomUUID();
      const queued = update(state => {
        if (state.stopReason || now() >= state.deadline) return state.stopReason ||= 'whole-run-deadline';
        if (Object.keys(state.queuedHttp).length >= limits.httpQueue) return state.stopReason = 'http-queue-limit';
        state.queuedHttp[token] = process.pid; return null;
      });
      if (queued) { stop(queued); throw new RunLimitError(queued); }
      let timeout, abort;
      try {
        const queueDeadline = now() + limits.httpTimeoutMs;
        for (;;) {
          check();
          const admission = update(state => {
            if (state.stopReason || now() >= state.deadline) return state.stopReason ||= 'whole-run-deadline';
            if (Object.keys(state.activeHttp).length >= limits.httpConcurrency) return false;
            if (state.httpRequests >= limits.httpRequests) return state.stopReason = 'http-request-limit';
            state.httpRequests++; state.activeHttp[token] = process.pid; delete state.queuedHttp[token]; return true;
          });
          if (admission === true) break;
          if (admission) { stop(admission); throw new RunLimitError(admission); }
          if (now() >= queueDeadline) { stop('http-admission-timeout'); throw new RunLimitError('http-admission-timeout'); }
          await new Promise(resolveWait => setTimeout(resolveWait, Math.min(10, limits.monitorIntervalMs)));
        }
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          timeout = setTimeout(() => { stop('http-request-timeout'); reject(new RunLimitError('http-request-timeout')); }, limits.httpTimeoutMs);
        });
        check();
        return await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), cancelled]);
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
        update(state => { delete state.activeHttp[token]; delete state.queuedHttp[token]; });
      }
    },
    async copyArtifacts(source, target, copier) {
      check();
      const name = relative(root, resolve(target));
      if (name.startsWith('..') || isAbsolute(name)) throw new RunLimitError('artifact-path-refused');
      run.reserveBytes(artifactCopyBytes(source));
      await withAccountedArtifactWrite(() => copier(source, target));
      run.checkArtifacts();
    },
    async writeFile(path, data, writer) { check(); const name = relative(root, resolve(path)); if (name.startsWith('..') || isAbsolute(name)) throw new RunLimitError('artifact-path-refused'); run.reserveBytes(Buffer.byteLength(data)); await artifactWrites.run(true, () => writer(path, data)); run.checkArtifacts(); },
    dispose() { clearTimeout(timer); events?.off('SIGINT', interrupt); events?.off('SIGTERM', interrupt); cleanups.clear(); },
  };
  return Object.freeze(run);
}

let activeRun;
export function currentRun(output = process.env.E2E_V2_OUTPUT) {
  if (!activeRun && process.env.E2E_RUN_SUPERVISED === '1') {
    if (!output || !process.env.E2E_RUN_ID) throw new RunLimitError('run-directory-required');
    let limits = RUN_LIMITS;
    try { if (process.env.E2E_RUN_LIMITS) limits = JSON.parse(process.env.E2E_RUN_LIMITS); }
    catch { throw new RunLimitError('invalid-run-limits'); }
    activeRun = openRun(output, { limits });
  }
  return activeRun;
}

export function requireSupervisedRun(output, suppliedRun) {
  if (process.env.E2E_TARGET !== 'staging-live') throw new RunLimitError('staging-target-required');
  if (process.env.E2E_RUN_SUPERVISED !== '1') throw new RunLimitError('supervised-run-required');
  const run = suppliedRun === undefined ? currentRun(output) : suppliedRun;
  if (!run) throw new RunLimitError('supervised-run-required');
  run.check();
  return run;
}

const boundedContexts = new WeakMap();
export function boundedRequestContext(api, run) {
  if (!run) return api;
  if (boundedContexts.get(api)?.run === run) return boundedContexts.get(api).proxy;
  const remove = run.onStop(() => api.dispose());
  const proxy = new Proxy(api, { get(target, key) {
    if (key === 'dispose') return async () => { remove(); return target.dispose(); };
    const value = target[key];
    if (['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'].includes(key))
      return (url, options = {}) => run.http(() => value.call(target, url, { ...options, maxRetries: RUN_LIMITS.retries, maxRedirects: 0, timeout: run.limits.httpTimeoutMs }));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  boundedContexts.set(api, { run, proxy });
  boundedContexts.set(proxy, { run, proxy });
  return proxy;
}
