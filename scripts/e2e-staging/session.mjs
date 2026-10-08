import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as playwrightRequest } from 'playwright';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { stagingAuth } from './auth-contract.mjs';

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

export async function stagingSession(baseURL = STAGING_ORIGIN) {
  const origin = assertStagingURL(baseURL);
  const api = await playwrightRequest.newContext({ baseURL: origin, timeout: 30_000 });
  try {
    const release = await api.get('/app-release', { maxRedirects: 0 });
    const identity = release.ok() ? await release.json() : {};
    if (identity.environment !== 'staging' || identity.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(identity.source_commit || '')) throw new Error('staging release identity was not confirmed');
    const carrRelease = await api.get(`${contract.carr_origin}/release`, { maxRedirects: 0 });
    const carr = carrRelease.ok() ? await carrRelease.json() : {};
    if (carr.env?.value !== 'staging' || carr.git_sha?.value !== contract.producer.source_commit) throw new Error('staging CARR release differs from the pinned E2E session contract');
    const secret = await readSessionSecret();
    const response = await api.fetch(stagingAuth.exchange.path, stagingAuth.exchange.request(secret));
    if (!response.ok()) throw new Error(`staging E2E session exchange refused (${response.status()}); provision the staging route and secret`);
    const session = await api.get(stagingAuth.session.path, { maxRedirects: 0 });
    const actor = session.ok() ? await session.json() : {};
    if (!stagingAuth.session.matches(actor)) throw new Error('staging session did not authenticate the dedicated E2E partner');
    const state = await api.storageState();
    if (!stagingAuth.session.hasSecureCookie(state.cookies)) throw new Error('staging exchange did not set the normal secure session cookie');
    return { state, release: { ...identity, carr_source_commit: contract.producer.source_commit } };
  } catch (error) {
    // Provider error objects can carry request headers. Only our own bounded messages escape.
    if (/^staging |^E2E /.test(error.message)) throw new Error(error.message);
    throw new Error('staging session preflight failed; no credential or provider payload was logged');
  } finally { await api.dispose(); }
}
