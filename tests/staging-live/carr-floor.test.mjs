import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import * as session from '../../scripts/e2e-staging/session.mjs';
import { createWorkerDiagnosticReader } from '../../scripts/e2e-staging/supervise.mjs';
import { openRun, RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';

// Every host below is synthetic: the staging and GitHub answers are canned, nothing is contacted.
const floor = contract.producer.source_commit;
const compare = (base, head) => `https://api.github.com/repos/jbookout/carr-system/compare/${base}...${head}?per_page=1`;
const app = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40) };

function environment(t, values) {
  const keys = ['E2E_TARGET', 'E2E_RUN_SUPERVISED', 'GITHUB_TOKEN', 'GH_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { E2E_TARGET: 'staging-live', E2E_RUN_SUPERVISED: '1' }, values);
}

async function staging(t, carr, github = {}, values = {}) {
  environment(t, values);
  const root = await mkdtemp(join(tmpdir(), 'staging-carr-floor-'));
  const run = openRun(root, { runId: 'synthetic-carr-floor', events: null, limits: { ...RUN_LIMITS, httpRequests: 10 } });
  t.after(async () => { run.dispose(); await rm(root, { recursive: true, force: true }); });
  const githubCalls = [];
  const answer = (status, body) => ({ status: () => status, ok: () => status === 200, json: async () => body });
  const api = {
    async get(url, options) {
      if (url === '/app-release') return answer(200, app);
      if (url === contract.carr_origin + '/release') return answer(200, carr);
      assert.ok(Object.hasOwn(github, url), 'Unexpected GET ' + url);
      githubCalls.push({ url, headers: options.headers });
      const reply = github[url];
      if (reply instanceof Error) throw reply;
      return typeof reply === 'number' ? answer(reply, { message: 'synthetic' }) : answer(200, { status: reply });
    },
    async dispose() {},
  };
  return { run, githubCalls, release: () => session.stagingRelease(api, session.STAGING_ORIGIN, { run }) };
}

const carr = (sha, env = 'staging') => ({ env: { value: env }, git_sha: { value: sha } });
const refused = (code, presented) => error => {
  assert.ok(error instanceof session.SessionPreflightFailure, error.stack);
  assert.equal(error.code, code);
  assert.deepEqual(error.carr, presented);
  assert.equal(error.message, `staging session preflight failed: ${code} (carr env=${presented.env}; git_sha=${presented.git_sha})`);
  return true;
};

test('the floor commit itself is admitted without asking GitHub', async t => {
  const h = await staging(t, carr(floor));
  const release = await h.release();
  assert.equal(release.carr_source_commit, floor);
  assert.equal(release.carr_release_commit, floor);
  assert.deepEqual(h.githubCalls, []);
});

test('a newer carr-system main commit descended from the floor is admitted (2026-10-13 regression)', async t => {
  const newer = '1'.repeat(40);
  const h = await staging(t, carr(newer), { [compare(newer, 'main')]: 'ahead', [compare(floor, newer)]: 'ahead' },
    { GITHUB_TOKEN: 'synthetic-token-value' });
  const release = await h.release();
  assert.equal(release.carr_source_commit, floor, 'the contract floor stays the bound CARR identity');
  assert.equal(release.carr_release_commit, newer, 'the live CARR commit is recorded');
  assert.deepEqual(h.githubCalls.map(row => row.url), [compare(newer, 'main'), compare(floor, newer)]);
  for (const { headers } of h.githubCalls) assert.equal(headers.authorization, 'Bearer synthetic-token-value');
  await h.release();
  assert.equal(h.githubCalls.length, 2, 'an admitted commit is not re-verified within the process');
  assert.equal(h.run.snapshot().httpRequests, 6, 'GitHub calls are charged to the run budget');
});

test('the current main tip is admitted and the GH_TOKEN fallback is used', async t => {
  const tip = '2'.repeat(40);
  const h = await staging(t, carr(tip), { [compare(tip, 'main')]: 'identical', [compare(floor, tip)]: 'ahead' },
    { GH_TOKEN: 'synthetic-gh-token' });
  assert.equal((await h.release()).carr_release_commit, tip);
  for (const { headers } of h.githubCalls) assert.equal(headers.authorization, 'Bearer synthetic-gh-token');
});

test('a branch deploy that is not on carr-system main is refused', async t => {
  const branch = 'c06bdf2788fb69daefb59364ea4fd798fa94f9a4';
  const h = await staging(t, carr(branch), { [compare(branch, 'main')]: 'diverged', [compare(floor, branch)]: 'ahead' });
  await assert.rejects(h.release(), refused('carr-commit-not-on-main', { env: 'staging', git_sha: branch }));
  assert.equal(h.githubCalls.some(row => 'authorization' in row.headers), false, 'no token is invented');
});

test('a main commit older than the floor is refused', async t => {
  const older = '3'.repeat(40);
  const h = await staging(t, carr(older), { [compare(older, 'main')]: 'ahead', [compare(floor, older)]: 'behind' });
  await assert.rejects(h.release(), refused('carr-commit-older-than-floor', { env: 'staging', git_sha: older }));
});

test('a CARR release outside staging is refused before GitHub is asked', async t => {
  const h = await staging(t, carr(floor, 'production'));
  await assert.rejects(h.release(), refused('carr-env-mismatch', { env: 'production', git_sha: floor }));
  assert.deepEqual(h.githubCalls, []);
});

test('a malformed CARR commit is refused before GitHub is asked', async t => {
  for (const sha of ['C06BDF2788FB69DAEFB59364EA4FD798FA94F9A4', 'c06bdf27', floor + ' ', null]) await t.test(String(sha), async t => {
    const h = await staging(t, carr(sha));
    await assert.rejects(h.release(), refused('carr-commit-malformed', { env: 'staging', git_sha: 'malformed' }));
    assert.deepEqual(h.githubCalls, []);
  });
});

test('GitHub unreachable, rate-limited or unreadable fails closed', async t => {
  const sha = '4'.repeat(40);
  for (const [name, onMain, fromFloor] of [
    ['transport', new Error('getaddrinfo ENOTFOUND api.github.com'), 'ahead'],
    ['rate-limited', 403, 'ahead'],
    ['too-many-requests', 429, 'ahead'],
    ['server-error', 'ahead', 503],
    ['unknown-commit', 404, 404],
    ['unrecognized-status', 'sideways', 'ahead'],
  ]) await t.test(name, async t => {
    const h = await staging(t, carr(sha), { [compare(sha, 'main')]: onMain, [compare(floor, sha)]: fromFloor });
    await assert.rejects(h.release(), refused('carr-ancestry-unverifiable', { env: 'staging', git_sha: sha }));
  });
});

test('a CARR refusal reaches the run log as closed diagnostics, never raw text', () => {
  const branch = 'c06bdf2788fb69daefb59364ea4fd798fa94f9a4';
  const diagnostics = [];
  const read = createWorkerDiagnosticReader(value => diagnostics.push(value));
  read(Buffer.from(`Error: ${new session.SessionPreflightFailure('carr-commit-not-on-main', { env: 'staging', git_sha: branch }).message}\n`));
  read(Buffer.from('Error: staging session preflight failed: carr-commit-not-on-main (carr env=staging; git_sha=SYNTHETIC_CANARY)\n'));
  read(Buffer.from('Error: staging session preflight failed: secret-failed (carr env=staging; git_sha=malformed)\n'));
  assert.deepEqual(diagnostics, ['cause=carr-commit-not-on-main', 'carr-env=staging', `carr-git-sha=${branch}`]);
});
