// The one finite budget every live E2E run spends from. Each external request,
// browser context, control, screenshot and evidence byte is reserved here
// BEFORE it happens, and the reservation is written to disk before the work
// starts, so a failed or cancelled attempt stays spent and a restart resumes
// the same counters. Exhaustion, deadline, an operator stop or the first
// infrastructure failure persist STOPPED and abort the shared signal.
//
// Nothing here reads the environment or accepts a caller override that could
// widen a limit: a profile may only be as strict as or stricter than the
// approved Home smoke, the budget directory is fixed by this source file, and
// clearing a stop needs a separately reviewed reauthorization that does not
// exist yet.
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;

export const HOME_SMOKE = Object.freeze({
  name: 'home-smoke.v1',
  deadlineMs: 120_000,
  requestTimeoutMs: 30_000,
  retries: 0,
  concurrency: 2,
  http: 200,
  preflight: 8,
  model: 0,
  mutation: 0,
  fixture: 0,
  target: 1,
  viewport: 2,
  context: 2,
  controlsPerViewport: 10,
  control: 20,
  ownerState: 0,
  screenshot: 5,
  screenshotBytes: 2 * MiB,
  file: 100,
  byte: 20 * MiB,
  logByte: 1 * MiB,
  // The run refuses to start below this much free+inactive memory, so a
  // resident local model cannot starve the browser. A profile may only raise it.
  memoryFloorBytes: 16 * 1024 * MiB,
  trace: false,
  video: false,
  aiTrace: false,
});

export const BUDGET_DIR = fileURLToPath(new URL('../../.e2e/run-budget/', import.meta.url));

const COUNTERS = ['http', 'preflight', 'model', 'mutation', 'fixture', 'target', 'viewport', 'context', 'control', 'ownerState', 'screenshot', 'file', 'byte', 'logByte'];
const LIMITS = [...COUNTERS, 'deadlineMs', 'requestTimeoutMs', 'retries', 'concurrency', 'controlsPerViewport', 'screenshotBytes'];
const FLOORS = ['memoryFloorBytes'];
const SWITCHES = ['trace', 'video', 'aiTrace'];
const RECEIPT_MAX = 64 * 1024;
const STOP_POLL_MS = 250;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class BudgetRefusal extends Error {
  constructor(code) { super('E2E run budget refused: ' + code); this.code = code; }
}

export function validateProfile(profile) {
  const valid = profile && typeof profile === 'object' && typeof profile.name === 'string' && NAME.test(profile.name) &&
    Object.keys(profile).every(key => key === 'name' || LIMITS.includes(key) || FLOORS.includes(key) || SWITCHES.includes(key)) &&
    [...LIMITS, ...FLOORS].every(key => Number.isSafeInteger(profile[key]) && profile[key] >= 0) &&
    SWITCHES.every(key => typeof profile[key] === 'boolean') &&
    profile.concurrency >= 1 && profile.deadlineMs >= 1 && profile.requestTimeoutMs >= 1;
  if (!valid) throw new BudgetRefusal('profile-invalid');
  return profile;
}

function assertApproved(profile) {
  validateProfile(profile);
  if (LIMITS.some(key => profile[key] > HOME_SMOKE[key]) || FLOORS.some(key => profile[key] < HOME_SMOKE[key]) ||
      SWITCHES.some(key => profile[key] && !HOME_SMOKE[key]))
    throw new BudgetRefusal('profile-exceeds-approved');
}

// Entry points whose work the approved profile does not fund refuse before any
// setup, provider load or request; they never open or spend a budget.
export function assertProfilePermits(kind, profile = HOME_SMOKE) {
  if (!(profile[kind] > 0)) throw new BudgetRefusal(kind + '-not-budgeted');
}

const canonical = profile => JSON.stringify(Object.fromEntries(Object.keys(profile).sort().map(key => [key, profile[key]])));
const digest = profile => createHash('sha256').update(canonical(profile)).digest('hex');

const SYSTEM_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: timer => clearTimeout(timer),
  setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; },
  clearInterval: timer => clearInterval(timer),
});

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writePrivate(path, data, { replace = false } = {}) {
  const destination = replace ? `${path}.${randomUUID()}.tmp` : path;
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  if (replace) await rename(destination, path);
  await syncDirectory(join(path, '..'));
}

