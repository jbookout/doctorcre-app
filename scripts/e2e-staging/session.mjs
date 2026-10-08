import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as playwrightRequest } from 'playwright';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { stagingAuth } from './auth-contract.mjs';

export const STAGING_ORIGIN = contract.origin;
export const SECRET_PATH = join(homedir(), '.config/carr/e2e-session-secret');
export const STAGING_STORAGE_STATE = fileURLToPath(new URL('../../.e2e/staging-private/storage-state.json', import.meta.url));

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

export async function stagingRelease(api, baseURL = STAGING_ORIGIN) {
  const origin = assertStagingURL(baseURL);
  try {
    const release = await api.get('/app-release', { maxRedirects: 0 });
    const identity = release.ok() ? await release.json() : {};
    if (identity.environment !== 'staging' || identity.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(identity.source_commit || '')) throw new Error('staging release identity was not confirmed');
    const carrRelease = await api.get(`${contract.carr_origin}/release`, { maxRedirects: 0 });
    const carr = carrRelease.ok() ? await carrRelease.json() : {};
    if (carr.env?.value !== 'staging' || carr.git_sha?.value !== contract.producer.source_commit) throw new Error('staging CARR release differs from the pinned E2E session contract');
    return { ...identity, carr_source_commit: contract.producer.source_commit };
  } catch (error) {
    if (/^staging /.test(error.message)) throw new Error(error.message);
    throw new Error('staging release preflight failed; no credential or provider payload was logged');
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
  const api = requestContext || await playwrightRequest.newContext({ baseURL: origin, timeout: 30_000 });
  try {
    const release = await stagingRelease(api, origin);
    if (exchange) {
      const secret = await readSessionSecret();
      const response = await api.fetch(stagingAuth.exchange.path, stagingAuth.exchange.request(secret));
      if (!response.ok()) throw new Error(`staging E2E session exchange refused (${response.status()}); provision the staging route and secret`);
    }
    const session = await api.get(stagingAuth.session.path, { maxRedirects: 0 });
    const actor = session.ok() ? await session.json() : {};
    if (!stagingAuth.session.matches(actor)) throw new Error('staging session did not authenticate the dedicated E2E partner');
    const state = storageStatePath ? await writeStagingStorageState(api, storageStatePath) : await api.storageState();
    if (!stagingAuth.session.hasSecureCookie(state.cookies)) throw new Error('staging exchange did not set the normal secure session cookie');
    return { state, release };
  } catch (error) {
    // Provider error objects can carry request headers. Only our own bounded messages escape.
    if (/^staging |^E2E /.test(error.message)) throw new Error(error.message);
    throw new Error('staging session preflight failed; no credential or provider payload was logged');
  } finally { if (!requestContext) await api.dispose(); }
}
