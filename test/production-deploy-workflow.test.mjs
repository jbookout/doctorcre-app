import { parse as parseYaml } from 'yaml';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { startFixture } from '../scripts/fixture-http.mjs';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { join } from 'node:path';

const workflow = () => parseYaml(readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8'));

test('production smoke reads each page and refuses a sign-in redirect for another page', async t => {
  async function snapshot(wrongPage = false) {
    const responses = new Map(['/deals', '/leads', '/invoices', '/control-room/progress', '/doc-chats'].map(path => [path, { status: 302, headers: { location: `/auth/login?return_to=${encodeURIComponent(wrongPage && path === '/leads' ? '/other' : path)}` } }]));
    responses.set('/status', { contentType: 'text/html', body: '<h1>Status</h1>' });
    const server = await startFixture({ routes: responses }); t.after(() => server.close()); return server;
  }
  let server = await snapshot();
  const step = workflow().jobs.production.steps.find(step => step.name === 'Verify signed-out page gates');
  assert.ok(step);
  const run = async () => {
    const child = spawn('bash', ['-e', '-c', step.run], { env: {
      PATH: process.env.PATH,
      DOCTORCRE_SMOKE_URL: server.origin,
    } });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; });
    const [status] = await once(child, 'close');
    return { status, errors };
  };
  const healthy = await run();
  assert.equal(healthy.status, 0, healthy.errors);
  assert.ok(server.requests.every(req => req.method === 'GET'));
  assert.deepEqual(server.requests.map(req => req.target), ['/deals', '/leads', '/invoices', '/control-room/progress', '/doc-chats', '/status']);
  await server.close(); server = await snapshot(true);
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
  assert.match(steps[readback].run, /verifyAppRelease\('https:.*process.env.SOURCE_COMMIT, 'production'/);
  assert.match(steps[smoke].run, /node node_modules\/e2e\/dist\/cli\/bin\.js run --config e2e\.production\.config\.ts --target chromium/);
  for (const [index, step] of steps.entries()) {
    if (index !== deploy) assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
  }
});


test('exact successful completion selects its SHA and stale completions emit superseded receipts', () => {
  const script = new URL('../scripts/production-candidate.py', import.meta.url).pathname;
  const harness = `
import importlib.util, json, os, tempfile, io
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('candidate', ${JSON.stringify(script)})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sha='b'*40
run=dict(id=123, run_attempt=1, name='CI', path='.github/workflows/ci.yml', head_sha=sha, head_branch='main', event='push', status='completed', conclusion='success', head_repository=dict(full_name='synthetic/app'), repository=dict(full_name='synthetic/app'))
def execute(event=None, current=sha, latest=None, broken=None):
 with tempfile.TemporaryDirectory() as tmp:
  event=event or dict(action='completed', repository=dict(full_name='synthetic/app'), workflow_run=run)
  Path(tmp,'event').write_text(json.dumps(event)); Path(tmp,'output').write_text('')
  def call(args, **kwargs):
   if broken and args[0]==broken: raise RuntimeError('fixture unavailable')
   if args[:2]==['git','fetch']: return ''
   if args==['git','rev-parse','HEAD']: return event['workflow_run']['head_sha']
   if args==['git','rev-parse','origin/main']: return current
   raise AssertionError(args)
  def fetch(request, timeout):
   assert request.full_url=='https://api.github.com/repos/'+event['repository']['full_name']+'/actions/runs/'+str(event['workflow_run']['id'])
   assert request.get_header('Authorization')=='Bearer synthetic' and timeout==45
   if broken=='http': raise RuntimeError('fixture unavailable')
   return io.StringIO(json.dumps(latest or run))
  with patch.object(module, 'urlopen', side_effect=fetch), patch.dict(os.environ, dict(GH_TOKEN='synthetic', GITHUB_EVENT_PATH=tmp+'/event', GITHUB_OUTPUT=tmp+'/output', GITHUB_REPOSITORY=event['repository']['full_name'], RUNNER_TEMP=tmp)), patch.object(module.subprocess,'check_output',side_effect=call):
   try: module.candidate(); code=0
   except (Exception,SystemExit): code=1
  return code, Path(tmp,'output').read_text(), json.loads(Path(tmp,'production-candidate.json').read_text()) if Path(tmp,'production-candidate.json').exists() else None
code, output, receipt=execute()
assert code==0 and 'source_commit='+sha in output and 'ready=true' in output
assert receipt['ci_run_id']==123 and receipt['ci_run_attempt']==1 and receipt['disposition']=='eligible'
assert execute(current='c'*40)[2]['disposition']=='superseded'
assert execute(current='unknown')[0]!=0
# Revalidation after build observes a later main and suppresses the publisher.
assert execute()[2]['disposition']=='eligible'
assert execute(current='c'*40)[2]['disposition']=='superseded'
for field,value in [('event','pull_request'),('event','merge_group'),('head_branch','feature'),('status','in_progress'),('conclusion','failure'),('conclusion','cancelled'),('conclusion','timed_out'),('head_repository',dict(full_name='fork/app'))]:
 altered=dict(run); altered[field]=value
 assert execute(dict(action='completed',repository=dict(full_name='synthetic/app'),workflow_run=altered))[0]!=0, (field,value)
for altered in [dict(run,run_attempt=2,status='in_progress',conclusion=None),dict(run,run_attempt=2,conclusion='failure'),dict(run,head_sha='a'*40),dict(run,path='.github/workflows/other.yml')]:
 assert execute(latest=altered)[0]!=0
for broken in ['http','git']: assert execute(broken=broken)[0]!=0
for order in [('a','b'),('b','a')]:
 published=[]
 for candidate in order:
  event=dict(action='completed',repository=dict(full_name='synthetic/app'),workflow_run=dict(run,head_sha=candidate*40))
  code, output, receipt=execute(event,current=sha,latest=event['workflow_run'])
  assert code==0
  if 'ready=true' in output: published.append(receipt['source_commit'])
 assert published==[sha]
recorded=json.loads(${JSON.stringify(readFileSync(new URL('./fixtures/workflow-run-main-success.json', import.meta.url),'utf8'))})
recorded_run=recorded['workflow_run']
# The same production parser contract-checks the recorded transport shape.
run=recorded_run
assert execute(recorded,current=recorded_run['head_sha'],latest=recorded_run)[0]==0
print('candidate transitions passed')
`;
  const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('native max queue retains B when older A completes and exposes capacity exhaustion', () => {
  const queueMode = workflow().jobs.production.concurrency.queue;
  const drain = (mode, arrivals) => {
    const pending = [];
    const canceled = [];
    for (const item of arrivals) {
      if (mode !== 'max') canceled.push(...pending.splice(0));
      if (pending.length === 100) canceled.push(item); else pending.push(item);
    }
    return { pending, canceled };
  };
  assert.deepEqual(drain('single', ['B', 'A']).pending.filter(sha => sha === 'B'), []);
  for (const arrivals of [['A', 'B'], ['B', 'A']]) {
    assert.deepEqual(drain(queueMode, arrivals).pending.filter(sha => sha === 'B'), ['B']);
  }
  assert.equal(drain(queueMode, Array.from({ length: 101 }, (_, i) => i)).canceled.length, 1);
});

test('release identity produces a durable receipt and rejects a mismatched provider version', async t => {
  const root = temporaryDirectory('production-receipt-', t);
  const sha = 'b'.repeat(40), version = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const fixture = await startFixture({ routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: sha, provider_version_id: version }) }]]) });
  t.after(() => fixture.close());
  writeFileSync(join(root, 'production-candidate.json'), JSON.stringify({ source_commit: sha, ci_run_id: 123, ci_run_attempt: 1 }));
  const step = workflow().jobs.production.steps.find(step => step.name === 'Verify production release identity');
  const run = async providerVersion => {
    const child = spawn('bash', ['-e', '-c', step.run.replaceAll('https://app.doctorcre.com', fixture.origin)], { env: {
      PATH: process.env.PATH, RUNNER_TEMP: root, SOURCE_COMMIT: sha, PROVIDER_VERSION_ID: providerVersion,
      PUBLICATION_OBSERVED_AT: '2026-11-11T09:00:00Z', DISPOSITION: 'already-live', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1',
    } });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; });
    const [status] = await once(child, 'close');
    return { status, errors };
  };
  assert.equal((await run(version)).status, 0);
  const receipt = JSON.parse(readFileSync(join(root, 'production-release.json'), 'utf8'));
  assert.equal(receipt.disposition, 'already-live');
  assert.equal(receipt.publication_observed_at, '2026-11-11T09:00:00Z');
  assert.equal(receipt.release.source_commit, sha);
  assert.equal(receipt.release.provider_version_id, version);
  rmSync(join(root, 'production-release.json'));
  assert.notEqual((await run('another-version')).status, 0);
  assert.throws(() => readFileSync(join(root, 'production-release.json')));
});
