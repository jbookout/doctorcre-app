import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native App review gate and squash queue behavior pass offline fixtures', () => {
  const result = spawnSync('python3', ['ops/review-gate-selftest.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
