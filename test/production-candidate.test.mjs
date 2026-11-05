import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import worker from '../src/worker.js';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const program = new URL('../scripts/production-candidate.py', import.meta.url).pathname;

async function fixture(t) {
  const root = await temporaryDirectory('production-candidate-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  await mkdir(origin);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(origin, 'init', '-b', 'main');
  const commits = [];
  for (const name of ['live', 'candidate', 'main']) {
    await writeFile(join(origin, 'version'), name);
    git(origin, 'add', 'version');
    git(origin, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', name);
    commits.push(git(origin, 'rev-parse', 'HEAD'));
  }
  git(origin, 'checkout', '--orphan', 'divergent');
  git(origin, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'divergent');
  const divergent = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', 'main');
  const checkout = join(root, 'checkout');
  git(root, 'clone', origin, checkout);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!${process.execPath}\nif (process.env.TEST_GH_FAILURE) process.exit(1); process.stdout.write(process.env.TEST_CI);\n`);
  await chmod(gh, 0o755);
  let live = commits[0];
  let fault = '';
  let environment = 'production';
  const server = createServer(async (req, res) => {
    const response = await worker.fetch(new Request(new URL(req.url, 'https://app.doctorcre.com')), {
      GIT_SHA: live, APP_ENV: environment, CF_VERSION_METADATA: { id: 'fixture-version' },
    });
    const headers = Object.fromEntries(response.headers);
    if (fault === 'html') headers['content-type'] = 'text/html';
    res.writeHead(fault === 'unavailable' ? 503 : response.status, headers);
    res.end(fault === 'oversized' ? 'x'.repeat(65537) : await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/app-release`;
  async function run({ source = commits[1], liveSource = commits[0], ci = {}, checkoutSource = source, httpFault = '', liveEnvironment = 'production', gitFailure = false, ghFailure = false } = {}) {
    live = liveSource;
    fault = httpFault;
    environment = liveEnvironment;
    if (gitFailure) git(checkout, 'remote', 'set-url', 'origin', join(root, 'missing'));
    git(checkout, 'checkout', '--detach', checkoutSource);
    const output = join(root, 'output');
    const summary = join(root, 'summary');
    await writeFile(output, '');
    await writeFile(summary, '');
    const run = { id: 123, name: 'CI', path: '.github/workflows/ci.yml', head_sha: source,
      event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success',
      head_repository: { full_name: 'jbookout/doctorcre-app' }, ...ci };
    const result = await new Promise((resolve, reject) => {
      const child = spawn('python3', [program, '--release-url', url], { cwd: checkout,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: source,
          SOURCE_COMMIT: source, CI_RUN_ID: '123', TEST_GH_FAILURE: ghFailure ? '1' : '', TEST_CI: JSON.stringify(run),
          GITHUB_REPOSITORY: 'jbookout/doctorcre-app', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    return { ...result, output: await readFile(output, 'utf8'), summary: await readFile(summary, 'utf8') };
  }
  return { run, commits, divergent, url };
}

function selected(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.output, /ready=true/);
  assert.match(result.summary, /eligible/);
}
function noop(result, reason) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.output, /ready=false/);
  assert.match(result.stdout, /::notice::no-op:/);
  assert.match(result.summary, reason);
}

test('green source publishes when main has advanced past it', async t => {
  selected(await (await fixture(t)).run());
});
test('green current main publishes after the live release', async t => {
  const f = await fixture(t);
  selected(await f.run({ source: f.commits[2] }));
});
test('already live source is an explicit no-op', async t => {
  const f = await fixture(t);
  noop(await f.run({ liveSource: f.commits[1] }), /already live/);
});
test('older source never replaces newer live source', async t => {
  const f = await fixture(t);
  noop(await f.run({ liveSource: f.commits[2] }), /newer release/);
});
test('out-of-order serialized candidates converge to newest live source', async t => {
  const f = await fixture(t);
  selected(await f.run({ source: f.commits[2] }));
  noop(await f.run({ liveSource: f.commits[2] }), /newer release/);
  noop(await f.run({ source: f.commits[2], liveSource: f.commits[2] }), /already live/);
});
test('unsuccessful exact CI is an explicit no-op', async t => {
  const f = await fixture(t);
  for (const conclusion of ['failure', 'cancelled', null]) {
    noop(await f.run({ ci: { conclusion } }), /CI did not succeed/);
  }
});
test('CI source, event, branch, workflow and repository identity must match', async t => {
  const f = await fixture(t);
  for (const ci of [{ head_sha: f.commits[2] }, { event: 'pull_request' }, { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/app' } },
    { status: 'in_progress' }, { id: 456 }]) {
    const result = await f.run({ ci });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /::error::/);
    assert.match(result.summary, /refused/);
    assert.doesNotMatch(result.output, /ready=true/);
  }
});
test('checkout mismatch and source outside main are refused', async t => {
  const f = await fixture(t);
  for (const options of [{ checkoutSource: f.commits[2] }, { source: f.divergent }]) {
    const result = await f.run(options);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /::error::/);
  }
});
test('invalid live identity and divergent live history fail closed visibly', async t => {
  const f = await fixture(t);
  for (const liveSource of ['0'.repeat(40), 'invalid', f.divergent, 'f'.repeat(40)]) {
    const result = await f.run({ liveSource });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /::error::/);
    assert.match(result.summary, /refused/);
  }
});

test('dependency failures and invalid HTTP contracts refuse publication visibly', async t => {
  const f = await fixture(t);
  for (const options of [{ ghFailure: true }, { httpFault: 'html' }, { httpFault: 'oversized' },
    { httpFault: 'unavailable' }, { liveEnvironment: 'staging' }, { gitFailure: true }]) {
    const result = await f.run(options);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /::error::/);
    assert.match(result.summary, /refused/);
    assert.doesNotMatch(result.output, /ready=true/);
  }
});

test('production proof readback CLI passes real Worker identity and refuses a wrong release', async t => {
  const f = await fixture(t);
  const cli = new URL('../scripts/verify-app-release.mjs', import.meta.url).pathname;
  const invoke = source => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, f.url, source, 'production']);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const pass = await invoke(f.commits[0]);
  assert.equal(pass.code, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).source_commit, f.commits[0]);
  const fail = await invoke(f.commits[1]);
  assert.notEqual(fail.code, 0);
  assert.match(fail.stderr, /after 12 reads/);
});
