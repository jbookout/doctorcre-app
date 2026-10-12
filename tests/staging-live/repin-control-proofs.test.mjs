import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reviewedSourceDigests, unreviewedSources } from '../../scripts/e2e-staging/control-proofs.mjs';
import { repinControlProofs } from '../../scripts/e2e-staging/repin-control-proofs.mjs';

const cli = fileURLToPath(new URL('../../scripts/e2e-staging/repin-control-proofs.mjs', import.meta.url));
const catalogPath = 'contracts/e2e-staging-control-proofs.v1.json';

async function fixture(t, handler = `import './helper.js';\nexport const close = () => {};\n`, files = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'repin-control-proofs-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  const put = async (path, text) => { await mkdir(join(cwd, path, '..'), { recursive: true }); await writeFile(join(cwd, path), text); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'synthetic@example.test');
  await put('js/handler.js', handler);
  await put('js/helper.js', `export const value = 1;\n`);
  await put('css/unrelated.css', '.page {}\n');
  for (const [path, text] of Object.entries(files)) await put(path, text);
  git('add', '--', 'js/handler.js', 'js/helper.js', 'css/unrelated.css', ...Object.keys(files)); git('commit', '-qm', 'Synthetic reviewed source');
  const controls = [{ identity: 'synthetic', review: { source: 'js/handler.js:1:2' } }];
  const catalog = { schema: 'doctorcre-staging-control-proofs.v1',
    reviewed_sources: await reviewedSourceDigests('HEAD', controls, { cwd }), carr_source_commit: 'c'.repeat(40), controls };
  await put(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  const commit = paths => { git('add', '--', ...paths); git('commit', '-qm', 'Synthetic change'); return git('rev-parse', 'HEAD'); };
  const baseline = commit([catalogPath]);
  // The catalog check preparation and CI run: the committed catalog against
  // the same commit's reviewed bytes.
  const check = async (ref = 'HEAD') => unreviewedSources(JSON.parse(git('show', `${ref}:${catalogPath}`)).reviewed_sources,
    await reviewedSourceDigests(ref, controls, { cwd }));
  return { cwd, put, git, commit, check, baseline, catalog, read: () => readFile(join(cwd, catalogPath), 'utf8') };
}

test('unrelated app PRs squash-merge without touching the catalog and main passes with no rebind', async t => {
  const f = await fixture(t), before = await f.read();
  f.git('switch', '-qc', 'style'); await f.put('css/unrelated.css', '.page { color: orange; }\n');
  const style = f.commit(['css/unrelated.css']);
  f.git('switch', '-q', 'main'); f.git('switch', '-qc', 'shell'); await f.put('index.html', '<main></main>\n');
  const shell = f.commit(['index.html']);
  for (const head of [style, shell]) assert.deepEqual(await f.check(head), []);
  f.git('switch', '-q', 'main');
  for (const branch of ['style', 'shell']) { f.git('merge', '--squash', '-q', branch); f.git('commit', '-qm', `Squash ${branch}`); }
  assert.equal(f.git('diff', '--name-only', f.baseline, 'HEAD'), 'css/unrelated.css\nindex.html');
  assert.equal(await f.read(), before);
  assert.deepEqual(await f.check(), []);
});

test('a changed reviewed file is unreviewed until it is named as re-reviewed (library and CLI)', async t => {
  const f = await fixture(t), before = await f.read();
  await f.put('js/helper.js', 'export const value = 2;\n');
  const target = f.commit(['js/helper.js']);
  assert.deepEqual(await f.check(), ['js/helper.js']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), /re-review[^]*js\/helper\.js/);
  const refused = spawnSync(process.execPath, [cli, target], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(refused.status, 1); assert.match(refused.stderr, /js\/helper\.js/);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd, reviewed: ['js/helper.js', 'js/handler.js'] }), /Not a changed reviewed file:\njs\/handler\.js/);
  assert.equal(await f.read(), before);
  const accepted = spawnSync(process.execPath, [cli, target, '--reviewed', 'js/helper.js'], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout).reviewed, ['js/helper.js']);
  const after = JSON.parse(await f.read());
  assert.deepEqual(after.controls, f.catalog.controls);
  assert.equal(after.reviewed_sources['js/handler.js'], f.catalog.reviewed_sources['js/handler.js']);
  assert.equal((await f.read()).split('\n').filter((line, i) => line !== before.split('\n')[i]).length, 1, 'only the re-reviewed digest line moves');
  f.commit([catalogPath]); assert.deepEqual(await f.check(), []);
});

