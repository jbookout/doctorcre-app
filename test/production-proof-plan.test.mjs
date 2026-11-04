import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('production proof admission adapter', () => {
  const output = execFileSync('python3', ['scripts/production-proof-plan-selftest.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  console.log(output);
});
