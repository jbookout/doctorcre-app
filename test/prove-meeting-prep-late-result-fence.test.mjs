import { handleDoctorcreRequest } from '../src/worker.js';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startFixture } from '../scripts/fixture-http.mjs';
import { chromium } from 'playwright';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { prove } from '../scripts/prove-meeting-prep-late-result-fence.mjs';

const exec = promisify(execFile);
test('proof CLI passes working-tree Home and rejects a missing layout retirement fence', async t => {
  const out = temporaryDirectory('prep-fence-proof-');
  t.after(() => rm(out, { recursive: true, force: true }));
  const built = await buildArtifact({ root: process.cwd(), outDir: out });
  const args = ['scripts/prove-meeting-prep-late-result-fence.mjs', '--fixture-root', join(out, 'site'), '--timeout-ms', '30000'];
  const site = resolve(out, 'site');
  async function snapshot() {
    const assets = await loadFixtureAssets({ root: site, manifest: new Map(built.manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
    const release = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: '1'.repeat(40) });
    assets.set('/app-release', { contentType: release.headers.get('content-type'), status: release.status, body: await release.text() });
    const fixture = await startFixture({ assets }); t.after(() => fixture.close()); return fixture;
  }
  let server = await snapshot();
  await writeFile(join(out, 'outside-marker.js'), 'synthetic outside artifact');
  await writeFile(join(out, 'site-outside-marker.js'), 'synthetic sibling prefix');
  for (const path of ['/js/%2e%2e/js/app-layout.js', '/../outside-marker.js', '/%2e%2e%2foutside-marker.js', '/..%2fsite-outside-marker.js', '/%2E%2E/outside-marker.js']) {
    await t.test(`fixture server refuses traversal ${path}`, async () => {
      const response = await new Promise((resolve, reject) => {
        get({ hostname: '127.0.0.1', port: new URL(server.origin).port, path }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
      });
      assert.equal(response.status, 400);
      assert.equal(response.body, '');
    });
  }
  const productionArgs = [args[0], '--origin', server.origin, '--timeout-ms', '30000'];
  const deployed = JSON.parse((await exec(process.execPath, productionArgs, { timeout: 40000 })).stdout);
  assert.equal(deployed.release.source_commit, '1'.repeat(40));
  assert.equal(deployed.evidence, 'deployed_home_modules_with_contract_fixture');
  const pass = await exec(process.execPath, args, { timeout: 40000 });
  const receipt = JSON.parse(pass.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.evidence, 'local_fixture');
  assert.equal(receipt.observation.closed_without_repaint, true);
  assert.equal(receipt.observation.fresh_read_recovery, true);
  assert.ok(receipt.loaded_assets.some(asset => asset.path === '/js/live-client.js'));
  const path = join(out, 'site/js/app-layout.js');
  const source = await readFile(new URL('../js/app-layout.js', import.meta.url), 'utf8');
  const broken = source.replace('const preparationSignal = AbortSignal.any([signal, interaction.signal]);', 'const preparationSignal = signal;')
    .replace('if (interaction.current()) panels?.render', 'panels?.render');
  assert.notEqual(broken, source, 'working-tree mutation removes the layout close fence');
  await server.close();
  await writeFile(path, broken);
  server = await snapshot();
  productionArgs[productionArgs.indexOf('--origin') + 1] = server.origin;
  for (const flags of [args, productionArgs]) await assert.rejects(exec(process.execPath, flags, { timeout: 40000 }), error => {
    assert.equal(error.code, 1, error.stdout + error.stderr);
    assert.match(JSON.parse(error.stdout).error, /Retired preparation repainted after close/);
    return true;
  });
});

for (const mode of ['stalled evaluation', 'late launch']) test(`proof deadline closes owned browser after ${mode}`, async t => {
  const root = temporaryDirectory('prep-fence-timeout-');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'js'));
  await writeFile(join(root, 'js/app-layout.js'), '');
  t.after(() => rm(root, { recursive: true, force: true }));
  let owned, acquisition, evaluating = false;
  t.after(async () => { await acquisition?.catch(() => {}); await owned?.close(); });
  const engine = { launch(options) {
    acquisition = (async () => {
      owned = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])], timeout: 10000 });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 150));
      else {
        const newPage = owned.newPage.bind(owned);
        owned.newPage = async (...args) => {
          const page = await newPage(...args);
          page.evaluate = () => { evaluating = true; return new Promise(() => {}); };
          return page;
        };
      }
      return owned;
    })();
    return acquisition;
  } };
  await assert.rejects(prove({ fixtureRoot: root, timeoutMs: mode === 'late launch' ? 100 : 3000, engine }), error => error.exitCode === 78);
  await acquisition;
  await new Promise(resolve => setTimeout(resolve, 150));
  if (mode === 'stalled evaluation') assert.equal(evaluating, true);
  assert.equal(owned.isConnected(), false, 'zero surviving owned browser processes');
});
