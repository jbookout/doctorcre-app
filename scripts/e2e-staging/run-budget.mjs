// The one finite budget every live E2E run spends from. Each external request,
// model call, write, browser context, control, screenshot, evidence byte and
// response byte is reserved here BEFORE it happens, and the reservation is
// durable before the work starts, so a failed or cancelled attempt stays spent
// and a restart resumes the same counters. Exhaustion, deadline, an operator
// stop or the first infrastructure failure persist STOPPED and abort the
// shared signal.
//
// State is machine-wide: one fixed per-user directory that no checkout, cwd,
// HOME or environment variable can move. A run exists only after a human runs
// `node scripts/e2e-staging/run-budget.mjs authorize --profile <name> --reason
// "<text>"`, which appends an authorization to an append-only ledger and starts
// a new run id. Every state write and ledger entry carries an HMAC-SHA256 under
// a local key kept in the same directory (mode 600). That key is local tamper
// evidence only: it is never sent anywhere and never printed.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
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
  modelOutputTokens: 0,
  modelTimeoutMs: 0,
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
  ingress: 50 * MiB,
  responseBytes: 10 * MiB,
  // The run refuses to start below this much free+inactive memory, so a
  // resident local model cannot starve the browser. A profile may only raise it.
  memoryFloorBytes: 16 * 1024 * MiB,
  trace: false,
  video: false,
  aiTrace: false,
});

// Joe approved this second profile on 2026-10-08 for the control sweep and the
// model-driven exploration. Writes are staging-only and fixture-tagged, and
// cleanup is charged to the same mutation count.
export const SWEEP_EXPLORE = Object.freeze({
  name: 'sweep-explore.v1',
  deadlineMs: 600_000,
  requestTimeoutMs: 30_000,
  retries: 0,
  concurrency: 2,
  http: 400,
  preflight: 8,
  model: 20,
  modelOutputTokens: 4096,
  modelTimeoutMs: 60_000,
  mutation: 25,
  fixture: 25,
  target: 4,
  viewport: 4,
  context: 400,
  controlsPerViewport: 400,
  control: 400,
  ownerState: 100,
  screenshot: 20,
  screenshotBytes: 2 * MiB,
  file: 200,
  byte: 50 * MiB,
  logByte: 1 * MiB,
  ingress: 200 * MiB,
  responseBytes: 10 * MiB,
  memoryFloorBytes: 16 * 1024 * MiB,
  trace: false,
  video: false,
  aiTrace: false,
});

const PROFILES = Object.freeze({ [HOME_SMOKE.name]: HOME_SMOKE, [SWEEP_EXPLORE.name]: SWEEP_EXPLORE });

// os.userInfo() reads the account database, not $HOME, so a changed HOME or
// XDG_STATE_HOME cannot hand a run a fresh budget.
export const BUDGET_DIR = join(userInfo().homedir, '.local', 'state', 'doctorcre-e2e');

const COUNTERS = ['http', 'preflight', 'model', 'mutation', 'fixture', 'target', 'viewport', 'context', 'control', 'ownerState', 'screenshot', 'file', 'byte', 'logByte', 'ingress'];
const LIMITS = [...COUNTERS, 'deadlineMs', 'requestTimeoutMs', 'retries', 'concurrency', 'controlsPerViewport', 'screenshotBytes', 'modelOutputTokens', 'modelTimeoutMs', 'responseBytes'];
const FLOORS = ['memoryFloorBytes'];
const SWITCHES = ['trace', 'video', 'aiTrace'];
const RECEIPT_MAX = 64 * 1024;
const STOP_POLL_MS = 250;
const STATE_SCHEMA = 'e2e-run-budget.v2';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACTIVE = Symbol.for('doctorcre.e2e.activeBudget');

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

// A profile is one of the approved profiles, or a copy of one that is equal or
// stricter on every bound. Nothing can loosen a bound or invent a profile.
function resolveProfile(requested) {
  if (typeof requested === 'string') return PROFILES[profileName(requested)];
  const base = PROFILES[requested?.name];
  if (!base) throw new BudgetRefusal('profile-unknown');
  validateProfile(requested);
  if (LIMITS.some(key => requested[key] > base[key]) || FLOORS.some(key => requested[key] < base[key]) ||
      SWITCHES.some(key => requested[key] && !base[key]))
    throw new BudgetRefusal('profile-exceeds-approved');
  return Object.freeze({ ...requested });
}