function validState(state) {
  return state && typeof state === 'object' && state.schema === 'e2e-run-budget.v1' && UUID.test(state.run_id || '') &&
    (() => { try { assertApproved(state.profile); return true; } catch { return false; } })() &&
    state.profile_sha256 === digest(state.profile) &&
    Number.isSafeInteger(state.created_at) && state.deadline_at === state.created_at + state.profile.deadlineMs &&
    state.spent && typeof state.spent === 'object' && Object.keys(state.spent).length === COUNTERS.length &&
    COUNTERS.every(key => Number.isSafeInteger(state.spent[key]) && state.spent[key] >= 0 && state.spent[key] <= state.profile[key]) &&
    (state.stopped === null || (typeof state.stopped?.reason === 'string' && Number.isSafeInteger(state.stopped.at)));
}

async function readState(dir) {
  let text;
  try { text = await readFile(join(dir, 'state.json'), 'utf8'); }
  catch (error) { throw new BudgetRefusal(error.code === 'ENOENT' ? 'state-missing' : 'state-corrupt'); }
  let state;
  try { state = JSON.parse(text); } catch { throw new BudgetRefusal('state-corrupt'); }
  if (!validState(state)) throw new BudgetRefusal('state-corrupt');
  return state;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// One live writer per budget. A lock left by a process that no longer exists
// is taken over, so the same counters resume after a crash.
async function acquireLock(dir) {
  const path = join(dir, 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writePrivate(path, String(process.pid));
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new BudgetRefusal('lock-failed');
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) throw new BudgetRefusal('lock-held');
      await unlink(path).catch(() => {});
    }
  }
  throw new BudgetRefusal('lock-held');
}

