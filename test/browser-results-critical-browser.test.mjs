import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native JUnit critical assertion and failure propagation', () => {
  const result = spawnSync('python3', ['scripts/browser-results-selftest.py'], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
