import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { targets } from '../../scripts/e2e-staging/screens.mjs';

test('Playwright Test owns the staging project matrix, deadlines, artifacts and reporters', async () => {
  const config = (await import('../../playwright.staging.config.mjs')).default;
  assert.equal(config.workers, 1);
  assert.equal(config.retries, 0);
  assert.ok(config.timeout > 0);
  assert.ok(config.globalTimeout > config.timeout);
  assert.deepEqual(config.reporter.map(([name]) => name), ['list', 'json', 'html']);

  const [setup, ...projects] = config.projects;
  assert.equal(setup.name, 'staging-auth');
  assert.equal(setup.testMatch.test('auth.setup.spec.mjs'), true);
  assert.equal(setup.use.storageState, undefined);
  assert.deepEqual(projects.map(project => project.name), targets.map(target => target.name));
  for (const [index, project] of projects.entries()) {
    assert.deepEqual(project.dependencies, [index === 0 ? setup.name : projects[index - 1].name]);
    assert.equal(project.metadata.stagingTarget, targets[index].name);
    assert.match(project.use.storageState, /staging-private\/storage-state\.json$/);
    assert.deepEqual(project.use.viewport, targets[index].viewport);
    assert.equal(project.use.serviceWorkers, 'block');
    assert.deepEqual(project.use.extraHTTPHeaders, { 'x-e2e-staging-run': '1' });
    assert.equal(project.use.trace, 'retain-on-failure');
    assert.equal(project.use.screenshot, 'only-on-failure');
  }
});

test('the Playwright fixture gives every measurement a fresh context and retires leaks', async () => {
  const { createFreshPageFactory } = await import('../../scripts/e2e-staging/playwright-fixtures.mjs');
  const contexts = [];
  const browser = {
    async newContext(options) {
      const context = {
        options,
        closed: 0,
        async route() {},
        async addInitScript() {},
        async newPage() {
          return {
            context: () => context,
            async goto() { return { ok: () => true }; },
            url: () => 'https://staging.example.test/deals',
            async waitForLoadState() {},
          };
        },
        async close() { context.closed += 1; },
      };
      contexts.push(context);
      return context;
    },
  };
  const expectedRelease = { source_commit: 'a'.repeat(40), carr_source_commit: 'b'.repeat(40) };
  const fixture = createFreshPageFactory({
    browser,
    origin: 'https://staging.example.test',
    installGuard: async () => {},
    releaseProbe: async () => expectedRelease,
  });
  const screen = { path: '/deals' };
  const first = await fixture.freshPage({ screen, release: expectedRelease });
  const second = await fixture.freshPage({ screen, release: expectedRelease });
  assert.notEqual(first.context(), second.context());
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].options, undefined, 'Playwright project use owns context options');
  await fixture.dispose();
  assert.deepEqual(contexts.map(context => context.closed), [1, 1]);
});

test('custom exact-source reports are attached through testInfo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-playwright-attachments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'controls.json'), '{}\n');
  await writeFile(join(root, 'coverage.md'), '# coverage\n');
  await writeFile(join(root, 'findings.json'), '[]\n');
  const attachments = [];
  const { attachSweepArtifacts } = await import('../../scripts/e2e-staging/playwright-fixtures.mjs');
  await attachSweepArtifacts({ attach: async (name, options) => attachments.push({ name, ...options }) }, root);
  assert.deepEqual(attachments.map(row => [row.name, row.contentType]), [
    ['staging-controls', 'application/json'],
    ['staging-coverage', 'text/markdown'],
    ['staging-findings', 'application/json'],
  ]);
});

test('operator documentation names Playwright Test ownership and the resume command', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Playwright Test owns browser and context lifecycle/);
  assert.match(readme, /npm run e2e:staging:sweep:resume/);
  assert.match(readme, /storageState setup project/);
});

test('staging sweep entrypoints use Playwright Test without a second browser or trace runner', async () => {
  const packageJSON = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJSON.scripts['e2e:staging:sweep'], 'playwright test --config playwright.staging.config.mjs');
  assert.equal(packageJSON.scripts['e2e:staging:sweep:resume'], 'E2E_STAGING_RESUME=1 playwright test --config playwright.staging.config.mjs');
  const sweep = await readFile(new URL('../../scripts/e2e-staging/sweep.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sweep, /chromium|tracing\.(?:start|stop)/);
});

test('the setup project writes storageState as a private runtime credential', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-storage-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'storage-state.json');
  await mkdir(join(root, 'private'), { mode: 0o755 });
  const state = { cookies: [{ name: 'synthetic' }], origins: [] };
  const { writeStagingStorageState } = await import('../../scripts/e2e-staging/session.mjs');
  assert.equal(await writeStagingStorageState({
    async storageState({ path: destination }) {
      await writeFile(destination, JSON.stringify(state), { mode: 0o666 });
      return state;
    },
  }, path), state);
  assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
