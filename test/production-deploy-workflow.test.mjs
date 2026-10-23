import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load(STDIN.read))'], {
  input: readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8'), encoding: 'utf8',
}));

test('production accepts only a successful same-repository main push staging run and pins its exact source', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events.workflow_run, { workflows: ['Signed-in staging tests'], types: ['completed'] });
  assert.deepEqual(Object.keys(events), ['workflow_run']);
  const job = document.jobs.production;
  for (const clause of ["conclusion == 'success'", "head_branch == 'main'", "event == 'push'", 'head_repository.full_name == github.repository']) assert.ok(job.if.includes(clause));
  assert.equal(job.environment, 'production');
  assert.equal(document.concurrency['cancel-in-progress'], false);
  assert.equal(document.permissions.contents, 'read');
  assert.equal(document.permissions.actions, 'read');
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
  const ci = steps.findIndex(step => step.name === 'Require successful main CI');
  const build = steps.findIndex(step => step.run === 'npm run build');
  const deploy = steps.findIndex(step => step.name === 'Deploy production');
  const readback = steps.findIndex(step => step.name === 'Verify production release identity');
  const smoke = steps.findIndex(step => step.name === 'Run production browser smoke');
  assert.ok(ci >= 0 && ci < build && build < deploy && deploy < readback && readback < smoke);
  assert.match(steps[ci].run, /--workflow ci\.yml --commit "\$SOURCE_COMMIT" --event push/);
  assert.match(steps[ci].run, /gh run watch "\$ci_run" --exit-status/);
  assert.match(steps[deploy].run, /node scripts\/release-production\.mjs/);
  assert.equal(steps[deploy].env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  assert.match(steps[readback].run, /verify-app-release\.mjs.*"\$SOURCE_COMMIT" production/);
  assert.match(steps[smoke].run, /node node_modules\/e2e\/dist\/cli\/bin\.js run --config e2e\.production\.config\.ts --target chromium/);
  for (const [index, step] of steps.entries()) {
    if (index !== deploy) assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
  }
});
