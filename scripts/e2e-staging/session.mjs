import { boundedRequestContext, requireSupervisedRun, effectiveRunLimits, RunLimitError } from './run-limits.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import { chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as playwrightRequest } from 'playwright';
import { stagingAuth } from './auth-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export const STAGING_ORIGIN = contract.origin;
export const STAGING_STORAGE_STATE = process.env.E2E_RUN_SUPERVISED === '1' ? join(process.env.E2E_V2_OUTPUT, 'private', 'storage-state.json') : fileURLToPath(new URL('../../.e2e/staging-private/storage-state.json', import.meta.url));
export const SECRET_PATH = join(homedir(), '.config/carr/e2e-session-secret');

export function assertStagingURL(value) {
  const url = new URL(value);
  if (url.origin !== STAGING_ORIGIN || url.username || url.password) throw new Error('staging-live requires the exact isolated DoctorCRE staging origin');
  return url.origin;
}

// All staging API contexts, including supplied contexts, enter through this factory.
// The outer proxy rechecks admission when used; the inner proxy owns HTTP accounting.
const stagingContexts = new WeakMap();
export async function createStagingRequestContext({
  baseURL = STAGING_ORIGIN, requestContext, requestFactory = options => playwrightRequest.newContext(options),
  storageState, run,
} = {}) {
  const origin = assertStagingURL(baseURL);
  run = requireSupervisedRun(undefined, run);
  if (requestContext && stagingContexts.get(requestContext)?.run === run) return stagingContexts.get(requestContext).proxy;
  const raw = requestContext || await requestFactory({ baseURL: origin, timeout: run.limits.httpTimeoutMs, ...(storageState === undefined ? {} : { storageState }) });
  try { requireSupervisedRun(undefined, run); }
  catch (error) { if (!requestContext) await raw.dispose().catch(() => {}); throw error; }
  const bounded = boundedRequestContext(raw, run);
  const proxy = new Proxy(bounded, { get(target, key) {
    const value = target[key];
    if (['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head', 'storageState'].includes(key)) return (...args) => {
      requireSupervisedRun(undefined, run);
      return value(...args);
    };
    return value;
  } });
  stagingContexts.set(raw, { run, proxy });
  stagingContexts.set(proxy, { run, proxy });
  return proxy;
}

export async function readSessionSecret(path = process.env.E2E_SESSION_SECRET_FILE || SECRET_PATH) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('E2E session secret requires a regular mode 600 file');
    const value = (await handle.readFile('utf8')).trim();
    if (value.length < 32) throw new Error('E2E session secret is missing or too short');
    return value;
  } finally { await handle.close(); }
}

export class SessionPreflightFailure extends Error {
  constructor(code, carr) {
    super('staging session preflight failed: ' + code + (carr ? ` (carr env=${carr.env}; git_sha=${carr.git_sha})` : ''));
    this.code = code;
    if (carr) this.carr = carr;
  }
}

const CARR_FLOOR = contract.producer.source_commit;
const CARR_COMPARE = 'https://api.github.com/repos/jbookout/carr-system/compare/';
// GitHub's verdict on a pushed commit does not change, so each process asks once per commit.
const admittedCarrCommits = new Set([CARR_FLOOR]);

const presentedCarr = carr => ({
  env: /^[a-z0-9_-]{1,32}$/.test(carr?.env?.value ?? '') ? carr.env.value : 'unrecognized',
  git_sha: /^[0-9a-f]{40}$/.test(carr?.git_sha?.value ?? '') ? carr.git_sha.value : 'malformed',
});

