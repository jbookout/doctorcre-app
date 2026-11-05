import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const workflow = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load(STDIN.read))'], {
  input: readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8'), encoding: 'utf8',
}));

test('one completed main CI run owns one immutable deployment source', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events, { workflow_run: { workflows: ['CI'], branches: ['main'], types: ['completed'] } });
  const job = document.jobs.production;
  assert.equal(job.if, "github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository");
  assert.equal(job.environment, 'production');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.equal(document.permissions.contents, 'read');
  assert.equal(document.permissions.actions, 'read');
  assert.equal(document.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(job.env?.CLOUDFLARE_API_TOKEN, undefined);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
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
  const step = workflow().jobs.production.steps.find(step => step.name === 'Verify signed-out page gates');
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

test('production waits for successful CI on that source and uses the existing publisher before its read-only smoke', () => {
  const steps = workflow().jobs.production.steps;
  const ci = steps.findIndex(step => step.id === 'candidate');
  const build = steps.findIndex(step => step.run === 'npm run build');
  const deploy = steps.findIndex(step => step.name === 'Deploy production');
  const readback = steps.findIndex(step => step.name === 'Verify production release identity');
  const smoke = steps.findIndex(step => step.name === 'Run production browser smoke');
  assert.ok(ci >= 0 && ci < build && build < deploy && deploy < readback && readback < smoke);
  assert.equal(steps[ci].run, 'python3 scripts/production-candidate.py');
  assert.match(steps[deploy].run, /node scripts\/release-production\.mjs/);
  assert.equal(steps[deploy].env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  assert.match(steps[readback].run, /verify-app-release\.mjs.*"\$SOURCE_COMMIT" production/);
  assert.match(steps[smoke].run, /node node_modules\/e2e\/dist\/cli\/bin\.js run --config e2e\.production\.config\.ts --target chromium/);
  for (const [index, step] of steps.entries()) {
    if (index !== deploy) assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
  }
});

test('publication requires the admitted source while allowing main to advance', t => {
  const steps = workflow().jobs.production.steps;
  const gate = steps.findIndex(step => step.name === 'Require exact admitted source');
  const deploy = steps.findIndex(step => step.name === 'Deploy production');
  const verify = steps.findIndex(step => step.run === 'npm run artifact:verify');
  assert.ok(gate > verify && gate + 1 === deploy, 'refresh main immediately before publication');
  assert.equal(steps[gate].env.SOURCE_COMMIT, '${{ steps.candidate.outputs.source_commit }}');
  const root = temporaryDirectory('production-main-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const checkout = join(root, 'checkout');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(root, ['init', '--initial-branch=main', origin]);
  const commit = () => git(origin, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic source']);
  commit();
  const source = git(origin, ['rev-parse', 'HEAD']);
  git(root, ['clone', origin, checkout]);
  git(checkout, ['checkout', '--detach', source]);
  const run = sourceCommit => spawnSync('bash', ['-e', '-c', steps[gate].run], {
    cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, SOURCE_COMMIT: sourceCommit },
  });
  const current = run(source);
  assert.equal(current.status, 0, current.stderr);
  assert.notEqual(run('0'.repeat(40)).status, 0, 'refuse a different staged source');
  commit();
  assert.equal(git(checkout, ['rev-parse', 'origin/main']), source, 'checkout still has the old remote reference');
  assert.equal(run(source).status, 0, 'main movement does not discard the admitted source');
});


test('GitHub serializes all production candidates without replacing pending runs', () => {
  const job = workflow().jobs.production;
  assert.deepEqual(job.concurrency, { group: 'doctorcre-app-production', 'cancel-in-progress': false, queue: 'max' });
  const candidate = job.steps.find(step => step.id === 'candidate');
  assert.equal(candidate.env.SOURCE_COMMIT, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(candidate.env.CI_RUN_ID, '${{ github.event.workflow_run.id }}');
  for (const step of job.steps.slice(job.steps.indexOf(candidate) + 1)) {
    if (step.if === 'failure()') continue;
    assert.match(step.if, /steps.candidate.outputs.ready == 'true'/);
  }
});

test('workflow visibly reports completed publication and failed publication', async t => {
  const root = temporaryDirectory('production-outcomes-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const summary = join(root, 'summary');
  for (const name of ['Record publication outcome', 'Record failed publication outcome']) {
    const step = workflow().jobs.production.steps.find(step => step.name === name);
    const result = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, SOURCE_COMMIT: 'a'.repeat(40) } });
    assert.equal(result.status, 0, result.stderr);
    if (name.includes('failed')) assert.match(result.stdout, /::error::/);
    else assert.match(readFileSync(summary, 'utf8'), /Published and verified source a{40}/);
  }
});
