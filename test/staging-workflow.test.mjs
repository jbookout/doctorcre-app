import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fixtureProducerCommit } from '../tests/staging/journey-fixture.mjs';

const workflow = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load(STDIN.read))'], {
  input: readFileSync(new URL('../.github/workflows/staging-e2e.yml', import.meta.url), 'utf8'), encoding: 'utf8',
}));

test('signed-in staging runs nightly, manually and for its PR changes with the staging environment secret', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events.schedule, [{ cron: '0 9 * * *' }]);
  assert.ok(Object.hasOwn(events, 'workflow_dispatch'));
  for (const path of ['.github/workflows/staging-e2e.yml', 'tests/staging/**']) assert.ok(events.pull_request.paths.includes(path));
  assert.equal(document.permissions.contents, 'read');
  const job = document.jobs.staging;
  assert.equal(job.environment, 'staging');
  assert.ok(job['timeout-minutes'] <= 60);
  const run = job.steps.find(step => step.run?.includes('playwright test'));
  assert.match(run.run, /--project=chromium/);
  assert.match(run.run, /--retries=1/);
  assert.equal(run.env.E2E_SESSION_SECRET, '${{ secrets.E2E_SESSION_SECRET }}');
  assert.equal(run['continue-on-error'], undefined);
  assert.ok(job.steps.some(step => step.if?.includes('!cancelled()') && step.run?.includes('staging-summary.mjs')));
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(upload.if, /failure\(\)/);
  assert.equal(upload.with['include-hidden-files'], true);
  assert.match(upload.with.path, /playwright-report/);
  assert.match(upload.with.path, /\.e2e\/playwright/);
  assert.doesNotMatch(upload.with.path, /\.auth/);
});

test('staging journeys install their exact CARR producer and bind its provider credential', () => {
  const steps = workflow().jobs.staging.steps;
  const checkout = steps.find(step => step.with?.path === 'carr-fixture-producer');
  assert.equal(checkout?.with.repository, 'DoctorCRE/carr-system');
  assert.equal(checkout.with.ref, fixtureProducerCommit);
  assert.equal(checkout.with['persist-credentials'], false);
  const install = steps.find(step => step.name === 'Install staging fixture producer');
  assert.match(install?.run || '', /python3 -m venv carr-fixture-producer\/\.venv/);
  assert.match(install.run, /npm ci --prefix carr-fixture-producer\/mcp-server/);
  const run = steps.find(step => step.id === 'playwright');
  assert.equal(run.env.CARR_JOURNEY_FIXTURE_REPO, '${{ github.workspace }}/carr-fixture-producer');
  assert.equal(run.env.NEON_API_KEY, '${{ secrets.NEON_API_KEY }}');
});

test('staging deploys the tested commit before signed-in journeys and keeps the deploy secret out of build steps', () => {
  const document = workflow();
  const events = document.on ?? document.true;
  assert.deepEqual(events.push.branches, ['main']);
  assert.ok(events.pull_request.paths.includes('**'));
  for (const path of ['!test/**', '!tests/**', 'tests/staging/**']) assert.ok(events.pull_request.paths.includes(path));
  const job = document.jobs.staging;
  assert.match(job.if, /head\.repo\.full_name == github\.repository/);
  assert.equal(document.concurrency['cancel-in-progress'], false);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  const build = job.steps.findIndex(step => step.run === 'npm run build');
  const deploy = job.steps.findIndex(step => step.run?.includes('npm run release:staging'));
  const readback = job.steps.findIndex(step => step.run?.includes('scripts/verify-app-release.mjs'));
  const journeys = job.steps.findIndex(step => step.id === 'playwright');
  assert.ok(build >= 0 && build < deploy && deploy < readback && readback < journeys);
  assert.equal(job.steps[build].env.DOCTORCRE_SOURCE_COMMIT, '${{ github.sha }}');
  assert.match(job.steps[deploy].run, /--source-sha "\$SOURCE_COMMIT"/);
  assert.equal(job.steps[deploy].env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  for (const [index, step] of job.steps.entries()) {
    if (index !== deploy) assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
  }
});
