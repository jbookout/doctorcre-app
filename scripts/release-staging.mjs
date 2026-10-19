import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('python3', [fileURLToPath(new URL('./release-staging.py', import.meta.url)),
  process.execPath, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error || result.signal) {
  console.error('release:staging failed at python-launch. Recovery: install Python 3 or inspect the interrupted release state before retrying.');
}
process.exitCode = result.status ?? 1;
