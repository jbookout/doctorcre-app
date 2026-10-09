import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'playwright';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import * as session from '../../scripts/e2e-staging/session.mjs';
import * as records from '../../scripts/e2e-staging/records.mjs';
import { openRun, RUN_LIMITS, RunLimitError } from '../../scripts/e2e-staging/run-limits.mjs';

function controls(t, target, supervised) {
  const previous = { E2E_TARGET: process.env.E2E_TARGET, E2E_RUN_SUPERVISED: process.env.E2E_RUN_SUPERVISED };
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  for (const [key, value] of Object.entries({ E2E_TARGET: target, E2E_RUN_SUPERVISED: supervised })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
async function budget(t) {
  const root = await mkdtemp(join(tmpdir(), 'staging-context-admission-'));
  const run = openRun(root, { runId: 'synthetic-context-admission', events: null });
  t.after(async () => { run.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, run };
}
const refused = reason => error => error instanceof RunLimitError && error.code === reason;

// The verification probe's raw context and callback are synthetic: no host is contacted.
test('the admission probe refuses 401 release calls, default contexts and preparation before any effect', async t => {
  controls(t, undefined, undefined);
  const { root } = await budget(t);
  let contexts = 0, requests = 0, sessions = 0;
  const api = { get: async () => { requests++; return { status: () => 401, ok: () => false }; }, dispose: async () => {} };
  const original = request.newContext;
  request.newContext = async () => { contexts++; return api; };
  try {
    await assert.rejects(session.stagingSession(session.STAGING_ORIGIN, { requestContext: api, exchange: false }), refused('staging-target-required'));
    await assert.rejects(session.stagingSession(), refused('staging-target-required'));
    for (let i = 0; i <= RUN_LIMITS.httpRequests; i++) await assert.rejects(session.stagingRelease(api), refused('staging-target-required'));
    await assert.rejects(records.prepareStagingRecords(root, { session: async () => { sessions++; throw new Error('session reached'); } }), refused('staging-target-required'));
  } finally { request.newContext = original; }
  assert.deepEqual({ contexts, requests, sessions }, { contexts: 0, requests: 0, sessions: 0 });
});

test('every exported staging-context entry point refuses missing opt-in, including an explicitly supplied budget', async t => {
  // Enumerate all exported functions. Local-only helpers and the generic retry helper
  // are classified explicitly, so a new export cannot silently escape this audit.
  const local = {
    session: ['SessionPreflightFailure', 'assertStagingURL', 'preflightRequest', 'readSessionSecret'],
    records: ['assertStagingWriteCoverage', 'readStagingFixtureRelease'],
  };
  const network = {
    session: ['createStagingRequestContext', 'stagingRelease', 'stagingSession', 'writeStagingStorageState'],
    records: ['prepareStagingRecords', 'stagingFixtureWriteGuard'],
  };
  for (const [name, module] of Object.entries({ session, records })) {
    assert.deepEqual(Object.keys(module).filter(key => typeof module[key] === 'function').sort(), [...local[name], ...network[name]].sort());
  }
  const { root, run } = await budget(t);
  let effects = 0;
  const effect = async () => { effects++; throw new Error('unexpected staging effect'); };
  const api = { get: effect, storageState: effect, dispose: async () => {} };
  const entry = {
    createStagingRequestContext: () => session.createStagingRequestContext({ requestContext: api, run }),
    stagingRelease: () => session.stagingRelease(api, session.STAGING_ORIGIN, { run }),
    stagingSession: () => session.stagingSession(session.STAGING_ORIGIN, { requestContext: api, exchange: false, run }),
    writeStagingStorageState: () => session.writeStagingStorageState(api, join(root, 'private/state.json'), run),
    prepareStagingRecords: () => records.prepareStagingRecords(root, { run, session: effect, requestFactory: effect }),
    stagingFixtureWriteGuard: () => records.stagingFixtureWriteGuard({ run }).handle({ url: () => session.STAGING_ORIGIN + '/app-release', method: () => 'GET' }, effect),
  };
  assert.deepEqual(Object.keys(entry).sort(), Object.values(network).flat().sort());
  for (const [target, supervised, reason] of [[undefined, undefined, 'staging-target-required'], ['staging-live', undefined, 'supervised-run-required'], [undefined, '1', 'staging-target-required']]) {
    await t.test(`${target || 'missing target'} / ${supervised || 'missing supervision'}`, async child => {
      controls(child, target, supervised);
      for (const [name, invoke] of Object.entries(entry)) await assert.rejects(async () => invoke(), refused(reason), name);
      assert.equal(effects, 0);
    });
  }
});

test('the context factory refuses a missing budget and rechecks opt-in before each request', async t => {
  controls(t, 'staging-live', '1');
  const { run } = await budget(t);
  let requests = 0;
  const api = { get: async () => { requests++; return { status: () => 200 }; }, dispose: async () => {} };
  await assert.rejects(session.createStagingRequestContext({ requestContext: api, run: null }), refused('supervised-run-required'));
  const bounded = await session.createStagingRequestContext({ requestContext: api, run });
  await bounded.get('/app-release');
  delete process.env.E2E_RUN_SUPERVISED;
  await assert.rejects(async () => bounded.get('/app-release'), refused('supervised-run-required'));
  assert.equal(requests, 1);
  assert.equal(run.snapshot().httpRequests, 1);
});

test('release preflight preserves the named request limit and never retries past the ceiling', async t => {
  controls(t, 'staging-live', '1');
  const { run } = await budget(t);
  let requests = 0;
  const api = { get: async () => { requests++; return { status: () => 401, ok: () => false }; }, dispose: async () => {} };
  for (let i = 0; i < RUN_LIMITS.httpRequests; i++) await assert.rejects(session.stagingRelease(api, session.STAGING_ORIGIN, { run }), /app-release-invalid/);
  await assert.rejects(session.stagingRelease(api, session.STAGING_ORIGIN, { run }), refused('http-request-limit'));
  assert.equal(requests, 400);
  assert.equal(run.snapshot().httpRequests, 400);
  assert.equal(run.snapshot().stopReason, 'http-request-limit');
});

test('a supervised default session uses the shared factory and counts each request exactly once', async t => {
  controls(t, 'staging-live', '1');
  const { run } = await budget(t);
  let creations = 0, disposals = 0;
  const calls = [];
  const state = { cookies: [{ name: contract.session.cookie, httpOnly: true, secure: true }], origins: [] };
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40) };
  const original = request.newContext;
  request.newContext = async options => {
    creations++;
    assert.deepEqual(options, { baseURL: session.STAGING_ORIGIN, timeout: RUN_LIMITS.httpTimeoutMs });
    return {
      get: async (path, options) => {
        calls.push(path);
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.timeout, RUN_LIMITS.httpTimeoutMs);
        const body = path === '/app-release' ? release : path === contract.carr_origin + '/release' ?
          { env: { value: 'staging' }, git_sha: { value: contract.producer.source_commit } } :
          { actor: { slug: contract.session.actor_slug }, e2e_principal: contract.session.e2e_principal };
        return { status: () => 200, ok: () => true, json: async () => body };
      },
      storageState: async () => state,
      dispose: async () => { disposals++; },
    };
  };
  let result;
  try { result = await session.stagingSession(session.STAGING_ORIGIN, { exchange: false, run }); }
  finally { request.newContext = original; }
  assert.equal(result.state, state);
  assert.equal(result.release.carr_source_commit, contract.producer.source_commit);
  assert.deepEqual(calls, ['/app-release', contract.carr_origin + '/release', contract.session.path]);
  assert.equal(run.snapshot().httpRequests, 3);
  assert.equal(creations, 1);
  assert.equal(disposals, 1);
});
