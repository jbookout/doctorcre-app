import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, '.cursor/skills/verify-doctorcre/verify-doctorcre.mjs');
async function call(run, ...args) {
  try {
    const result = await exec(process.execPath, [cli, ...args, '--run', run], { cwd: root, timeout: 90_000 });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.code };
  }
}
async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}
function passed(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

test('verification CLI owns independent instances and retains checked proof after cleanup', { timeout: 180_000 }, async t => {
  const first = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-first-')), 'run');
  const second = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-second-')), 'run');
  t.after(async () => { await call(first, 'cleanup'); await call(second, 'cleanup'); });
  passed(await call(first, 'launch'));
  passed(await call(second, 'launch'));
  passed(await call(first, 'doctor'));
  passed(await call(second, 'doctor'));
  const statePath = join(first, 'scratch/state.json');
  const original = await readFile(statePath, 'utf8');
  const state = JSON.parse(original);
  const other = JSON.parse(await readFile(join(second, 'scratch/state.json'), 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...state, origin: other.origin }));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'the server PID must own the stated port');
  await writeFile(statePath, JSON.stringify({ ...state, nonce: '00000000-0000-4000-8000-000000000000' }));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'a PID without the ownership nonce cannot be driven');
  await writeFile(statePath, original);
  assert.notEqual((await call(first, 'launch')).code, 0, 'a second launch cannot replace an owned instance');
  assert.notEqual((await call(first, 'drive', 'unknown-feature')).code, 0, 'unknown features cannot pass');
  passed(await call(first, 'drive', 'home'));
  passed(await call(first, 'evidence'));
  const proof = (await files(join(first, 'evidence'))).filter(path => /\.(png|zip|txt|json)$/.test(path) && !path.endsWith('/manifest.json'));
  assert.ok(proof.some(path => path.endsWith('.png')), 'proof includes visible app state');
  assert.ok(proof.some(path => path.endsWith('.zip')), 'proof includes the action trace');
  const bytes = new Map(await Promise.all(proof.map(async path => [path, await readFile(path)])));
  passed(await call(first, 'cleanup'));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'a cleaned instance is not driveable');
  passed(await call(second, 'doctor'));
  passed(await call(first, 'evidence'));
  for (const [path, expected] of bytes) assert.deepEqual(await readFile(path), expected, `cleanup preserves ${path}`);
  await appendFile(proof.find(path => path.endsWith('.png')), 'tampered-proof');
  assert.notEqual((await call(first, 'evidence')).code, 0, 'evidence must read artifact bytes and reject a changed digest');
});

test('feature map keeps poteto sections, schema shape, and executable recipes aligned', async () => {
  const directory = join(root, '.cursor/skills/verify-doctorcre/features');
  const parse = text => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  const index = parse(await readFile(join(directory, 'README.md'), 'utf8'));
  assert.equal(index.schema, 'verify-feature-map.v1');
  assert.equal(index.product, 'doctorcre');
  const { recipes } = await import('../.cursor/skills/verify-doctorcre/recipes.mjs');
  assert.deepEqual(index.features.map(row => row.id).sort(), Object.keys(recipes).sort());
  assert.deepEqual((await readdir(directory)).filter(path => path !== 'README.md').sort(), index.features.map(row => row.file.slice(9)).sort());
  for (const row of index.features) {
    const source = await readFile(join(directory, row.file.slice(9)), 'utf8');
    assert.deepEqual([...source.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
      'Sub-features', 'How to get to it (user POV)', 'Driving it with verify-doctorcre', 'Gotchas',
    ]);
    assert.match(source, /Preconditions:/);
    const feature = parse(source);
    assert.deepEqual(Object.keys(feature).sort(), ['id', 'title', 'entryPoints', 'subFeatures', 'userRoute', 'observableEndState', 'storedValues', 'gotchas'].sort());
    assert.equal(feature.id, row.id);
    assert.ok(feature.entryPoints.length);
    assert.equal(new Set(feature.entryPoints.map(entry => entry.id)).size, feature.entryPoints.length);
    for (const entry of feature.entryPoints) {
      assert.deepEqual(Object.keys(entry).sort(), ['handles', 'id', 'route']);
      assert.ok(entry.route.startsWith('/') && !entry.route.includes('mode=live'));
      assert.ok(entry.handles.length);
    }
  }
});
