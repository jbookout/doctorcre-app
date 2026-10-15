import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStagingContextCoverage } from './engine.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { createStagingRequestContext, stagingSession, STAGING_ORIGIN } from './session.mjs';
import { requireSupervisedRun } from './run-limits.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const pending = reason => ({ state: 'pending', reason, independent_cookie: false, independent_csrf: false,
  signed_in_ui: false, dedicated_signout: false, old_session_rejected: false, parent_session_retained: false,
  signed_out_ui: false });

function exactCookie(state) {
  const host = new URL(STAGING_ORIGIN).hostname;
  const matches = state?.cookies?.filter(cookie => cookie?.name === contract.session.cookie &&
    cookie.domain === host && cookie.path === '/' && cookie.secure === true && cookie.httpOnly === true &&
    typeof cookie.value === 'string' && cookie.value.length >= 32) || [];
  return matches.length === 1 ? matches[0].value : null;
}

function timeout(run) {
  run.check();
  return Math.max(1, Math.min(run.limits.httpTimeoutMs, run.deadline - Date.now()));
}

async function parentWitness(page) {
  return page.evaluate(async () => {
    const read = async path => {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      return response.ok ? response.json() : null;
    };
    const [release, session, actor] = await Promise.all([
      read('/app-release'), read('/auth/session'), read('/api/system-work/session'),
    ]);
    const csrf = session?.csrf_token;
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { release: release && { service: release.service, environment: release.environment,
      source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    actor: session?.actor?.slug, principal: session?.e2e_principal, systemActor: actor?.actor?.slug,
    csrfDigest: typeof csrf === 'string' && csrf.length >= 16 && actor?.csrf_token === csrf ? await hash(csrf) : null };
  });
}

function matchesSource(value, release) {
  return value?.service === 'doctorcre-app' && value.environment === 'staging' &&
    value.source_commit === release.source_commit &&
    (value.carr_source_commit === undefined || value.carr_source_commit === contract.producer.source_commit);
}

const staticRead = path => path === '/' || path === '/manifest.webmanifest' || path === '/sw.js' ||
  path === '/favicon.ico' || /^\/(?:js|css|public-shell|data|vendor)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path)
  && !path.split('/').includes('..');

function cookieHeaderMatches(value, expected) {
  return typeof value === 'string' && value.split(';').some(part => {
    const separator = part.indexOf('=');
    return separator >= 0 && part.slice(0, separator).trim() === contract.session.cookie &&
      part.slice(separator + 1).trim() === expected;
  });
}

async function installAuthGuard(context, run, dedicatedCookie, dedicatedCsrf, signout) {
  let armed = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const method = request.method(), path = url.pathname;
    const allowed = url.origin === STAGING_ORIGIN && !url.search && !url.hash &&
      (method === 'GET' && (staticRead(path) || ['/app-release', '/auth/session', '/api/system-work/session'].includes(path)) ||
        method === 'POST' && path === '/auth/signout' && armed && !signout.started);
    if (!allowed) {
      if (method === 'POST' && path === '/auth/signout') { signout.refused = true; signout.settle?.(); }
      await route.abort(); return;
    }
    if (method === 'POST') {
      const headers = await request.allHeaders();
      if (!cookieHeaderMatches(headers.cookie, dedicatedCookie) || headers['x-carr-csrf'] !== dedicatedCsrf ||
          headers.origin !== STAGING_ORIGIN || headers['sec-fetch-site'] !== 'same-origin' || request.postData()) {
        signout.refused = true;
        signout.settle?.();
        await route.abort();
        return;
      }
      signout.started = true;
    }
    try {
      const response = await run.http(() => route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: timeout(run) }));
      const status = response.status(), location = response.headers()['location'];
      if (method === 'POST') {
        signout.completed = status === 302 && new URL(location || '/', STAGING_ORIGIN).href === `${STAGING_ORIGIN}/`;
        signout.settle?.();
      }
      if (status >= 300 && status < 400 && !(method === 'POST' && signout.completed)) {
        await route.abort(); return;
      }
      await route.fulfill({ response });
    } catch {
      if (method === 'POST') signout.settle?.();
      await route.abort();
    }
  });
  return { arm: () => { armed = true; } };
}

async function boundedSession(api) {
  const response = await api.get(stagingAuth.session.path, { maxRedirects: 0 });
  if (!response.ok()) return null;
  const session = await response.json();
  const actor = await api.get('/api/system-work/session', { maxRedirects: 0 });
  if (!actor.ok()) return null;
  const system = await actor.json();
  return stagingAuth.session.matches(session) && system?.actor?.slug === contract.session.actor_slug &&
    typeof session.csrf_token === 'string' && session.csrf_token.length >= 16 &&
    system.csrf_token === session.csrf_token ? session.csrf_token : null;
}

