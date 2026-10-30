import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
      if (/\b(?:mkdtemp(?:Sync)?|tmpdir)\b/.test(source)) violations.push(path);
    }
  }
  assert.deepEqual(violations, []);
});

test('temporary directories are removed when a script succeeds or fails', async t => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const root = temporaryDirectory('doctorcre-cleanup-check-', t);
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

test('guard rejects mkdir and mkdirSync under the temporary root', t => {
  const root = temporaryDirectory('doctorcre-guard-fixture-', t);
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'scripts'));
  const guard = new URL('./temp-directory-guard.test.mjs', import.meta.url).pathname;
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const method of ['mkdirSync', 'mkdir']) {
    writeFileSync(join(root, 'test/leak.mjs'), `import { tmpdir } from 'node:os';
import { ${method} } from 'node:fs';
${method}(tmpdir() + '/leak-' + Date.now());`);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=created only', guard], { cwd: root, encoding: 'utf8', env: childEnv });
    assert.notEqual(result.status, 0, `${method} must be rejected: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /test[\\/]leak\.mjs/);
  }
});
