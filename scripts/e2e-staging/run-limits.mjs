import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, fstatSync, openSync, closeSync, constants } from 'node:fs';
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
  // Whole-run (all resumed invocations) evidence ceiling. Measured on the fixture
  // app: the 5,140 path/viewport control candidates of a full sweep cost about
  // 207 MB as passing viewport JPEGs; the rest covers reports and full-page
  // failure PNGs (about 0.6 MB each).
  artifactBytes: 256 * 1024 * 1024,
  dispatcherOutputBytes: 2_000_000,
  modelCalls: 5_000,
  explorationSteps: 40,
  batchGoals: 50,
  controlsPerScreen: 5_000,
  settlementMs: 30_000,
});

export class RunLimitError extends Error {
  constructor(reason, detail) { super(`Staging run stopped: ${reason}${detail ? ` (${detail})` : ''}`); this.code = reason; }
}

const validRunLimits = limits => limits && typeof limits === 'object' && !Array.isArray(limits) &&
  Object.keys(limits).every(key => Object.hasOwn(RUN_LIMITS, key)) &&
  Object.entries(RUN_LIMITS).every(([key, maximum]) => Number.isSafeInteger(limits[key]) &&
    limits[key] >= (['retries', 'modelCalls'].includes(key) ? 0 : 1) && limits[key] <= maximum);

// A provided E2E_RUN_LIMITS is the whole policy: every limit is named, so an
// omitted key can never silently keep its default.
export function runLimitsFromEnvironment(environment = process.env, ceiling = RUN_LIMITS) {
  if (!validRunLimits(ceiling)) throw new RunLimitError('invalid-run-limits');
  if (environment.E2E_RUN_LIMITS === undefined) return Object.freeze({ ...ceiling });
  let limits;
  try { limits = JSON.parse(environment.E2E_RUN_LIMITS); }
  catch { throw new RunLimitError('invalid-run-limits', 'malformed JSON'); }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits))
    throw new RunLimitError('invalid-run-limits', 'expected a JSON object');
  const missing = Object.keys(ceiling).filter(key => !Object.hasOwn(limits, key));
  const unknown = Object.keys(limits).filter(key => !Object.hasOwn(ceiling, key));
  if (missing.length || unknown.length) throw new RunLimitError('invalid-run-limits',
    [missing.length && `missing ${missing.join(', ')}`, unknown.length && `unknown ${unknown.join(', ')}`].filter(Boolean).join('; '));
  if (Object.entries(limits).some(([key, value]) => value > ceiling[key]) || !validRunLimits(limits))
    throw new RunLimitError('invalid-run-limits', 'every limit must be an integer no higher than its default');
  return Object.freeze(Object.fromEntries(Object.keys(ceiling).map(key => [key, limits[key]])));
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