test('a new import in a reviewed file brings the imported file under review', async t => {
  const f = await fixture(t);
  await f.put('js/extra.js', 'export const extra = 1;\n');
  await f.put('js/handler.js', `import './helper.js';\nimport './extra.js';\nexport const close = () => {};\n`);
  f.commit(['js/extra.js', 'js/handler.js']);
  assert.deepEqual(await f.check(), ['js/extra.js', 'js/handler.js']);
});

test('refuses changed transitive imports, re-exports, side effects and literal dynamic imports', async t => {
  const f = await fixture(t, `// import './missing.js'\nconst text = "import './also-missing.js'";\nimport './helper.js';\nexport * from './bridge.js';\nimport('./lazy.js');\nconst url = import.meta.url;\n`,
    { 'js/bridge.js': `export { value } from './deep.js';\n`, 'js/deep.js': 'export const value = 1;\n', 'js/lazy.js': 'export default 1;\n' });
  assert.deepEqual(Object.keys(f.catalog.reviewed_sources), ['js/bridge.js', 'js/deep.js', 'js/handler.js', 'js/helper.js', 'js/lazy.js']);
  await f.put('js/deep.js', 'export const value = 2;\n');
  await f.put('js/lazy.js', 'export default 2;\n');
  const target = f.commit(['js/deep.js', 'js/lazy.js']);
  assert.deepEqual(await f.check(), ['js/deep.js', 'js/lazy.js']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), error => /js\/deep\.js/.test(error.message) && /js\/lazy\.js/.test(error.message));
});

test('refuses removed imported files', async t => {
  const f = await fixture(t); f.git('rm', '-q', '--', 'js/helper.js');
  f.git('commit', '-qm', 'Synthetic removal'); const target = f.git('rev-parse', 'HEAD');
  await assert.rejects(f.check(), /js\/helper\.js/);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd, reviewed: ['js/helper.js'] }), /js\/helper\.js/);
});

test('refuses computed dynamic imports and missing dependencies', async t => {
  for (const handler of [`import('./' + name);`, `import './missing.js';`])
    await assert.rejects(fixture(t, handler), /js\/(handler|missing)\.js/);
});

test('refuses unsafe review paths and invalid commits without writing', async t => {
  const f = await fixture(t), before = await f.read();
  await assert.rejects(repinControlProofs('--help', { cwd: f.cwd }), /Usage/);
  await assert.rejects(repinControlProofs('no-such-ref', { cwd: f.cwd }));
  assert.equal(await f.read(), before);
  const catalog = JSON.parse(before); catalog.controls[0].review.source = '../outside.js';
  await f.put(catalogPath, JSON.stringify(catalog));
  await assert.rejects(repinControlProofs(f.baseline, { cwd: f.cwd }), /outside\.js/);
});

test('CLI accepts a commit ref and emits the resolved source commit', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [cli, 'HEAD'], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source_commit, f.baseline);
  assert.equal(spawnSync(process.execPath, [cli, 'HEAD', '--accept', 'js/helper.js'], { cwd: f.cwd, encoding: 'utf8', timeout: 10000 }).status, 1);
});

test('inspects generated slice imports from committed inputs and refuses changed generated output', async t => {
  const f = await fixture(t, `import './slices.generated.js';\n`, {
    'js/slices/synthetic.js': `export default { id: 'synthetic', files: ['index.html'], navigation: [] };\n`,
    'contracts/routes.v1.json': JSON.stringify({ schema: 'doctorcre-app-routes.v1', version: '1.0.0' }),
    'contracts/slice-ownership.v1.json': JSON.stringify({ schema: 'doctorcre-slice-ownership.v1', shared: [] }),
    'contracts/routes/synthetic.json': JSON.stringify({ routes: [{ path: '/', asset: 'index.html', order: 1, gatePath: '/' }] }),
  });
  assert.deepEqual(Object.keys(f.catalog.reviewed_sources), ['js/handler.js', 'js/slices.generated.js', 'js/slices/synthetic.js']);
  await f.put('contracts/routes.v1.json', JSON.stringify({ schema: 'doctorcre-app-routes.v1', version: '1.0.1' }));
  const target = f.commit(['contracts/routes.v1.json']);
  assert.deepEqual(await f.check(), ['js/slices.generated.js']);
  await assert.rejects(repinControlProofs(target, { cwd: f.cwd }), /js\/slices\.generated\.js/);
});
