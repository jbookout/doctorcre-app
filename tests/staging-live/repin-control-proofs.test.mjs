import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applicationSourceFingerprint } from '../../scripts/e2e-staging/control-proofs.mjs';
import { repinControlProofs } from '../../scripts/e2e-staging/repin-control-proofs.mjs';

const cli = fileURLToPath(new URL('../../scripts/e2e-staging/repin-control-proofs.mjs', import.meta.url));
const catalogPath = 'contracts/e2e-staging-control-proofs.v1.json';

async function fixture(t, handler = `import './helper.js';\nexport const close = () => {};\n`) {
  const cwd = await mkdtemp(join(tmpdir(), 'repin-control-proofs-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  const put = async (path, text) => { await mkdir(join(cwd, path, '..'), { recursive: true }); await writeFile(join(cwd, path), text); };
  git('init', '-q'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'synthetic@example.test');
  await put('js/handler.js', handler);
  await put('js/helper.js', `export const value = 1;\n`);
  await put('css/unrelated.css', '.page {}\n');
  git('add', '--', 'js/handler.js', 'js/helper.js', 'css/unrelated.css'); git('commit', '-qm', 'Synthetic reviewed source');
  const baseline = git('rev-parse', 'HEAD');
  const catalog = { schema: 'doctorcre-staging-control-proofs.v1', reviewed_source_commit: baseline,
    application_source_sha256: applicationSourceFingerprint(execFileSync('git', ['ls-tree', '-r', '-z', baseline], { cwd, encoding: 'utf8' })),
    carr_source_commit: 'c'.repeat(40), controls: [{ identity: 'synthetic', review: { source: 'js/handler.js:1:2' } }] };
  await put(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  const commit = paths => { git('add', '--', ...paths); git('commit', '-qm', 'Synthetic change'); return git('rev-parse', 'HEAD'); };
  return { cwd, put, git, commit, baseline, catalog, read: () => readFile(join(cwd, catalogPath), 'utf8') };
}

test('re-pins unrelated changes using the preparation fingerprint and preserves proof bytes', async t => {
  const f = await fixture(t), before = await f.read();
  await f.put('css/unrelated.css', '.page { color: orange; }\n');
  const target = f.commit(['css/unrelated.css']);
  await f.put('js/helper.js', 'uncommitted bytes must not be read');
  const result = await repinControlProofs(target, { cwd: f.cwd });
  const after = JSON.parse(await f.read());
  assert.equal(after.reviewed_source_commit, target);
  assert.equal(after.application_source_sha256, applicationSourceFingerprint(execFileSync('git', ['ls-tree', '-r', '-z', target], { cwd: f.cwd, encoding: 'utf8' })));
  assert.notEqual(after.application_source_sha256, f.catalog.application_source_sha256);
  assert.deepEqual(result.reviewed_sources, ['js/handler.js', 'js/helper.js']);
  assert.equal(await f.read(), before.replace(f.baseline, target).replace(f.catalog.application_source_sha256, after.application_source_sha256));
  assert.deepEqual(after.controls, f.catalog.controls);
});

test('refuses a changed reviewed source, names it and leaves the catalog intact (library and CLI)', async t => {
  const f = await fixture(t), before = await f.read();
  await f.put('js/handler.js', 'export const close = () => fetch("/mcp");\n');
  const target = f.commit(['js/handler.js']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), /js\/handler\.js/);
  const result = spawnSync(process.execPath, [cli, target], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /js\/handler\.js/);
  assert.equal(await f.read(), before);
});

test('refuses changed transitive imports, re-exports, side effects and literal dynamic imports', async t => {
  const f = await fixture(t, `// import './missing.js'\nconst text = "import './also-missing.js'";\nimport './helper.js';\nexport * from './bridge.js';\nimport('./lazy.js');\nconst url = import.meta.url;\n`);
  await f.put('js/bridge.js', `export { value } from './deep.js';\n`);
  await f.put('js/deep.js', 'export const value = 1;\n');
  await f.put('js/lazy.js', 'export default 1;\n');
  const reviewed = f.commit(['js/bridge.js', 'js/deep.js', 'js/lazy.js']);
  const catalog = JSON.parse(await f.read()); catalog.reviewed_source_commit = reviewed;
  catalog.application_source_sha256 = applicationSourceFingerprint(execFileSync('git', ['ls-tree', '-r', '-z', reviewed], { cwd: f.cwd, encoding: 'utf8' }));
  await f.put(catalogPath, JSON.stringify(catalog));
  await f.put('js/deep.js', 'export const value = 2;\n');
  await f.put('js/lazy.js', 'export default 2;\n');
  const target = f.commit(['js/deep.js', 'js/lazy.js']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), error => /js\/deep\.js/.test(error.message) && /js\/lazy\.js/.test(error.message));
});

test('refuses removed imported files', async t => {
  const f = await fixture(t); f.git('rm', '-q', '--', 'js/helper.js');
  f.git('commit', '-qm', 'Synthetic removal'); const target = f.git('rev-parse', 'HEAD');
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), /js\/helper\.js/);
});