export async function createRunBudget({ dir = BUDGET_DIR, profile = HOME_SMOKE, clock = SYSTEM_CLOCK } = {}) {
  assertApproved(profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (existsSync(join(dir, 'STOP'))) throw new BudgetRefusal('operator-stop');
  if (existsSync(join(dir, 'state.json'))) throw new BudgetRefusal('state-exists');
  const lock = await acquireLock(dir);
  const created = clock.now();
  const state = {
    schema: 'e2e-run-budget.v1', run_id: randomUUID(), profile: { ...profile }, profile_sha256: digest(profile),
    created_at: created, deadline_at: created + profile.deadlineMs,
    spent: Object.fromEntries(COUNTERS.map(key => [key, 0])), stopped: null,
  };
  try { await writePrivate(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n'); }
  catch (error) { await unlink(lock).catch(() => {}); throw new BudgetRefusal(error.code === 'EEXIST' ? 'state-exists' : 'state-write-failed'); }
  return new RunBudget(dir, state, clock, lock);
}

export async function resumeRunBudget({ dir = BUDGET_DIR, clock = SYSTEM_CLOCK } = {}) {
  const state = await readState(dir);
  if (state.stopped) throw new BudgetRefusal('stopped');
  const budget = new RunBudget(dir, state, clock, await acquireLock(dir));
  const reason = existsSync(join(dir, 'STOP')) ? 'operator-stop' : clock.now() >= state.deadline_at ? 'deadline' : null;
  if (reason) {
    await budget.stop(reason);
    await budget.close();
    throw new BudgetRefusal(reason);
  }
  return budget;
}

// A local hold that needs no credential: any process may place it, every
// reservation and a short poll observe it, and it is never removed here.
export async function requestOperatorStop(dir = BUDGET_DIR, reason = 'operator') {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writePrivate(join(dir, 'STOP'), JSON.stringify({ reason: String(reason).slice(0, 200), at: new Date().toISOString() }) + '\n'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function reauthorizeRunBudget() {
  throw new BudgetRefusal('reauthorization-required');
}

class RunBudget {
  #dir; #state; #clock; #lock;
  #controller = new AbortController();
  #serialChain = Promise.resolve();
  #writeChain = Promise.resolve();
  #active = 0;
  #waiters = [];
  #hooks = new Set();
  #deadlineTimer; #stopPoll; #log = null; #closed = false; #finished = false; #halted = false;

  constructor(dir, state, clock, lock) {
    this.#dir = dir; this.#state = state; this.#clock = clock; this.#lock = lock;
    this.#deadlineTimer = clock.setTimeout(() => this.#stopNow('deadline'), Math.max(0, state.deadline_at - clock.now()));
    this.#stopPoll = clock.setInterval(() => { if (existsSync(join(dir, 'STOP'))) return this.#stopNow('operator-stop'); }, STOP_POLL_MS);
  }

  get runId() { return this.#state.run_id; }
  get profile() { return Object.freeze({ ...this.#state.profile }); }
  get spent() { return { ...this.#state.spent }; }
  get stopped() { return this.#state.stopped ? { ...this.#state.stopped } : null; }
  get signal() { return this.#controller.signal; }
  get openWriters() { return this.#log ? 1 : 0; }

  // A bounded timeout for one operation, never longer than the run has left.
  // Playwright treats 0 as "no timeout", so the floor is one millisecond.
  timeoutMs(cap = this.#state.profile.requestTimeoutMs) {
    return Math.max(1, Math.min(cap, this.#state.deadline_at - this.#clock.now()));
  }

  throwIfStopped() {
    if (this.#state.stopped) throw new BudgetRefusal('stopped');
  }

  onStop(hook) {
    if (this.#state.stopped) { Promise.resolve().then(hook).catch(() => {}); return () => {}; }
    this.#hooks.add(hook);
    return () => this.#hooks.delete(hook);
  }

  reserve(kind, amount = 1) {
    return this.#serial(() => this.#reserve({ [kind]: amount }));
  }

  // Reserve one request, wait for a concurrency slot, then send. The debit is
  // durable before `send` runs; a refused attempt never calls `send`, and a
  // reply that arrives after the run stopped is never returned.
  async dispatch(kind, send) {
    const debit = kind === 'preflight' ? { http: 1, preflight: 1 } : kind === 'http' ? { http: 1 } : null;
    if (!debit) { await this.#stopNow('unsupported-dispatch'); throw new BudgetRefusal('unsupported-dispatch'); }
    await this.#acquireSlot();
    let stopListener;
    try {
      await this.#serial(() => this.#reserve(debit));
      const stopped = new Promise((_, reject) => {
        stopListener = () => reject(new BudgetRefusal(this.#state.stopped?.reason || 'stopped'));
        this.signal.addEventListener('abort', stopListener, { once: true });
      });
      const attempt = Promise.resolve().then(() => send(this.signal));
      attempt.catch(() => {});
      const result = await Promise.race([attempt, stopped]);
      if (this.#state.stopped) throw new BudgetRefusal(this.#state.stopped.reason);
      return result;
    } finally {
      if (stopListener) this.signal.removeEventListener('abort', stopListener);
      this.#releaseSlot();
    }
  }

  async writeEvidence(name, data) {
    const bytes = Buffer.from(data);
    return this.#serial(async () => {
      this.#reserveName(name);
      await this.#reserve({ file: 1, byte: bytes.length });
      return this.#writeEvidenceFile(name, bytes);
    });
  }

  async copyEvidence(source, destination) {
    return this.#serial(async () => {
      this.#reserveName(source); this.#reserveName(destination);
      const size = (await stat(join(this.#evidenceDir, source))).size;
      await this.#reserve({ file: 1, byte: size });
      await copyFile(join(this.#evidenceDir, source), join(this.#evidenceDir, destination), constants.COPYFILE_EXCL);
      return destination;
    });
  }

  // The worst-case screenshot size is reserved before capture, so the
  // temporary buffer is inside the quota; an oversized capture is never written.
  async captureScreenshot(page, name) {
    const { screenshotBytes } = this.#state.profile;
    await this.#serial(async () => { this.#reserveName(name); await this.#reserve({ screenshot: 1, file: 1, byte: screenshotBytes }); });
    const image = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false, animations: 'disabled', timeout: this.timeoutMs() });
    if (image.length > screenshotBytes) { await this.#stopNow('screenshot-oversize'); throw new BudgetRefusal('screenshot-oversize'); }
    this.throwIfStopped();
    await this.#writeEvidenceFile(name, image);
    return name;
  }

  async log(line) {
    const text = Buffer.from(String(line).replace(/\n/g, ' ') + '\n');
    return this.#serial(async () => {
      await this.#reserve(this.#log ? { logByte: text.length, byte: text.length } : { logByte: text.length, byte: text.length, file: 1 });
      this.#log ||= await open(join(this.#dir, 'run.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      await this.#log.write(text);
    });
  }

  stop(reason) {
    return this.#stopNow(reason);
  }

  // Ends the run: a run that was not already stopped becomes terminal as
  // "completed", the bounded receipt is written from the held-back headroom,
  // and no writer, timer or lock outlives the call. A stopped run can never
  // report qualified coverage.
  async finish(receipt) {
    return this.#serial(async () => {
      if (this.#finished) throw new BudgetRefusal('finished');
      this.#finished = true;
      if (!this.#state.stopped) await this.#stopNow('completed');
      const stopped = this.#state.stopped;
      const base = { run_id: this.#state.run_id, profile: this.#state.profile.name, stopped };
      let final = { ...receipt, ...base, qualified: receipt?.qualified === true && stopped.reason === 'completed', spent: this.spent };
      let body = Buffer.from(JSON.stringify(final, null, 2) + '\n');
      if (body.length > this.#receiptReserve()) {
        final = { schema: receipt?.schema, ...base, qualified: false, truncated: true, spent: this.spent };
        body = Buffer.from(JSON.stringify(final) + '\n');
      }
      // `spent` in the receipt is the run before the receipt itself; the
      // durable state also counts the receipt's own file and bytes.
      await this.#reserve({ file: 1, byte: body.length }, { final: true });
      await this.#writeEvidenceFile(this.#receiptName, body);
      await this.#release();
      return final;
    });
  }

  async close() {
    await this.#release();
  }

  get #evidenceDir() { return join(this.#dir, 'evidence'); }
  get #receiptName() { return this.#state.profile.name.replace(/\.v\d+$/, '') + '-receipt.json'; }
  #receiptReserve() { return Math.min(RECEIPT_MAX, Math.floor(this.#state.profile.byte / 4)); }

  #reserveName(name) {
    if (!NAME.test(name) || name === this.#receiptName) throw new BudgetRefusal('evidence-path-refused');
  }

  #serial(work) {
    const next = this.#serialChain.then(work);
    this.#serialChain = next.catch(() => {});
    return next;
  }

  async #reserve(debit, { final = false } = {}) {
    if (this.#closed) throw new BudgetRefusal('closed');
    const wasStopped = Boolean(this.#state.stopped);
    if (!wasStopped && this.#clock.now() >= this.#state.deadline_at) await this.#stopNow('deadline');
    if (!wasStopped && existsSync(join(this.#dir, 'STOP'))) await this.#stopNow('operator-stop');
    if (this.#state.stopped && !final) throw new BudgetRefusal(wasStopped ? 'stopped' : this.#state.stopped.reason);
    const { profile, spent } = this.#state;
    // Evidence quotas hold back room for the one bounded receipt.
    const headroom = final ? {} : { byte: this.#receiptReserve(), file: 1 };
    for (const [kind, amount] of Object.entries(debit)) {
      if (!COUNTERS.includes(kind) || !Number.isSafeInteger(amount) || amount < 0) {
        await this.#stopNow('unsupported-' + kind);
        throw new BudgetRefusal('unsupported-' + kind);
      }
      if (spent[kind] + amount + (headroom[kind] || 0) > profile[kind]) {
        if (final) throw new BudgetRefusal('receipt-exhausted');
        await this.#stopNow(kind + '-exhausted');
        throw new BudgetRefusal(kind + '-exhausted');
      }
    }
    for (const [kind, amount] of Object.entries(debit)) spent[kind] += amount;
    await this.#persist();
  }

  #persist() {
    const snapshot = JSON.stringify(this.#state, null, 2) + '\n';
    const write = this.#writeChain.then(() => writePrivate(join(this.#dir, 'state.json'), snapshot, { replace: true }));
    this.#writeChain = write.catch(() => {});
    return write;
  }

  async #writeEvidenceFile(name, bytes) {
    await mkdir(this.#evidenceDir, { recursive: true, mode: 0o700 });
    await writePrivate(join(this.#evidenceDir, name), bytes);
    return name;
  }

  async #acquireSlot() {
    if (this.#state.stopped) throw new BudgetRefusal('stopped');
    if (this.#active < this.#state.profile.concurrency) { this.#active++; return; }
    await new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #releaseSlot() {
    const next = this.#waiters.shift();
    if (next) next.resolve(); else this.#active--;
  }

  async #stopNow(reason) {
    if (!this.#state.stopped) {
      this.#state.stopped = { reason, at: this.#clock.now() };
      await this.#persist();
    }
    if (this.#halted) return;
    this.#halted = true;
    this.#clearTimers();
    this.#controller.abort();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new BudgetRefusal('stopped'));
    const hooks = [...this.#hooks];
    this.#hooks.clear();
    await Promise.allSettled(hooks.map(hook => Promise.resolve().then(hook)));
  }

  #clearTimers() {
    this.#clock.clearTimeout(this.#deadlineTimer);
    this.#clock.clearInterval(this.#stopPoll);
  }

  async #release() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    if (this.#log) { await this.#log.close().catch(() => {}); this.#log = null; }
    await this.#writeChain;
    const owner = await readFile(this.#lock, 'utf8').catch(() => '');
    if (owner === String(process.pid)) await unlink(this.#lock).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...reason] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (command !== 'stop') throw new BudgetRefusal('only "stop <reason>" is supported; clearing a stop needs reviewed reauthorization');
    await requestOperatorStop(BUDGET_DIR, reason.join(' ') || 'operator');
    console.log('Operator stop recorded at ' + join(BUDGET_DIR, 'STOP'));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
