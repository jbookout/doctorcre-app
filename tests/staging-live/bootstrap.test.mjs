import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../../', import.meta.url));
async function cleanCheckout(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-staging-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', project, root]);
  // Include the change under test; generated inputs and credentials are never copied.
  for (const path of ['package.json', 'scripts/e2e-staging'])
    await cp(join(project, path), join(root, path), { recursive: true });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  return root;
}
const invoke = (root, args) => execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
const npm = (root, script) => execFileSync('npm', ['run', script], { cwd: root, encoding: 'utf8', timeout: 30_000 });

// Shapes observed in the 2026-10-09 findings: all first-control coverage failures,
// the five unsettled inventories, and Calendar's workspace/operation failures.
const coveragePaths = ['/control-room', '/deals', '/calendar', '/ideas-events', '/work-requests', '/tours', '/share',
  '/design-lab', '/all-work', '/search', '/status', '/incidents', '/updates', '/doc-chats', '/doc-chats/work',
  '/relationships', '/control-room/automations', '/doc-activity', '/leases', '/?view=charts', '/deals?view=national'];
const inventoryPaths = ['/', '/leads', '/clients', '/vendors', '/invoices', '/control-room/observatory', '/tours/day.html'];

test('clean staging entrypoints build route and static inventories before a worker starts', async t => {
  const root = await cleanCheckout(t);
  await assert.rejects(readFile(join(root, 'contracts/app-routes.v1.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'dist/doctorcre-app.manifest.json')), { code: 'ENOENT' });
  for (const mode of ['sweep', 'sweep:resume', 'explore']) {
    await rm(join(root, 'dist'), { recursive: true, force: true });
    await rm(join(root, 'contracts/app-routes.v1.json'), { force: true });
    npm(root, 'pree2e:staging:' + mode);
    const routes = JSON.parse(await readFile(join(root, 'contracts/app-routes.v1.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(root, 'dist/doctorcre-app.manifest.json'), 'utf8'));
    assert.ok(routes.routes['/']);
    assert.ok(manifest.files.some(row => row.path.startsWith('css/')));
    assert.ok(manifest.files.some(row => row.path.startsWith('js/')));
  }
});

test('missing static inventory reproduces read refusal and poisoned coverage; build fixes every captured shape', async t => {
  const root = await cleanCheckout(t);
  npm(root, 'slices:check'); // The operator workaround generated only routes, leaving dist absent.
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { readFile, writeFile, mkdir } from 'node:fs/promises';
    import { randomUUID } from 'node:crypto';
    import { openRun } from './scripts/e2e-staging/run-limits.mjs';
    import { stagingFixtureWriteGuard, assertStagingBrowserInventory } from './scripts/e2e-staging/records.mjs';
    import { STAGING_ORIGIN } from './scripts/e2e-staging/session.mjs';
    const missing = process.argv[2] === 'missing';
    if (missing) {
      await assert.rejects(assertStagingBrowserInventory(), e => e.code === 'browser-inventory-unavailable');
      const guard = stagingFixtureWriteGuard({ run: { check() {}, onStop() {} } });
      await assert.rejects(guard.handle({ method: () => 'GET', url: () => STAGING_ORIGIN + '/js/client.js' },
        () => assert.fail('unproved static read forwarded')), e => e.code === 'browser-inventory-unavailable');
      await assert.rejects(guard.assertCoverage(), e => e.code === 'write-coverage-incomplete');
      assert.equal(guard.refusals[0].forwarded, false);
      console.log('inventory refused before setup');
      process.exit(0);
    }
    await assertStagingBrowserInventory();
    const manifest = JSON.parse(await readFile('./dist/doctorcre-app.manifest.json'));
    const routes = JSON.parse(await readFile('./contracts/app-routes.v1.json'));
    const contract = JSON.parse(await readFile('./contracts/e2e-staging.v1.json'));
    const release = { source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
    process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
    for (const path of ${JSON.stringify([...coveragePaths, ...inventoryPaths, '/calendar?view=month&d=2028-02-29'])}) {
      const output = './probe-output'; await mkdir(output, { recursive: true });
      const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: STAGING_ORIGIN, state: 'complete',
        run: randomUUID(), release, records: {}, receipts: {} };
      await writeFile(output + '/staging-records-plan.json', JSON.stringify(plan), { mode: 0o600 });
      const run = openRun(output, { events: null });
      const guard = stagingFixtureWriteGuard({ output, release, run,
        persist: (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 }) });
      const req = (path, method = 'GET') => ({ url: () => STAGING_ORIGIN + path, method: () => method, postDataJSON: () => ({}) });
      const forward = async () => ({ status: () => 200 });
      await guard.handle(req(path), forward);
      // Exercise actual CSS/module URLs consumed by these screens, through the same guard.
      const asset = routes.routes[new URL(path, STAGING_ORIGIN).pathname] || new URL(path, STAGING_ORIGIN).pathname.slice(1) || 'calendar.html';
      const html = await readFile('./dist/site/' + asset, 'utf8');
      for (const match of html.matchAll(/(?:src|href)=["'](\/(?:css|js|tours)\/[^"']+)["']/g))
        await guard.handle(req(match[1]), forward);
      for (const row of path === '/' ? manifest.files.filter(row => /^(css|js)\//.test(row.path)) : [])
        await guard.handle(req('/' + row.path), forward);
      await guard.assertCoverage();
      assert.equal(guard.refusals.length, 0, path);
      const stored = JSON.parse(await readFile(output + '/staging-records-plan.json'));
      assert.equal(stored.browser_write_attempts, undefined);
      await assert.rejects(guard.handle(req('/api/tours/create', 'POST'), () => assert.fail('unproved write forwarded')),
        e => e.code === 'operation-scope-unproved');
      await assert.rejects(guard.assertCoverage(), e => e.code === 'write-coverage-incomplete');
      run.dispose();
    }
    console.log('captured shapes admitted; unproved writes refused');
  `;
  await writeFile(join(root, 'probe.mjs'), probe);
  assert.match(invoke(root, ['probe.mjs', 'missing']), /inventory refused before setup/);
  npm(root, 'pree2e:staging:sweep');
  assert.match(invoke(root, ['probe.mjs', 'built']), /captured shapes admitted; unproved writes refused/);
  const manifestPath = join(root, 'dist/doctorcre-app.manifest.json');
  for (const value of ['{broken}', 'null', '{"schema":"unexpected","files":[]}',
    '{"schema":"doctorcre-static-artifact.v1","files":[]}',
    '{"schema":"doctorcre-static-artifact.v1","files":[{"path":"js/../api/tours/create"}]}']) {
    await writeFile(manifestPath, value);
    assert.match(invoke(root, ['probe.mjs', 'missing']), /inventory refused before setup/);
  }

});