function profileName(requested) {
  if (typeof requested === 'string') {
    if (Object.hasOwn(PROFILES, requested)) return requested;
    if (Object.hasOwn(PROFILES, requested + '.v1')) return requested + '.v1';
  }
  throw new BudgetRefusal('profile-unknown');
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const digest = profile => createHash('sha256').update(canonicalJSON(profile)).digest('hex');
const sign = (key, value) => createHmac('sha256', key).update(canonicalJSON(value)).digest('hex');
const sameMac = (mac, expected) => typeof mac === 'string' && HEX64.test(mac) && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'));

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

async function appendPrivate(path, line) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { await handle.write(line); await handle.sync(); } finally { await handle.close(); }
}

const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function readPrivate(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new BudgetRefusal('state-unreadable'); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new BudgetRefusal('state-permissions');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function validState(state) {
  return state && typeof state === 'object' && state.schema === STATE_SCHEMA && UUID.test(state.run_id || '') &&
    (() => { try { resolveProfile(state.profile); return true; } catch { return false; } })() &&
    state.profile_sha256 === digest(state.profile) && Number.isSafeInteger(state.authorized_at) &&
    ((state.started_at === null && state.deadline_at === null) ||
      (Number.isSafeInteger(state.started_at) && state.deadline_at === state.started_at + state.profile.deadlineMs)) &&
    state.spent && typeof state.spent === 'object' && Object.keys(state.spent).length === COUNTERS.length &&
    COUNTERS.every(key => Number.isSafeInteger(state.spent[key]) && state.spent[key] >= 0 && state.spent[key] <= state.profile[key]) &&
    (state.stopped === null || (typeof state.stopped?.reason === 'string' && Number.isSafeInteger(state.stopped.at)));
}

// Reads and verifies everything in the directory without changing it. Returns
// null only when the fixed location has never held a run: no key, no ledger
// and no state. Any other partial set fails closed with its own code.
async function inspect(dir) {
  const keyText = await readPrivate(join(dir, 'key'));
  const ledgerText = await readPrivate(join(dir, 'ledger.jsonl'));
  const stateText = await readPrivate(join(dir, 'state.json'));
  if (keyText === null && ledgerText === null && stateText === null) return null;
  if (keyText === null) throw new BudgetRefusal('key-missing');
  if (ledgerText === null) throw new BudgetRefusal('ledger-missing');
  if (!/^[0-9a-f]{64}\n?$/.test(keyText)) throw new BudgetRefusal('key-invalid');
  const key = Buffer.from(keyText.trim(), 'hex');
  const ledger = [];
  let prev = '';
  for (const line of ledgerText.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { throw new BudgetRefusal('ledger-tampered'); }
    const { mac, ...body } = entry && typeof entry === 'object' ? entry : {};
    if (body.seq !== ledger.length || body.prev !== prev || !sameMac(mac, sign(key, body))) throw new BudgetRefusal('ledger-tampered');
    ledger.push(entry);
    prev = mac;
  }
  const authorized = ledger.filter(entry => entry.type === 'authorized');
  if (!authorized.length) throw new BudgetRefusal('ledger-tampered');
  if (stateText === null) throw new BudgetRefusal('state-missing');
  let state;
  try { state = JSON.parse(stateText); } catch { throw new BudgetRefusal('state-corrupt'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new BudgetRefusal('state-corrupt');
  const { mac, ...unsigned } = state;
  if (!sameMac(mac, sign(key, unsigned))) throw new BudgetRefusal('state-tampered');
  if (!validState(unsigned)) throw new BudgetRefusal('state-corrupt');
  const last = authorized.at(-1);
  if (last.run_id !== unsigned.run_id || canonicalJSON(last.profile) !== canonicalJSON(unsigned.profile)) throw new BudgetRefusal('state-tampered');
  const checkpoint = ledger.filter(entry => entry.type === 'checkpoint' && entry.run_id === unsigned.run_id).at(-1);
  if (checkpoint && (COUNTERS.some(name => unsigned.spent[name] < checkpoint.spent[name]) ||
      (checkpoint.stopped && !unsigned.stopped) || (checkpoint.started_at !== null && unsigned.started_at !== checkpoint.started_at)))
    throw new BudgetRefusal('counter-regressed');
  return { key, head: { seq: ledger.length, prev }, state: unsigned };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// One live writer per directory. A lock left by a process that no longer
// exists is taken over, so the same counters resume after a crash.
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

async function releaseLock(path) {
  const owner = await readFile(path, 'utf8').catch(() => '');
  if (owner === String(process.pid)) await unlink(path).catch(() => {});
}

async function appendEntry(dir, key, head, fields) {
  const body = { seq: head.seq, prev: head.prev, ...fields };
  const mac = sign(key, body);
  await appendPrivate(join(dir, 'ledger.jsonl'), JSON.stringify({ ...body, mac }) + '\n');
  return { seq: head.seq + 1, prev: mac };
}

const signedState = (key, state) => JSON.stringify({ ...state, mac: sign(key, state) }, null, 2) + '\n';

// The human step that starts a budget. Nothing else creates a run.
export async function authorizeRun({ dir = BUDGET_DIR, profile, reason, clock = SYSTEM_CLOCK } = {}) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new BudgetRefusal('reason-required');
  const approved = resolveProfile(profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await stat(dir)).mode & 0o077) throw new BudgetRefusal('state-permissions');
  if (await exists(join(dir, 'STOP'))) throw new BudgetRefusal('operator-stop');
  const lock = await acquireLock(dir);
  try {
    const found = await inspect(dir);
    if (found && !found.state.stopped) throw new BudgetRefusal('run-active');
    let key = found?.key;
    if (!key) {
      key = randomBytes(32);
      await writePrivate(join(dir, 'key'), key.toString('hex') + '\n');
    }
    const now = clock.now();
    const state = {
      schema: STATE_SCHEMA, run_id: randomUUID(), profile: { ...approved }, profile_sha256: digest(approved),
      authorized_at: now, started_at: null, deadline_at: null,
      spent: Object.fromEntries(COUNTERS.map(name => [name, 0])), stopped: null,
    };
    // The ledger records the authorization first; a crash before the state
    // write leaves a pair that refuses to open rather than a fresh budget.
    await appendEntry(dir, key, found?.head || { seq: 0, prev: '' }, { type: 'authorized', run_id: state.run_id, at: now, profile: state.profile, reason: reason.trim() });
    await writePrivate(join(dir, 'state.json'), signedState(key, state), { replace: true });
    return { run_id: state.run_id, profile: approved.name, authorized_at: new Date(now).toISOString() };
  } finally { await releaseLock(lock); }
}

export function describeAuthorization(result) {
  return `Authorized E2E run ${result.run_id} under profile ${result.profile} at ${result.authorized_at}. ` +
    'It is spent once; a stopped or finished run needs a new authorization.';
}

async function authorizedState(dir, name) {
  const found = await inspect(dir);
  if (!found) throw new BudgetRefusal('not-authorized');
  if (found.state.stopped) throw new BudgetRefusal('stopped');
  if (found.state.profile.name !== name) throw new BudgetRefusal('profile-mismatch');
  return found;
}

// A read-only check that a named profile is authorized and not yet spent. It
// opens nothing, so a refusal after it (for example a crowded host) leaves the
// authorization intact for a later attempt.
export async function readAuthorization({ dir = BUDGET_DIR, profile } = {}) {
  const name = profileName(profile);
  if (!(await exists(dir))) throw new BudgetRefusal('not-authorized');
  const { state } = await authorizedState(dir, name);
  return { run_id: state.run_id, profile: Object.freeze({ ...state.profile }) };
}

export async function openRunBudget({ dir = BUDGET_DIR, profile, clock = SYSTEM_CLOCK } = {}) {
  const name = profileName(profile);
  if (!(await exists(dir))) throw new BudgetRefusal('not-authorized');
  const lock = await acquireLock(dir);
  let budget;
  try { budget = new RunBudget(dir, await authorizedState(dir, name), clock, lock); }
  catch (error) { await releaseLock(lock); throw error; }
  await budget.start();
  return budget;
}

// A local hold that needs no credential: any process may place it, every
// reservation and a short poll observe it, it blocks every later
// authorization, and nothing in this source removes it.
export async function requestOperatorStop(dir = BUDGET_DIR, reason = 'operator') {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writePrivate(join(dir, 'STOP'), JSON.stringify({ reason: String(reason).slice(0, 200), at: new Date().toISOString() }) + '\n'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// The budget that model calls and in-page routes charge, for code (the e2e
// SDK's config, engines and agents) that cannot be handed one directly.
export function setActiveBudget(budget) {
  if (budget) globalThis[ACTIVE] = budget; else delete globalThis[ACTIVE];
}
export const activeBudget = () => globalThis[ACTIVE] || null;

class RunBudget {
  #dir; #state; #clock; #lock; #key; #head;
  #controller = new AbortController();
  #serialChain = Promise.resolve();
  #writeChain = Promise.resolve();
  #active = 0;
  #waiters = [];
  #hooks = new Set();
  #fixtures = new Set();
  #ingressInflight = 0;
  #deadlineTimer; #stopPoll; #log = null; #closed = false; #finished = false; #halted = false;

  constructor(dir, found, clock, lock) {
    this.#dir = dir; this.#state = found.state; this.#clock = clock; this.#lock = lock;
    this.#key = found.key; this.#head = found.head;
  }

  async start() {
    try {
      if (await exists(join(this.#dir, 'STOP'))) await this.#stopNow('operator-stop');
      else if (this.#state.started_at === null) {
        this.#state.started_at = this.#clock.now();
        this.#state.deadline_at = this.#state.started_at + this.#state.profile.deadlineMs;
        await this.#persist();
      } else if (this.#clock.now() >= this.#state.deadline_at) await this.#stopNow('deadline');
      if (this.#state.stopped) throw new BudgetRefusal(this.#state.stopped.reason);
    } catch (error) { await this.#release(); throw error; }
    // Timer-driven stops swallow their own write errors: the abort has
    // already happened, and a timer callback has no caller to reject to.
    this.#deadlineTimer = this.#clock.setTimeout(() => this.#stopNow('deadline').catch(() => {}), Math.max(0, this.#state.deadline_at - this.#clock.now()));
    this.#stopPoll = this.#clock.setInterval(() => exists(join(this.#dir, 'STOP'))
      .then(held => held && this.#stopNow('operator-stop')).catch(() => {}), STOP_POLL_MS);
  }

  get runId() { return this.#state.run_id; }
  get profile() { return Object.freeze({ ...this.#state.profile }); }
  get spent() { return { ...this.#state.spent }; }
  get stopped() { return this.#state.stopped ? { ...this.#state.stopped } : null; }
  get signal() { return this.#controller.signal; }
  get openWriters() { return this.#log ? 1 : 0; }
  get evidenceDir() { return join(this.#dir, 'evidence', this.#state.run_id); }
  get fixtureIds() { return new Set(this.#fixtures); }

  // Records the ids of synthetic fixture records this run may write to.
  tagFixtures(ids) { for (const id of ids) if (typeof id === 'string' && id) this.#fixtures.add(id); }

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

  // Reserve one attempt, wait for a concurrency slot, then send. The debit is
  // durable before `send` runs; a refused attempt never calls `send`, and a
  // reply that arrives after the run stopped is never returned.
  async dispatch(kind, send) {
    const debit = { http: { http: 1 }, preflight: { http: 1, preflight: 1 }, mutation: { http: 1, mutation: 1 }, model: { model: 1 } }[kind];
    if (!debit) { await this.#stopNow('unsupported-dispatch'); throw new BudgetRefusal('unsupported-dispatch'); }
    await this.#acquireSlot();
    let stopListener;
    try {
      await this.#serial(() => this.#reserve(debit));
      // A stop can land while the debit is being written; nothing is sent then.
      if (this.#state.stopped) throw new BudgetRefusal(this.#state.stopped.reason);
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

  // Meters one response body. `declare` refuses a declared length over the
  // per-response cap; `take` credits an arrived chunk up to the first cap it
  // reaches, then refuses rather than accepting bytes beyond that boundary.
  // `settle` makes the credited bytes durable, even after a refusal.
  ingressMeter() {
    const { responseBytes, ingress } = this.#state.profile;
    let taken = 0, settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      if (taken) await this.#serial(() => {
        this.#ingressInflight -= taken;
        return this.#reserve({ ingress: taken }, { received: true });
      });
    };
    const refuse = async reason => {
      try { await settle(); }
      finally { await this.#stopNow(reason).catch(() => {}); }
      throw new BudgetRefusal(reason);
    };
    return {
      declare: async length => { if (Number.isFinite(length) && length > responseBytes) await refuse('response-oversize'); },
      take: async bytes => {
        if (this.#state.stopped) throw new BudgetRefusal(this.#state.stopped.reason);
        const responseRemaining = responseBytes - taken;
        const ingressRemaining = ingress - this.#state.spent.ingress - this.#ingressInflight;
        const credited = Math.max(0, Math.min(bytes, responseRemaining, ingressRemaining));
        taken += credited; this.#ingressInflight += credited;
        if (bytes > responseRemaining) await refuse('response-oversize');
        if (bytes > ingressRemaining) await refuse('ingress-exhausted');
      },
      settle,
    };
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
      const size = (await stat(join(this.evidenceDir, source))).size;
      await this.#reserve({ file: 1, byte: size });
      await copyFile(join(this.evidenceDir, source), join(this.evidenceDir, destination), constants.COPYFILE_EXCL);
      return destination;
    });
  }

  // Copies one evidence file out to a report directory, charged as a file.
  async exportEvidence(name, destination) {
    return this.#serial(async () => {
      this.#reserveName(name);
      const size = (await stat(join(this.evidenceDir, name))).size;
      await this.#reserve({ file: 1, byte: size });
      await copyFile(join(this.evidenceDir, name), destination, constants.COPYFILE_EXCL);
      return destination;
    });
  }

  // Charges files a third-party writer (the exploration runner) already put
  // under this run's evidence directory. Over quota, the run stops.
  async admitWritten(relativeDir) {
    const sizes = [];
    const walk = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else sizes.push((await lstat(full)).size);
      }
    };
    await walk(join(this.evidenceDir, relativeDir)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const size of sizes) await this.#serial(() => this.#reserve({ file: 1, byte: size }));
    return sizes.length;
  }

  // The worst-case screenshot size is reserved before capture, so the
  // temporary buffer is inside the quota; an oversized capture is never written.
  async captureScreenshot(page, name, { type = 'jpeg', fullPage = false } = {}) {
    const { screenshotBytes } = this.#state.profile;
    await this.#serial(async () => { this.#reserveName(name); await this.#reserve({ screenshot: 1, file: 1, byte: screenshotBytes }); });
    const image = await page.screenshot({ type, ...(type === 'jpeg' ? { quality: 60 } : {}), fullPage, animations: 'disabled', timeout: this.timeoutMs() });
    if (image.length > screenshotBytes) { await this.#stopNow('screenshot-oversize'); throw new BudgetRefusal('screenshot-oversize'); }
    this.throwIfStopped();
    await this.#writeEvidenceFile(name, image);
    return name;
  }

  async log(line) {
    const text = Buffer.from(String(line).replace(/\n/g, ' ') + '\n');
    return this.#serial(async () => {
      await this.#reserve(this.#log ? { logByte: text.length, byte: text.length } : { logByte: text.length, byte: text.length, file: 1 });
      if (!this.#log) {
        await mkdir(join(this.#dir, 'logs'), { recursive: true, mode: 0o700 });
        this.#log = await open(join(this.#dir, 'logs', this.#state.run_id + '.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      }
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

  // `final` spends the receipt's held-back headroom; `received` records bytes
  // that already arrived (checked in memory as they streamed), even if the run
  // has since stopped.
  async #reserve(debit, { final = false, received = false } = {}) {
    if (this.#closed) throw new BudgetRefusal('closed');
    const wasStopped = Boolean(this.#state.stopped);
    if (!wasStopped && !received && this.#clock.now() >= this.#state.deadline_at) await this.#stopNow('deadline');
    if (!wasStopped && !received && await exists(join(this.#dir, 'STOP'))) await this.#stopNow('operator-stop');
    if (this.#state.stopped && !final && !received) throw new BudgetRefusal(wasStopped ? 'stopped' : this.#state.stopped.reason);
    const { profile, spent } = this.#state;
    // Evidence quotas hold back room for the one bounded receipt.
    const headroom = final || received ? {} : { byte: this.#receiptReserve(), file: 1 };
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

  // State first, then the signed ledger checkpoint, so the durable state is
  // never behind the ledger a later open compares it against.
  #persist() {
    const state = structuredClone(this.#state);
    const write = this.#writeChain.then(async () => {
      await writePrivate(join(this.#dir, 'state.json'), signedState(this.#key, state), { replace: true });
      this.#head = await appendEntry(this.#dir, this.#key, this.#head, {
        type: 'checkpoint', run_id: state.run_id, at: this.#clock.now(), started_at: state.started_at, spent: state.spent, stopped: state.stopped,
      });
    });
    this.#writeChain = write.catch(() => {});
    return write;
  }

  async #writeEvidenceFile(name, bytes) {
    await mkdir(this.evidenceDir, { recursive: true, mode: 0o700 });
    await writePrivate(join(this.evidenceDir, name), bytes);
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

  // The abort always happens, even when the disk refuses the stop record; the
  // write error still reaches a caller that awaits the stop.
  async #stopNow(reason) {
    try {
      if (!this.#state.stopped) {
        this.#state.stopped = { reason, at: this.#clock.now() };
        await this.#persist();
      }
    } finally {
      if (!this.#halted) {
        this.#halted = true;
        this.#clearTimers();
        this.#controller.abort();
        for (const waiter of this.#waiters.splice(0)) waiter.reject(new BudgetRefusal('stopped'));
        const hooks = [...this.#hooks];
        this.#hooks.clear();
        await Promise.allSettled(hooks.map(hook => Promise.resolve().then(hook)));
      }
    }
  }

  #clearTimers() {
    if (this.#deadlineTimer !== undefined) this.#clock.clearTimeout(this.#deadlineTimer);
    if (this.#stopPoll !== undefined) this.#clock.clearInterval(this.#stopPoll);
  }

  async #release() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    if (this.#log) { await this.#log.close().catch(() => {}); this.#log = null; }
    await this.#writeChain;
    if (activeBudget() === this) setActiveBudget(null);
    await releaseLock(this.#lock);
  }
}

// The command line: a human authorizes one run, or anyone places a stop.
// There is no reset, no limit flag and no directory flag.
export function parseBudgetCommand(argv) {
  const [command, ...rest] = argv;
  if (command === 'stop' && rest.length) return { command, reason: rest.join(' ') };
  if (command === 'authorize' && rest.length === 4) {
    const options = {};
    for (let index = 0; index < 4; index += 2) {
      if (!['--profile', '--reason'].includes(rest[index]) || Object.hasOwn(options, rest[index])) throw new BudgetRefusal('arguments-refused');
      options[rest[index]] = rest[index + 1];
    }
    return { command, profile: options['--profile'], reason: options['--reason'] };
  }
  throw new BudgetRefusal('arguments-refused');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const parsed = parseBudgetCommand(process.argv.slice(2));
    if (parsed.command === 'stop') {
      await requestOperatorStop(BUDGET_DIR, parsed.reason);
      console.log('Operator stop recorded at ' + join(BUDGET_DIR, 'STOP'));
      return;
    }
    console.log(describeAuthorization(await authorizeRun({ profile: parsed.profile, reason: parsed.reason })));
  }).catch(error => { console.error(error instanceof BudgetRefusal ? error.message : 'E2E run budget command failed'); process.exitCode = 1; });
}