export function openRun(output, { limits = RUN_LIMITS, runId = process.env.E2E_RUN_ID, events = process, now = Date.now, newInvocation = false,
  ownerId = process.env.E2E_RUN_OWNER, retirement } = {}) {
  if (!validRunLimits(limits)) throw new RunLimitError('invalid-run-limits');
  if (ownerId !== undefined && (typeof ownerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ownerId)))
    throw new RunLimitError('process-ownership-invalid');
  const root = resolve(output), path = join(root, 'run-budget.json'), lock = join(root, '.run-budget.lock');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let initializing = true;
  // Writers publish by atomic rename. Observers decode the last complete ledger
  // without taking the mutation lock or publishing an unchanged copy.
  const readLedger = () => {
    let state, missing = false;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new RunLimitError('run-ledger-unreadable'); missing = true; }
    if (missing && !initializing) throw new RunLimitError('run-ledger-unreadable');
    if (missing) { const startedAt = now(); state = { schema: 'doctorcre-run-budget.v1', id: runId || randomUUID(), startedAt, deadline: startedAt + limits.runTimeoutMs,
      limits, httpRequests: 0, modelCalls: 0, artifactBytes: 0, activeHttp: {}, queuedHttp: {}, processGroups: {}, stopReason: null }; }
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== 'doctorcre-run-budget.v1' || runId && state.id !== runId ||
        (!initializing && state.id !== initial.id) ||
        (!(initializing && newInvocation) && JSON.stringify(state.limits) !== JSON.stringify(limits)) ||
        !validRunLimits(state.limits) ||
        (state.invocations !== undefined && !Array.isArray(state.invocations)) ||
        !Number.isSafeInteger(state.deadline) || !Number.isSafeInteger(state.startedAt) || state.deadline !== state.startedAt + state.limits.runTimeoutMs ||
        typeof state.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(state.id) ||
        (state.stopReason !== null && typeof state.stopReason !== 'string') ||
        !state.queuedHttp || typeof state.queuedHttp !== 'object' || Array.isArray(state.queuedHttp) ||
        ['httpRequests', 'modelCalls', 'artifactBytes'].some(key => !Number.isSafeInteger(state[key]) || state[key] < 0) ||
        (!state.processGroups || typeof state.processGroups !== 'object' || Array.isArray(state.processGroups)) ||
        !state.activeHttp || typeof state.activeHttp !== 'object' || Array.isArray(state.activeHttp))
      throw new RunLimitError('run-ledger-invalid');
    return { state, missing };
  };
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
      const { state, missing } = readLedger();
      const value = change(state, missing);
      // Publish ownership before the ledger rename. An interrupted marker write
      // is unknown ownership and must never be reclaimed.
      if (ownerId) withAccountedArtifactWrite(() => writeFileSync(join(lock, 'owner.json'), JSON.stringify({
        schema: 'doctorcre-run-lock.v1', runId: state.id, invocation: ownerId, pid: process.pid,
      }), { mode: 0o600, flag: 'wx' }));
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
    const { state } = readLedger();
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
  const timer = retirement ? undefined : setTimeout(() => { try { stop('whole-run-deadline'); } catch {} }, Math.max(1, initial.deadline - now()));
  timer?.unref();
  const interrupt = () => { try { stop('stop-signal'); } catch {} };
  events?.on('SIGINT', interrupt); events?.on('SIGTERM', interrupt);
  const run = {
    root, id: initial.id, limits, signal: controller.signal, deadline: initial.deadline,
    check, stop,
    snapshot: () => readLedger().state,
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
    releaseInvocationResources() {
      // This capability stays in the supervisor. Every owned group must already
      // be physically gone, with complete ownership evidence and the lease held.
      if (retirement) {
        readLedger();
        if (!retirement.isRetired()) throw new RunLimitError('process-cleanup-unverified');
        const held = fstatSync(retirement.lease), current = lstatSync(join(root, '.run-owner'));
        if (!held.isFile() || !current.isFile() || held.nlink !== 1 || (held.mode & 0o077) || current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino ||
            readFileSync(join(root, '.run-owner'), 'utf8') !== String(process.pid))
          throw new RunLimitError('process-cleanup-unverified');
        let marker, directory, markerFile;
        try {
          directory = openSync(lock, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const directoryStat = fstatSync(directory);
          markerFile = openSync(join(lock, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
          const markerStat = fstatSync(markerFile);
          if (directoryStat.isDirectory() && !(directoryStat.mode & 0o077) &&
              markerStat.isFile() && markerStat.nlink === 1 && !(markerStat.mode & 0o077) && markerStat.size <= 1024) {
            marker = JSON.parse(readFileSync(markerFile, 'utf8'));
            const currentDirectory = lstatSync(lock);
            if (!currentDirectory.isDirectory() || currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino)
              marker = undefined;
          }
          if (marker?.schema === 'doctorcre-run-lock.v1' && ownerId && marker.invocation === ownerId &&
              marker.runId === initial.id && Number.isSafeInteger(marker.pid) && marker.pid > 1) {
            let dead = false;
            try { process.kill(marker.pid, 0); }
            catch (error) { if (error.code !== 'ESRCH') throw error; dead = true; }
            if (dead) rmSync(lock, { recursive: true });
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
        } finally {
          if (markerFile !== undefined) closeSync(markerFile);
          if (directory !== undefined) closeSync(directory);
        }
      }
      update(state => { state.processGroups = {}; state.activeHttp = {}; state.queuedHttp = {}; });
    },
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
      // A full queue is backpressure, not a run stop: one staging page load
      // requests more assets at once than httpQueue holds. An overflowing caller
      // waits, unregistered, for a queue slot; only a queue that stays full for
      // httpTimeoutMs stops the run. Totals, deadline and timeouts still bound it.
      const overflowDeadline = now() + limits.httpTimeoutMs;
      let queued;
      for (;;) {
        check();
        queued = update(state => {
          if (state.stopReason || now() >= state.deadline) return state.stopReason ||= 'whole-run-deadline';
          if (Object.keys(state.queuedHttp).length >= limits.httpQueue) return false;
          state.queuedHttp[token] = process.pid; return null;
        });
        if (queued !== false) break;
        if (now() >= overflowDeadline) { queued = update(state => state.stopReason ||= 'http-queue-limit'); break; }
        await new Promise(resolveWait => setTimeout(resolveWait, Math.min(10, limits.monitorIntervalMs)));
      }
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
    // `replaces` names the retained file this write will be published over (a
    // staged checkpoint rewrite). Its bytes were charged when it was written, so
    // only growth is charged again; the live directory check still bounds the
    // transient old-plus-staged copy.
    async writeFile(path, data, writer, { replaces } = {}) {
      check();
      const within = target => { const name = relative(root, resolve(target)); if (name.startsWith('..') || isAbsolute(name)) throw new RunLimitError('artifact-path-refused'); };
      within(path);
      let retained = 0;
      if (replaces !== undefined) {
        within(replaces);
        try { retained = artifactCopyBytes(replaces); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      run.reserveBytes(Math.max(0, Buffer.byteLength(data) - retained));
      await artifactWrites.run(true, () => writer(path, data));
      run.checkArtifacts();
    },
    dispose() { clearTimeout(timer); events?.off('SIGINT', interrupt); events?.off('SIGTERM', interrupt); cleanups.clear(); },
  };
  return Object.freeze(run);
}

let activeRun;
export function effectiveRunLimits(run = activeRun) {
  return run?.limits ?? runLimitsFromEnvironment();
}

export function currentRun(output = process.env.E2E_V2_OUTPUT) {
  if (!activeRun && process.env.E2E_RUN_SUPERVISED === '1') {
    if (!output || !process.env.E2E_RUN_ID) throw new RunLimitError('run-directory-required');
    const limits = runLimitsFromEnvironment();
    // The supervisor owns signal stop receipts. A worker's redundant signal
    // write can be interrupted by SIGKILL while holding the shared ledger lock.
    activeRun = openRun(output, { limits, events: null });
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
      return (url, options = {}) => run.http(() => value.call(target, url, { ...options, maxRetries: run.limits.retries, maxRedirects: 0, timeout: run.limits.httpTimeoutMs }));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  boundedContexts.set(api, { run, proxy });
  boundedContexts.set(proxy, { run, proxy });
  return proxy;
}