test('refuses computed dynamic imports and missing dependencies', async t => {
  for (const handler of [`import('./' + name);`, `import './missing.js';`]) {
    const f = await fixture(t, handler);
    await assert.rejects(repinControlProofs(f.baseline, { cwd: f.cwd }), /js\/(handler|missing)\.js/);
  }
});

test('refuses unsafe review paths and invalid commits without writing', async t => {
  const f = await fixture(t), before = await f.read();
  await assert.rejects(repinControlProofs('--help', { cwd: f.cwd }));
  assert.equal(await f.read(), before);
  const catalog = JSON.parse(before); catalog.controls[0].review.source = '../outside.js';
  await f.put(catalogPath, JSON.stringify(catalog));
  await assert.rejects(repinControlProofs(f.baseline, { cwd: f.cwd }), /outside\.js/);
});

test('CLI accepts a commit ref and emits the resolved source commit', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [cli, 'HEAD'], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reviewed_source_commit, f.baseline);
});

test('inspects generated slice imports from committed inputs and refuses changed generated output', async t => {
  const f = await fixture(t, `import './slices.generated.js';\n`);
  await f.put('js/slices/synthetic.js', `export default { id: 'synthetic', files: ['index.html'], navigation: [] };\n`);
  await f.put('contracts/routes.v1.json', JSON.stringify({ schema: 'doctorcre-app-routes.v1', version: '1.0.0' }));
  await f.put('contracts/slice-ownership.v1.json', JSON.stringify({ schema: 'doctorcre-slice-ownership.v1', shared: [] }));
  await f.put('contracts/routes/synthetic.json', JSON.stringify({ routes: [{ path: '/', asset: 'index.html', order: 1, gatePath: '/' }] }));
  const reviewed = f.commit(['js/slices/synthetic.js', 'contracts/routes.v1.json', 'contracts/slice-ownership.v1.json', 'contracts/routes/synthetic.json']);
  const catalog = JSON.parse(await f.read()); catalog.reviewed_source_commit = reviewed;
  catalog.application_source_sha256 = applicationSourceFingerprint(execFileSync('git', ['ls-tree', '-r', '-z', reviewed], { cwd: f.cwd, encoding: 'utf8' }));
  await f.put(catalogPath, JSON.stringify(catalog));
  const result = await repinControlProofs(reviewed, { cwd: f.cwd });
  assert.ok(result.reviewed_sources.includes('js/slices/synthetic.js'));
  await f.put('contracts/routes.v1.json', JSON.stringify({ schema: 'doctorcre-app-routes.v1', version: '1.0.1' }));
  const target = f.commit(['contracts/routes.v1.json']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), /js\/slices\.generated\.js/);
});

test('refuses a catalog whose reviewed commit and fingerprint disagree', async t => {
  const f = await fixture(t), catalog = JSON.parse(await f.read());
  catalog.application_source_sha256 = 'f'.repeat(64); await f.put(catalogPath, JSON.stringify(catalog));
  await assert.rejects(repinControlProofs(f.baseline, { cwd: f.cwd }), /fingerprint/);
});
