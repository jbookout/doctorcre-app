import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as playwrightRequest } from 'playwright';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { BudgetRefusal } from './run-budget.mjs';

export const STAGING_ORIGIN = contract.origin;
export const SECRET_PATH = join(homedir(), '.config/carr/e2e-session-secret');

export function assertStagingURL(value) {
  const url = new URL(value);
  if (url.origin !== STAGING_ORIGIN || url.username || url.password) throw new Error('staging-live requires the exact isolated DoctorCRE staging origin');
  return url.origin;
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
  constructor(code) { super('staging session preflight failed: ' + code); this.code = code; }
}

// Retries are a budget property: each attempt is its own debited dispatch, and
// the approved Home smoke allows none (attempts = retries + 1 = 1).
export async function preflightRequest(phase, operation, { pause = delay, attempts = 1 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await operation();
      if (![429, 502, 503, 504].includes(response.status())) return response;
      if (attempt >= attempts) throw new SessionPreflightFailure(phase + '-http-' + response.status());
    } catch (error) {
      if (error instanceof SessionPreflightFailure || error instanceof BudgetRefusal) throw error;
      if (attempt >= attempts) throw new SessionPreflightFailure(phase + '-transport-failed');
    }
    await pause(250 * attempt);
  }
}

// Every preflight request is reserved against the run budget before it is
// sent. A caller without a budget is unsupported ingress and refuses.
export async function stagingSession(baseURL = STAGING_ORIGIN, {
  budget, requestFactory = options => playwrightRequest.newContext(options), readSecret = readSessionSecret,
} = {}) {
  if (!budget) throw new BudgetRefusal('http-not-budgeted');
  const origin = assertStagingURL(baseURL);
  const attempts = budget.profile.retries + 1;
  const preflight = (phase, send) => preflightRequest(phase, () => budget.dispatch('preflight', send), { attempts });
  let api, phase = 'context';
  try {
    api = await requestFactory({ baseURL: origin, timeout: budget.timeoutMs() });
    phase = 'app-release';
    const release = await preflight(phase, () => api.get('/app-release', { maxRedirects: 0 }));
    const identity = release.ok() ? await release.json() : {};
    if (identity.environment !== 'staging' || identity.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(identity.source_commit || ''))
      throw new SessionPreflightFailure('app-release-invalid');
    phase = 'carr-release';
    const carrRelease = await preflight(phase, () => api.get(contract.carr_origin + '/release', { maxRedirects: 0 }));
    const carr = carrRelease.ok() ? await carrRelease.json() : {};
    if (carr.env?.value !== 'staging' || carr.git_sha?.value !== contract.producer.source_commit)
      throw new SessionPreflightFailure('carr-source-pair-refused');
    phase = 'secret';
    const secret = await readSecret();
    phase = 'session-exchange';
    const response = await preflight(phase, () => api.post('/auth/e2e-session', { headers: { authorization: 'Bearer ' + secret }, maxRedirects: 0 }));
    if (!response.ok()) throw new SessionPreflightFailure('session-exchange-refused-' + response.status());
    phase = 'session-confirm';
    const session = await preflight(phase, () => api.get('/auth/session', { maxRedirects: 0 }));
    const actor = session.ok() ? await session.json() : {};
    if (actor.actor?.slug !== 'joe' || actor.e2e_principal !== 'e2e-joe') throw new SessionPreflightFailure('dedicated-principal-refused');
    phase = 'cookie';
    const state = await api.storageState();
    if (!state.cookies.some(cookie => cookie.name === '__Host-dealroom_session' && cookie.httpOnly && cookie.secure))
      throw new SessionPreflightFailure('secure-cookie-refused');
    return { state, release: { ...identity, carr_source_commit: contract.producer.source_commit } };
  } catch (error) {
    if (error instanceof SessionPreflightFailure || error instanceof BudgetRefusal) throw error;
    // Never forward a provider error: request objects can include credentials.
    throw new SessionPreflightFailure(phase + '-failed');
  } finally { if (api) await api.dispose().catch(() => { throw new SessionPreflightFailure('context-dispose-failed'); }); }
}