async function containedBy(api, base, head) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await api.get(CARR_COMPARE + base + '...' + head + '?per_page=1', { headers: {
    accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  const status = response.status() === 200 ? (await response.json())?.status : undefined;
  if (!['ahead', 'identical', 'behind', 'diverged'].includes(status)) throw new Error('compare-unavailable');
  return status === 'ahead' || status === 'identical';
}

// The contract pin is a floor: staging may run it or any later carr-system main commit.
async function admitCarrRelease(api, carr) {
  const presented = presentedCarr(carr);
  if (carr?.env?.value !== 'staging') throw new SessionPreflightFailure('carr-env-mismatch', presented);
  if (presented.git_sha === 'malformed') throw new SessionPreflightFailure('carr-commit-malformed', presented);
  if (admittedCarrCommits.has(presented.git_sha)) return presented.git_sha;
  let onMain, descendsFromFloor;
  try {
    onMain = await containedBy(api, presented.git_sha, 'main');
    descendsFromFloor = await containedBy(api, CARR_FLOOR, presented.git_sha);
  } catch (error) {
    if (error instanceof RunLimitError) throw error;
    throw new SessionPreflightFailure('carr-ancestry-unverifiable', presented);
  }
  if (!onMain) throw new SessionPreflightFailure('carr-commit-not-on-main', presented);
  if (!descendsFromFloor) throw new SessionPreflightFailure('carr-commit-older-than-floor', presented);
  admittedCarrCommits.add(presented.git_sha);
  return presented.git_sha;
}

export async function preflightRequest(phase, operation, { pause = delay, signal, run } = {}) {
  const limits = effectiveRunLimits(run);
  for (let attempt = 0; attempt < limits.preflightAttempts; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await operation();
      if (![429, 502, 503, 504].includes(response.status())) return response;
      if (attempt === limits.preflightAttempts - 1) throw new SessionPreflightFailure(phase + '-http-' + response.status());
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SessionPreflightFailure || error instanceof RunLimitError) throw error;
      if (attempt === limits.preflightAttempts - 1) throw new SessionPreflightFailure(phase + '-transport-failed');
    }
    await pause(250 * (attempt + 1), undefined, { signal });
  }
}

export async function stagingRelease(api, baseURL = STAGING_ORIGIN, { run, signal } = {}) {
  assertStagingURL(baseURL);
  signal?.throwIfAborted();
  run = requireSupervisedRun(undefined, run);
  signal ??= run.signal;
  api = await createStagingRequestContext({ requestContext: api, baseURL, run });
  let phase = 'app-release';
  try {
    phase = 'app-release';
    const release = await preflightRequest(phase, () => api.get('/app-release', { maxRedirects: 0 }), { signal, run });
    const identity = release.ok() ? await release.json() : {};
    if (identity.environment !== 'staging' || identity.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(identity.source_commit || ''))
      throw new SessionPreflightFailure('app-release-invalid');
    phase = 'carr-release';
    const carrRelease = await preflightRequest(phase, () => api.get(contract.carr_origin + '/release', { maxRedirects: 0 }), { signal, run });
    const carr = carrRelease.ok() ? await carrRelease.json() : {};
    const carrCommit = await admitCarrRelease(api, carr);
    return { ...identity, carr_source_commit: CARR_FLOOR, carr_release_commit: carrCommit };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SessionPreflightFailure || error instanceof RunLimitError) throw error;
    throw new SessionPreflightFailure(phase + '-failed');
  }
}

export async function writeStagingStorageState(api, path, run) {
  run = requireSupervisedRun(undefined, run);
  api = await createStagingRequestContext({ requestContext: api, run });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const state = await api.storageState();
  const data = JSON.stringify(state);
  await run.writeFile(path, data, (target, value) => writeFile(target, value, { mode: 0o600 }));
  await chmod(path, 0o600);
  return state;
}

export async function stagingSession(baseURL = STAGING_ORIGIN, { requestContext, storageStatePath, exchange = true, run, signal } = {}) {
  const origin = assertStagingURL(baseURL);
  run = requireSupervisedRun(undefined, run);
  signal ??= run.signal;
  signal.throwIfAborted();
  let api, phase = 'context';
  try {
    api = await createStagingRequestContext({ baseURL: origin, requestContext, run });
    const release = await stagingRelease(api, origin, { signal, run });
    if (exchange) {
      phase = 'secret';
      signal?.throwIfAborted();
      const secret = await readSessionSecret();
      phase = 'session-exchange';
      const response = await preflightRequest(phase, () => api.fetch(stagingAuth.exchange.path, stagingAuth.exchange.request(secret)), { signal, run });
      if (!response.ok()) throw new SessionPreflightFailure('session-exchange-refused-' + response.status());
    }
    phase = 'session-confirm';
    const session = await preflightRequest(phase, () => api.get(stagingAuth.session.path, { maxRedirects: 0 }), { signal, run });
    const actor = session.ok() ? await session.json() : {};
    if (!stagingAuth.session.matches(actor)) throw new SessionPreflightFailure('dedicated-principal-refused');
    signal?.throwIfAborted();
    phase = 'cookie';
    const state = storageStatePath ? await writeStagingStorageState(api, storageStatePath, run) : await api.storageState();
    if (!stagingAuth.session.hasSecureCookie(state.cookies)) throw new SessionPreflightFailure('secure-cookie-refused');
    return { state, release };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SessionPreflightFailure || error instanceof RunLimitError) throw error;
    // Never forward a provider error: request objects can include credentials.
    throw new SessionPreflightFailure(phase + '-failed');
  } finally { if (api && !requestContext) await api.dispose().catch(() => { throw new SessionPreflightFailure('context-dispose-failed'); }); }
}
