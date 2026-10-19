import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = new URL('../scripts/check-ui-copy.mjs', import.meta.url);
const banned = ['Nothing needs you right now', 'nothing needs your decision', 'What needs you', 'Needs you',
  'Deals that need you', 'One thing is broken, nothing is stuck', 'Nothing is waiting on you', 'Everything is clear', 'WHAT\nNEEDS\tYOUR attention'];
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
