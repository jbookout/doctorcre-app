import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('temporary directories are created only by the shared helper', async () => {
  const violations = [];
  for (const dir of ['test', 'scripts']) {
    for (const file of await readdir(dir, { recursive: true })) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const path = join(dir, file);
      if (path === 'scripts/temp-directory.mjs' || path === 'test/temp-directory-guard.test.mjs') continue;
      const source = await readFile(path, 'utf8');
      if (/\bmkdtemp(?:Sync)?\b/.test(source) || /(?<!temporaryDirectory\()\bjoin\(\s*tmpdir\(\)/.test(source)) violations.push(path);
    }
  }
  assert.deepEqual(violations, []);
});

test('temporary directories are removed when a script succeeds or fails', async () => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const root = temporaryDirectory(join(tmpdir(), 'doctorcre-cleanup-check-'));
  const helper = new URL('../scripts/temp-directory.mjs', import.meta.url).href;
  for (const status of [0, 1]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { temporaryDirectory } from ${JSON.stringify(helper)};
      const dir = temporaryDirectory(${JSON.stringify(join(root, 'child-'))});
      console.log(dir);
      process.exitCode = ${status};
    `], { encoding: 'utf8' });
    assert.equal(child.status, status, child.stderr);
    assert.equal(existsSync(child.stdout.trim()), false);
  }
});
