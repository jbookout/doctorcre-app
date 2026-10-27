import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

test('temporary directory is removed at test completion while the process stays alive', async () => {
  let directory;
  await test('directory owner', t => {
    directory = temporaryDirectory('doctorcre-test-lifetime-', t);
    assert.equal(existsSync(directory), true);
  });
  assert.equal(existsSync(directory), false);
});
