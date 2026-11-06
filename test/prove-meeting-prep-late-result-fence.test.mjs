import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from './proof-fixture-server.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { chromium } from 'playwright';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { prove } from '../scripts/prove-meeting-prep-late-result-fence.mjs';

const exec = promisify(execFile);
test('proof CLI passes working-tree Home and rejects a missing layout retirement fence', async t => {
  const out = temporaryDirectory('prep-fence-proof-');
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir: out });
  const args = ['scripts/prove-meeting-prep-late-result-fence.mjs', '--fixture-root', join(out, 'site'), '--timeout-ms', '30000'];
  const site = resolve(out, 'site');
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') {
      const response = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: '1'.repeat(40) });
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text()); return;
    }
    try {
      const path = decodeURIComponent(req.url);
      assert.ok(!path.includes('\\') && !path.includes(String.fromCharCode(0)));
      const file = resolve(site, '.' + path);
      assert.ok(file.startsWith(site + sep));
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const productionArgs = [args[0], '--origin', `http://127.0.0.1:${server.address().port}`, '--timeout-ms', '30000'];
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
  const source = await readFile(path, 'utf8');
  const broken = source.replaceAll('doctorcre:meeting-preparation-closed', 'synthetic-disabled-close-fence');
  assert.notEqual(broken, source, 'working-tree mutation removes the layout close fence');
  await writeFile(path, broken);
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
