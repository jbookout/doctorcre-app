import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('temporary directory is removed at test completion while the process stays alive', async () => {
  let directory;
  await test('directory owner', t => {
    directory = temporaryDirectory(join(tmpdir(), 'doctorcre-test-lifetime-'), t);
    assert.equal(existsSync(directory), true);
  });
  assert.equal(existsSync(directory), false);
});

test('guard rejects mkdir and mkdirSync under the temporary root', t => {
  const root = temporaryDirectory(join(tmpdir(), 'doctorcre-guard-fixture-'), t);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'scripts'));
  const guard = new URL('./temp-directory-guard.test.mjs', import.meta.url).pathname;
  for (const method of ['mkdirSync', 'mkdir']) {
    writeFileSync(join(root, 'test/leak.mjs'), `import { tmpdir } from 'node:os';
import { ${method} } from 'node:fs';
${method}(tmpdir() + '/leak-' + Date.now());`);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=created only', guard], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${method} must be rejected`);
    assert.match(result.stdout, /test[\\/]leak\.mjs/);
  }
});
