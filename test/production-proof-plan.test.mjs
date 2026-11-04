import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('production proof admission adapter', () => {
  const output = execFileSync('python3', ['scripts/production-proof-plan-selftest.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  console.log(output);
});

test('non-PR CLI skips admission outside the checkout', () => {
  const settings = { ...process.env };
  delete settings.GITHUB_EVENT_NAME;
  const output = execFileSync('python3', [fileURLToPath(new URL('../scripts/production-proof-plan.py', import.meta.url))], {
    cwd: tmpdir(), env: settings, encoding: 'utf8', timeout: 30000,
  });
  assert.match(output, /PR admission not evaluated/);
});
