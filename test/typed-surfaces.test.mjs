import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = fileURLToPath(new URL('../scripts/check-typed-surfaces.mjs', import.meta.url));
test('added surfaces require TSX while existing files and non-surfaces remain editable', t => {
  const repo = temporaryDirectory('typed-surfaces-', t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  const write = (path, content = '') => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const run = (base) => spawnSync(process.execPath, [check, base], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  write('js/existing.js', 'old');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  write('js/existing.js', 'fixed');
  write('scripts/helper.js');
  write('src/ui/NewSurface.tsx');
  git('add', '.'); git('commit', '-qm', 'allowed');
  assert.equal(run(base).status, 0, 'existing JS edits, helper JS and TSX pass');
  write('js/new-page.js');
  write('tours/new-component.jsx');
  git('add', '.'); git('commit', '-qm', 'plain JS surfaces');
  const rejected = run(base);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /js\/new-page\.js/);
  assert.match(rejected.stderr, /tours\/new-component\.jsx/);
  assert.match(rejected.stderr, /\.tsx/);
  assert.notEqual(run('missing-base').status, 0, 'missing history fails');
});
