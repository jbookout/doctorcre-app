import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installStagingGuard } from '../../scripts/e2e-staging/engine.mjs';
import { openRun, RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';
import { qualifySessionJourney } from '../../scripts/e2e-staging/session-journey.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40),
  carr_source_commit: contract.producer.source_commit };
const appIdentity = { service: release.service, environment: release.environment, source_commit: release.source_commit };
const parentCookie = 'synthetic-parent-cookie-'.padEnd(40, 'p');
const childCookie = 'synthetic-child-cookie-'.padEnd(40, 'c');
const parentCsrf = 'synthetic-parent-csrf-'.padEnd(40, 'p');
const childCsrf = 'synthetic-child-csrf-'.padEnd(40, 'c');
const hash = value => createHash('sha256').update(value).digest('hex');
const cookie = value => ({ name: contract.session.cookie, value, domain: new URL(STAGING_ORIGIN).hostname,
  path: '/', secure: true, httpOnly: true });
const response = (status, value) => ({ status: () => status, ok: () => status >= 200 && status < 300,
  json: async () => value, headers: () => ({ location: `${STAGING_ORIGIN}/` }) });

async function harness(t, { sameCookie = false, sameCsrf = false, sourceMismatch = false, freshSourceMismatch = false,
  csrfHeader = childCsrf, cookieHeader = childCookie, signoutOrigin = STAGING_ORIGIN, signoutRedirect = `${STAGING_ORIGIN}/`,
  signedOutUi = true, parentBefore = true, parentAfter = true, oldAccepted = false } = {}) {
  const prior = { E2E_TARGET: process.env.E2E_TARGET, E2E_RUN_SUPERVISED: process.env.E2E_RUN_SUPERVISED };
  process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
  const root = await mkdtemp(join(tmpdir(), 'session-journey-'));
  const run = openRun(root, { runId: 'synthetic-session-journey', events: null,
    limits: { ...RUN_LIMITS, httpTimeoutMs: 100 } });
  t.after(async () => {
    run.dispose(); await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const calls = { exchange: 0, contexts: 0, signout: 0, forwarded: 0, aborted: 0, parentReads: 0, oldReads: 0 };
  const parentContext = { route: async () => {}, addInitScript: async () => {},
    storageState: async () => ({ cookies: [cookie(parentCookie)] }) };
  await installStagingGuard(parentContext, { forContext: () => ({ handle: async () => {}, assertCoverage: async () => {} }) });
  let browserRoute, pageUrl = `${STAGING_ORIGIN}/`;
  const childContext = {
    route: async (_pattern, callback) => { browserRoute = callback; },
    async close() {},
    async newPage() {
      return {
        url: () => pageUrl,
        goto: async () => response(200, null),
        waitForFunction: async () => { if (!signedOutUi) throw new Error('Synthetic signed-out UI absent'); },
        locator(selector) {
          return {
            waitFor: async () => {},
            getAttribute: async () => selector === '#selfAvatar' ? 'Joe: account and settings' : null,
            async click() {
              if (selector !== '#accountSignOut') return;
              const headers = { cookie: `${contract.session.cookie}=${cookieHeader}`,
                'x-carr-csrf': csrfHeader, origin: signoutOrigin, 'sec-fetch-site': 'same-origin' };
              const request = { url: () => `${signoutOrigin}/auth/signout`, method: () => 'POST',
                allHeaders: async () => headers, postData: () => null };
              await browserRoute({ request: () => request,
                fetch: async () => { calls.forwarded++; return { ...response(302, null), headers: () => ({ location: signoutRedirect }) }; },
                fulfill: async () => { calls.signout++; },
                abort: async () => { calls.aborted++; } });
            },
            textContent: async () => signedOutUi ? 'Signed out' : 'Sign-out unavailable',
          };
        },
      };
    },
  };
  const browser = { newContext: async () => { calls.contexts++; return childContext; } };
  parentContext.browser = () => browser;
  const parentPage = { context: () => parentContext, url: () => `${STAGING_ORIGIN}/`,
    evaluate: async () => {
      calls.parentReads++;
      const valid = calls.parentReads < 2 || calls.parentReads === 2 && parentBefore ||
        calls.parentReads > 2 && parentAfter;
      return { release: appIdentity, actor: valid ? 'joe' : null, principal: valid ? 'e2e-joe' : null,
        systemActor: valid ? 'joe' : null, csrfDigest: valid ? hash(parentCsrf) : null };
    } };
  const exchange = async (_origin, options) => {
    assert.equal(options.run, run); calls.exchange++;
    return { release: sourceMismatch ? { ...release, source_commit: 'b'.repeat(40) } : release,
      state: { cookies: [cookie(sameCookie ? parentCookie : childCookie)] } };
  };
  const requestContext = async () => {
    const number = ++calls.contexts;
    return { get: async path => {
      if (number === 3) { calls.oldReads++; return response(oldAccepted ? 200 : 401, {}); }
      if (path === '/app-release') return response(200, freshSourceMismatch ? { ...appIdentity, source_commit: 'b'.repeat(40) } : appIdentity);
      if (path === '/auth/session') return response(200, { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe',
        csrf_token: sameCsrf ? parentCsrf : childCsrf });
      if (path === '/api/system-work/session') return response(200, { actor: { slug: 'joe' },
        csrf_token: sameCsrf ? parentCsrf : childCsrf });
      throw new Error('Synthetic API path refused');
    }, dispose: async () => {} };
  };
  return { run, parentPage, browser, exchange, requestContext, calls, childContext, browserRoute: () => browserRoute };
}

const qualify = h => qualifySessionJourney({ parentPage: h.parentPage, release, run: h.run,
  browser: h.browser, exchange: h.exchange, requestContext: h.requestContext });

test('synthetic isolated lifecycle requires distinct cookie, CSRF, old rejection, parent survival, and signed-out UI', async t => {
  const h = await harness(t);
  const result = await qualify(h);
  assert.equal(result.state, 'qualified');
  assert.equal(result.old_session_rejected, true);
  assert.equal(result.parent_session_retained, true);
  assert.equal(result.signed_out_ui, true);
  assert.equal(h.calls.signout, 1);
  assert.equal(h.calls.oldReads, 1);
  for (const privateValue of [parentCookie, childCookie, parentCsrf, childCsrf])
    assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('identical exchange cookie or CSRF refuses before signout', async t => {
  for (const options of [{ sameCookie: true }, { sameCsrf: true }]) {
    const h = await harness(t, options);
    const result = await qualify(h);
    assert.equal(result.state, 'pending');
    assert.equal(h.calls.signout, 0);
    assert.equal(h.calls.forwarded, 0);
    assert.equal(h.calls.oldReads, 0);
  }
});

test('stale exchange or fresh app source mismatch refuses before signout', async t => {
  for (const options of [{ sourceMismatch: true }, { freshSourceMismatch: true }, { parentBefore: false }]) {
    const h = await harness(t, options);
    const result = await qualify(h);
    assert.equal(result.state, 'pending');
    assert.equal(h.calls.signout, 0);
    assert.equal(h.calls.forwarded, 0);
  }
});

test('wrong CSRF, cross-origin signout and unexpected redirect cannot qualify', async t => {
  for (const options of [{ csrfHeader: 'synthetic-wrong-csrf' }, { cookieHeader: parentCookie },
    { signoutOrigin: 'https://outside.invalid' },
    { signoutRedirect: 'https://outside.invalid/' }]) {
    const h = await harness(t, options);
    const result = await qualify(h);
    assert.equal(result.state, 'pending');
    assert.equal(result.dedicated_signout, false);
    assert.equal(h.calls.oldReads, 0);
  }
});

test('API revocation without signed-out UI, surviving old cookie, or lost parent stays pending', async t => {
  for (const options of [{ signedOutUi: false }, { oldAccepted: true }, { parentAfter: false }]) {
    const h = await harness(t, options);
    const result = await qualify(h);
    assert.equal(result.state, 'pending');
    assert.equal(h.calls.signout, 1);
  }
});

test('auth guard refuses unknown methods, MCP and cross-origin reads', async t => {
  const h = await harness(t);
  await qualify(h);
  for (const [method, url] of [['POST', `${STAGING_ORIGIN}/mcp`], ['GET', 'https://outside.invalid/app-release'],
    ['DELETE', `${STAGING_ORIGIN}/auth/session`]]) {
    await h.browserRoute()({ request: () => ({ method: () => method, url: () => url }), abort: async () => { h.calls.aborted++; } });
  }
  assert.equal(h.calls.aborted, 3);
});
