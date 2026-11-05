import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const workflow = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load(STDIN.read))'], {
  input: readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'), encoding: 'utf8',
}));

test('one run connects successful tests to production and proof', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events.push.branches, ['main']);
  assert.ok(events.pull_request);
  assert.ok(events.merge_group);
  assert.equal(events.workflow_run, undefined);
  assert.deepEqual(document.jobs.production.needs, ['test']);
  assert.deepEqual(document.jobs.proof.needs, ['production']);
  assert.equal(document.jobs.production.environment, 'production');
  assert.equal(document.concurrency['cancel-in-progress'], false);
  assert.equal(document.concurrency.queue, 'max');
  assert.equal(document.jobs.production.steps[0].with.ref, '${{ github.sha }}');
});

test('production smoke reads each page and refuses a sign-in redirect for another page', async t => {
  let wrongPage = false;
  const paths = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    paths.push(request.url);
    if (request.url === '/status') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Status</h1>');
    } else {
      const target = wrongPage && request.url === '/leads' ? '/other' : request.url;
      response.writeHead(302, { location: `/auth/login?return_to=${encodeURIComponent(target)}` }).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const step = workflow().jobs.proof.steps.find(step => step.name === 'Verify signed-out page gates');
  assert.ok(step);
  const run = async () => {
    const child = spawn('bash', ['-e', '-c', step.run], { env: {
      PATH: process.env.PATH,
      DOCTORCRE_SMOKE_URL: `http://127.0.0.1:${server.address().port}`,
    } });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; });
    const [status] = await once(child, 'close');
    return { status, errors };
  };
  const healthy = await run();
  assert.equal(healthy.status, 0, healthy.errors);
  assert.deepEqual(paths, ['/deals', '/leads', '/invoices', '/control-room/progress', '/doc-chats', '/status']);
  wrongPage = true;
  assert.notEqual((await run()).status, 0);
});

test('production publication and proof use the tested source with narrow credentials', () => {
  const { jobs } = workflow();
  const steps = jobs.production.steps;
  const build = steps.findIndex(step => step.run === 'npm run build');
  const verify = steps.findIndex(step => step.run === 'npm run artifact:verify');
  const gate = steps.findIndex(step => step.name === 'Require exact tested source');
  const deploy = steps.findIndex(step => step.name === 'Deploy production');
  assert.ok(build < verify && verify < gate && gate + 1 === deploy);
  assert.equal(steps[build].env.DOCTORCRE_SOURCE_COMMIT, '${{ github.sha }}');
  assert.equal(steps[gate].env.SOURCE_COMMIT, '${{ github.sha }}');
  assert.match(steps[deploy].run, /node scripts\/release-production\.mjs/);
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (jobName !== 'production' || step.name !== 'Deploy production') {
        assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
      }
    }
  }
  const readback = jobs.proof.steps.find(step => step.name === 'Verify production release identity');
  assert.match(readback.run, /verify-app-release\.mjs.*"\$SOURCE_COMMIT" production/);
  assert.equal(readback.env.SOURCE_COMMIT, '${{ github.sha }}');
  assert.ok(jobs.proof.steps.some(step => step.name === 'Run production browser smoke'));
});

test('main movement does not discard the exact tested checkout', t => {
  const gate = workflow().jobs.production.steps.find(step => step.name === 'Require exact tested source');
  const root = temporaryDirectory('production-main-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin'), checkout = join(root, 'checkout');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(root, 'init', '--initial-branch=main', origin);
  const commit = () => git(origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic source');
  commit();
  const source = git(origin, 'rev-parse', 'HEAD');
  git(root, 'clone', origin, checkout);
  git(checkout, 'checkout', '--detach', source);
  const run = sourceCommit => spawnSync('bash', ['-e', '-c', gate.run], {
    cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, SOURCE_COMMIT: sourceCommit },
  });
  assert.equal(run(source).status, 0);
  commit();
  assert.equal(run(source).status, 0);
  assert.notEqual(run('0'.repeat(40)).status, 0);
  git(checkout, 'remote', 'set-url', 'origin', join(root, 'missing'));
  assert.notEqual(run(source).status, 0);
});
