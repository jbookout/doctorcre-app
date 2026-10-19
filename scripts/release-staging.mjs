import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('python3', [fileURLToPath(new URL('./release-staging.py', import.meta.url)),
  process.execPath, ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: Infinity, stdio: ['inherit', 'inherit', 'pipe'] });
const failure = result.stderr?.split('\n').find(line => line.startsWith('release:staging failed at '));
if (result.error || result.signal || (result.status !== 0 && !failure)) {
  console.error('release:staging failed at python-launch. Recovery: install Python 3 or repair its runtime configuration; inspect any interrupted release state before retrying.');
} else process.stderr.write(result.status === 0 ? result.stderr || '' : `${failure}\n`);
process.exitCode = result.status ?? 1;
