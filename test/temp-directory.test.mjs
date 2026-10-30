import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

test('temporary directory is removed at test completion while the process stays alive', async () => {
  let directory;
  await test('directory owner', t => {
    directory = temporaryDirectory('doctorcre-test-lifetime-', t);
    assert.equal(existsSync(directory), true);
  });
  assert.equal(existsSync(directory), false);
});

test('importing the browser harness without launching a browser creates no profile root', t => {
  const root = temporaryDirectory('doctorcre-unused-browser-', t);
  const harness = new URL('./browser-harness.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readdirSync } from 'node:fs';
    await import(${JSON.stringify(harness)});
    console.log(JSON.stringify(readdirSync(${JSON.stringify(root)}).filter(name => name.startsWith('doctorcre-browser-'))));
  `], { encoding: 'utf8', env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]), []);
});