// The exchange uses the existing private mode-600 secret reader. The browser
// receives a separate cookie jar, and its only admitted write is its own
// CSRF-bound signout. No state or token is returned to the caller.
export async function qualifySessionJourney({ parentPage, release, run, browser = parentPage?.context?.()?.browser?.(),
  exchange = stagingSession, requestContext = createStagingRequestContext } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  if (!parentPage || !browser?.newContext || !commit(release?.source_commit) ||
      release?.carr_source_commit !== contract.producer.source_commit ||
      release.service !== 'doctorcre-app' || release.environment !== 'staging' ||
      new URL(parentPage.url()).origin !== STAGING_ORIGIN)
    return pending('session-source-or-browser-unavailable');
  await assertStagingContextCoverage(parentPage.context());
  let parentCookie, parent, state, context, api, oldApi;
  const signout = { started: false, completed: false, refused: false, settle: null };
  let removeStop = () => {};
  try {
    parentCookie = exactCookie(await parentPage.context().storageState());
    parent = await parentWitness(parentPage);
    if (!parentCookie || !matchesSource(parent?.release, release) ||
      parent.actor !== contract.session.actor_slug || parent.principal !== contract.session.e2e_principal ||
      parent.systemActor !== contract.session.actor_slug || !parent.csrfDigest)
      return pending('parent-session-proof-unavailable');
    const minted = await exchange(STAGING_ORIGIN, { run, signal: run.signal });
    state = minted?.state;
    const dedicatedCookie = exactCookie(state);
    if (!matchesSource(minted?.release, release) || minted.release.carr_source_commit !== contract.producer.source_commit ||
        !dedicatedCookie || dedicatedCookie === parentCookie)
      return pending('independent-cookie-unproved');
    api = await requestContext({ baseURL: STAGING_ORIGIN, storageState: state, run });
    const csrf = await boundedSession(api);
    if (!csrf || digest(csrf) === parent.csrfDigest)
      return { ...pending('independent-csrf-unproved'), independent_cookie: true };
    context = await browser.newContext({ storageState: state, serviceWorkers: 'block' });
    if (context === parentPage.context()) return { ...pending('independent-browser-context-unproved'), independent_cookie: true, independent_csrf: true };
    removeStop = run.onStop(() => context.close());
    const guard = await installAuthGuard(context, run, dedicatedCookie, csrf, signout);
    const page = await context.newPage();
    const navigation = await page.goto(`${STAGING_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: timeout(run) });
    if (!navigation?.ok() || new URL(page.url()).origin !== STAGING_ORIGIN) return pending('dedicated-signed-in-ui-unavailable');
    await page.locator('#selfAvatar').waitFor({ state: 'visible', timeout: timeout(run) });
    if (await page.locator('#selfAvatar').getAttribute('aria-label') !== 'Joe: account and settings')
      return pending('dedicated-signed-in-ui-unavailable');
    await page.locator('#selfAvatar').click({ timeout: timeout(run) });
    await page.locator('#accountSignOut').waitFor({ state: 'visible', timeout: timeout(run) });
    const freshRelease = await api.get('/app-release', { maxRedirects: 0 });
    if (!freshRelease.ok() || !matchesSource(await freshRelease.json(), release))
      return { ...pending('fresh-source-pair-unavailable'), independent_cookie: true, independent_csrf: true,
        signed_in_ui: true };
    const stillParent = await parentWitness(parentPage);
    if (!matchesSource(stillParent?.release, release) || stillParent.actor !== contract.session.actor_slug ||
        stillParent.principal !== contract.session.e2e_principal || stillParent.systemActor !== contract.session.actor_slug ||
        stillParent.csrfDigest !== parent.csrfDigest)
      return { ...pending('parent-session-before-signout-unavailable'), independent_cookie: true,
        independent_csrf: true, signed_in_ui: true };
    const afterSignout = new Promise(resolve => { signout.settle = resolve; });
    guard.arm();
    await page.locator('#accountSignOut').click({ timeout: timeout(run) });
    const timer = new AbortController();
    try { await Promise.race([afterSignout, delay(timeout(run), undefined, { signal: timer.signal })]); }
    finally { timer.abort(); }
    if (!signout.completed || signout.refused) return { ...pending('dedicated-signout-unproved'),
      independent_cookie: true, independent_csrf: true, signed_in_ui: true };
    oldApi = await requestContext({ baseURL: STAGING_ORIGIN, storageState: state, run });
    const old = await oldApi.get(stagingAuth.session.path, { maxRedirects: 0 });
    const oldRejected = old.status() === 401;
    const after = await parentWitness(parentPage);
    const parentRetained = matchesSource(after?.release, release) && after.actor === contract.session.actor_slug &&
      after.principal === contract.session.e2e_principal && after.systemActor === contract.session.actor_slug &&
      after.csrfDigest === parent.csrfDigest;
    // The app displays the signed-out view only after /auth/session rejects
    // the browser's cookie. /auth/login remains the real OAuth entry link.
    let signedOutUi = false;
    try {
      await page.waitForFunction(origin => location.origin === origin && location.pathname === '/' &&
        document.querySelector('main.app-shell-signed-out > h1')?.textContent?.trim() === 'Signed out' &&
        document.querySelector('main.app-shell-signed-out > a')?.getAttribute('href') === '/auth/login' &&
        !document.querySelector('#selfAvatar'), STAGING_ORIGIN,
      { polling: 'raf', timeout: Math.min(2_000, timeout(run)) });
      signedOutUi = true;
    } catch { run.check(); }
    return { state: oldRejected && parentRetained && signedOutUi ? 'qualified' : 'pending',
      reason: !oldRejected ? 'old-dedicated-session-not-rejected' : !parentRetained ? 'parent-session-not-retained'
        : !signedOutUi ? 'signed-out-ui-unavailable' : 'isolated-session-lifecycle-proved',
      independent_cookie: true, independent_csrf: true, signed_in_ui: true,
      dedicated_signout: true, old_session_rejected: oldRejected, parent_session_retained: parentRetained,
      signed_out_ui: signedOutUi };
  } catch {
    run.check();
    return pending('dedicated-session-proof-unavailable');
  } finally {
    removeStop();
    await context?.close().catch(() => {});
    await oldApi?.dispose().catch(() => {});
    await api?.dispose().catch(() => {});
  }
}
