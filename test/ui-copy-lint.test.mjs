import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = new URL('../scripts/check-ui-copy.mjs', import.meta.url);
const banned = ['Nothing needs you right now', 'nothing needs your decision', 'What needs you', 'Needs you',
  'Deals that need you', 'One thing is broken, nothing is stuck', 'Nothing is waiting on you', 'Everything is clear', 'WHAT\nNEEDS\tYOUR attention',
  // Internal vocabulary retired from partner screens.
  'Work record', 'Add work record', 'Search work records', 'Recheck Quill', 'Quill local recorder', 'Checking Quill on this device',
  'runs on the Mac with Quill', 'checked by Jev', 'Automatic Jev checks', 'Reason not yet classified'];
for (const phrase of banned) test(`UI copy lint rejects planted narration: ${JSON.stringify(phrase)}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'doctorcre-ui-copy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'planted.html'); await writeFile(path, `<h2>${phrase}</h2>`);
  const result = spawnSync(process.execPath, [checker.pathname, path], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /UI copy[\s\S]*planted\.html:1/);
});
test('UI copy lint accepts factual labels and empty states', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'doctorcre-ui-copy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'factual.html'); await writeFile(path, '<h2>Local deals</h2><p>All deals up to date</p><span>Overdue</span><p>No pending decisions</p>');
  const result = spawnSync(process.execPath, [checker.pathname, path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all application UI and fixture copy passes the CI lint', () => {
  const result = spawnSync('npm', ['run', 'copy:check'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('UI copy CLI requires explicit source paths', () => {
  const result = spawnSync(process.execPath, [checker.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires source paths/);
});


test('configured CI lint covers React island source', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'doctorcre-copy-roots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ['scripts', 'js', 'css', 'data', 'public-shell', 'reports', 'tours', 'test/fixtures', 'tests/fixtures', 'src/ui'])
    await mkdir(join(dir, path), { recursive: true });
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { 'copy:check': pkg.scripts['copy:check'] } }));
  await writeFile(join(dir, 'scripts/check-ui-copy.mjs'), await readFile(checker));
  await writeFile(join(dir, 'index.html'), '<h1>Deals</h1>');
  const run = () => spawnSync('npm', ['run', 'copy:check'], { cwd: dir, encoding: 'utf8' });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  await writeFile(join(dir, 'src/ui/planted.tsx'), '<span>Needs you</span>');
  const planted = run();
  assert.equal(planted.status, 1, planted.stdout + planted.stderr);
  assert.match(planted.stderr, /planted\.tsx:1/);
});

test('UI copy lint rejects internal values in Today move sentences', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'doctorcre-moves-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'today-moves.mjs');
  await writeFile(path, 'export function todayMoveSentence(move) { return `Updated ${move.field} ${move.move_value}`; }');
  const result = spawnSync(process.execPath, [checker.pathname, path], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /UI copy/);
});
