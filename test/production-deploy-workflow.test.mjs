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
  input: readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8'), encoding: 'utf8',
}));

test('one main push owns one immutable deployment run', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events, { push: { branches: ['main'] } });
  const job = document.jobs.production;
  assert.equal(job.if, undefined);
  assert.equal(job.environment, 'production');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.equal(document.permissions.contents, 'read');
  assert.equal(document.permissions.actions, 'read');
  assert.equal(document.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(job.env?.CLOUDFLARE_API_TOKEN, undefined);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
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

test('production refreshes main before publication and refuses a staged source after main advances', t => {
  const steps = workflow().jobs.production.steps;
  const gate = steps.findIndex(step => step.name === 'Require current main source');
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
  assert.notEqual(run(source).status, 0, 'refuse stale source after fetching the advanced main');
  git(checkout, ['remote', 'set-url', 'origin', join(root, 'missing')]);
  assert.notEqual(run(source).status, 0, 'fail closed when main cannot be fetched');
});


test('one deployment waits for its exact green source and refuses supersession or failed CI', t => {
  const job = workflow().jobs.production;
  assert.equal(job.concurrency.group, 'doctorcre-app-production');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  const candidate = job.steps.find(step => step.id === 'candidate');
  const root = temporaryDirectory('production-candidate-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gh = join(root, 'gh');
  const git = join(root, 'git');
  const sha = 'a'.repeat(40);
  writeFileSync(git, `#!/usr/bin/env python3
import os, sys
if sys.argv[1] == 'rev-parse': print(os.environ['FIXTURE_MAIN'] if sys.argv[-1] == 'origin/main' else os.environ['FIXTURE_SHA'])
`);
  writeFileSync(gh, `#!/usr/bin/env python3
import os, sys
if sys.argv[1:3] == ['run','watch']:
    assert sys.argv[3] == '123'
    sys.exit(int(os.environ['FIXTURE_WATCH']))
assert '--commit' in sys.argv and sys.argv[sys.argv.index('--commit')+1] == os.environ['FIXTURE_SHA']
print(os.environ['FIXTURE_RUNS'])
`);
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  const run = (runs, main = sha, watch = 0) => {
    const output = join(root, 'output');
    writeFileSync(output, '');
    const result = spawnSync('python3', [new URL('../scripts/production-candidate.py', import.meta.url).pathname], {
      cwd: root, encoding: 'utf8', env: {
        PATH: `${root}:${process.env.PATH}`, GITHUB_SHA: sha,
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'jbookout/doctorcre-app',
        FIXTURE_SHA: sha, FIXTURE_MAIN: main, FIXTURE_WATCH: String(watch), FIXTURE_RUNS: JSON.stringify(runs),
      },
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };
  const green = { databaseId: 123, headSha: sha, status: 'completed', conclusion: 'success' };
  for (const ci of [green, { ...green, status: 'in_progress', conclusion: '' }]) {
    const result = run([ci]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /ready=true/);
    assert.ok(result.output.includes(`source_commit=${sha}`));
  }
  for (const [ci, main] of [[green, 'b'.repeat(40)], [{ ...green, conclusion: 'failure' }, sha]]) {
    const result = run([ci], main);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /ready=false/);
  }
  assert.notEqual(run([{ ...green, status: 'in_progress' }], sha, 1).status, 0, 'failed CI watch refuses publication');
  assert.notEqual(run([{ ...green, headSha: 'b'.repeat(40) }]).status, 0, 'wrong CI source fails closed');
  writeFileSync(gh, '#!/bin/sh\nexit 1\n');
  assert.notEqual(run([green]).status, 0, 'GitHub failure refuses publication without retry');
  for (const step of job.steps.slice(job.steps.indexOf(candidate) + 1)) {
    if (step.if === 'failure()') continue;
    assert.match(step.if, /steps.candidate.outputs.ready == 'true'/, step.name || step.run || step.uses);
  }
});

test('candidate bounds discovery and CI waiting, and rechecks main after CI', () => {
  const script = new URL('../scripts/production-candidate.py', import.meta.url).pathname;
  const result = spawnSync('python3', ['-c', `
import importlib.util, json, os, subprocess
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('candidate', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.environ['GITHUB_REPOSITORY'] = 'synthetic/app'
sha = 'a' * 40
green = {'databaseId': 123, 'headSha': sha, 'status': 'completed', 'conclusion': 'success'}
with patch.object(m, 'current', return_value=True), patch.object(m.time, 'sleep') as sleep:
    with patch.object(m.subprocess, 'check_output', return_value='[]') as lookup:
        try: m.ready(sha)
        except RuntimeError: pass
        else: raise AssertionError('missing CI must refuse')
        assert lookup.call_count == 6
        assert sleep.call_count == 5
    with patch.object(m.subprocess, 'check_output', side_effect=['[]', json.dumps([green])]):
        assert m.ready(sha)
with patch.object(m, 'current', side_effect=[True, False]), patch.object(m.subprocess, 'check_output', return_value=json.dumps([green])):
    assert not m.ready(sha), 'main advanced while CI finished'
running = dict(green, status='in_progress', conclusion=None)
with patch.object(m, 'current', return_value=True), patch.object(m.subprocess, 'check_output', return_value=json.dumps([running])):
    with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('gh', 1800)) as watch:
        try: m.ready(sha)
        except subprocess.TimeoutExpired: pass
        else: raise AssertionError('timed out CI must refuse')
        assert watch.call_count == 1
        assert watch.call_args.kwargs['timeout'] == 1800
        assert watch.call_args.args[0][-2:] == ['--interval', '30']
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('delayed older admission preserves the newest green main deployment opportunity', t => {
  const root = temporaryDirectory('production-admission-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const checkout = join(root, 'checkout');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(root, ['init', '--initial-branch=main', origin]);
  const sources = Array.from({ length: 30 }, () => {
    git(origin, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-m', 'Synthetic main push']);
    return git(origin, ['rev-parse', 'HEAD']);
  });
  git(origin, ['update-ref', 'refs/heads/main', sources[2]]);
  git(root, ['clone', origin, checkout]);
  const script = new URL('../scripts/production-candidate.py', import.meta.url).pathname;
  const concurrency = workflow().jobs.production.concurrency;
  const result = spawnSync('python3', ['-c', `
import importlib.util, itertools, json, os, subprocess
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('candidate', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.environ['GITHUB_REPOSITORY'] = 'synthetic/app'
sources = ${JSON.stringify(sources)}
config = json.loads(${JSON.stringify(JSON.stringify(concurrency))})
real_output = subprocess.check_output
def output(args, **kwargs):
    if args[0] != 'gh': return real_output(args, **kwargs)
    sha = args[args.index('--commit') + 1]
    return json.dumps([dict(databaseId=123, headSha=sha, status='completed', conclusion='success')])
def replay(admissions):
    running, *arrivals = admissions
    pending = []
    for sha in arrivals:
        if config.get('queue') == 'max':
            if len(pending) < 100: pending.append(sha)
        else: pending = [sha]
    with patch.object(m.subprocess, 'check_output', side_effect=output):
        return [sha for sha in [running, *pending] if m.ready(sha)]
abc = sources[:3]
selected = replay([abc[0], abc[2], abc[1]])
assert selected == [abc[-1]], f'A running, C pending, delayed B admitted: expected C, got {selected}'
for order in itertools.permutations(abc):
    assert replay(order) == [abc[-1]], 'admission order must not lose or repeat the newest opportunity'
subprocess.run(['git', '-C', ${JSON.stringify(origin)}, 'update-ref', 'refs/heads/main', sources[-1]], check=True)
assert replay([sources[0], *reversed(sources[1:])]) == [sources[-1]], '10x burst must retain newest'
print('A running -> C pending -> delayed B retained; C ready exactly once; all 6 orders and 30-push burst passed')
`], { cwd: checkout, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /C ready exactly once/);
});
