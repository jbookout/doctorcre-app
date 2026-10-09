import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as playwrightRequest } from 'playwright';
import { stagingAuth } from './auth-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export const STAGING_ORIGIN = contract.origin;
export const STAGING_STORAGE_STATE = fileURLToPath(new URL('../../.e2e/staging-private/storage-state.json', import.meta.url));
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

export async function preflightRequest(phase, operation, { pause = delay } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await operation();
      if (![429, 502, 503, 504].includes(response.status())) return response;
      if (attempt === 2) throw new SessionPreflightFailure(phase + '-http-' + response.status());
    } catch (error) {
      if (error instanceof SessionPreflightFailure) throw error;
      if (attempt === 2) throw new SessionPreflightFailure(phase + '-transport-failed');
    }
    await pause(250 * (attempt + 1));
  }
}

export async function stagingRelease(api, baseURL = STAGING_ORIGIN) {
  assertStagingURL(baseURL);
  let phase = 'app-release';
  try {
    phase = 'app-release';
    const release = await preflightRequest(phase, () => api.get('/app-release', { maxRedirects: 0 }));
    const identity = release.ok() ? await release.json() : {};
    if (identity.environment !== 'staging' || identity.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(identity.source_commit || ''))
      throw new SessionPreflightFailure('app-release-invalid');
    phase = 'carr-release';
    const carrRelease = await preflightRequest(phase, () => api.get(contract.carr_origin + '/release', { maxRedirects: 0 }));
    const carr = carrRelease.ok() ? await carrRelease.json() : {};
    if (carr.env?.value !== 'staging' || carr.git_sha?.value !== contract.producer.source_commit)
      throw new SessionPreflightFailure('carr-source-pair-refused');
    return { ...identity, carr_source_commit: contract.producer.source_commit };
  } catch (error) {
    if (error instanceof SessionPreflightFailure) throw error;
    throw new SessionPreflightFailure(phase + '-failed');
  }
}

export async function writeStagingStorageState(api, path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const state = await api.storageState({ path });
  await chmod(path, 0o600);
  return state;
}

export async function stagingSession(baseURL = STAGING_ORIGIN, { requestContext, storageStatePath, exchange = true } = {}) {
  const origin = assertStagingURL(baseURL);
  let api, phase = 'context';
  try {
    api = requestContext || await playwrightRequest.newContext({ baseURL: origin, timeout: 30_000 });
    const release = await stagingRelease(api, origin);
    if (exchange) {
      phase = 'secret';
      const secret = await readSessionSecret();
      phase = 'session-exchange';
      const response = await preflightRequest(phase, () => api.fetch(stagingAuth.exchange.path, stagingAuth.exchange.request(secret)));
      if (!response.ok()) throw new SessionPreflightFailure('session-exchange-refused-' + response.status());
    }
    phase = 'session-confirm';
    const session = await preflightRequest(phase, () => api.get(stagingAuth.session.path, { maxRedirects: 0 }));
    const actor = session.ok() ? await session.json() : {};
    if (!stagingAuth.session.matches(actor)) throw new SessionPreflightFailure('dedicated-principal-refused');
    phase = 'cookie';
    const state = storageStatePath ? await writeStagingStorageState(api, storageStatePath) : await api.storageState();
    if (!stagingAuth.session.hasSecureCookie(state.cookies)) throw new SessionPreflightFailure('secure-cookie-refused');
    return { state, release };
  } catch (error) {
    if (error instanceof SessionPreflightFailure) throw error;
    // Never forward a provider error: request objects can include credentials.
    throw new SessionPreflightFailure(phase + '-failed');
  } finally { if (api && !requestContext) await api.dispose().catch(() => { throw new SessionPreflightFailure('context-dispose-failed'); }); }
}
