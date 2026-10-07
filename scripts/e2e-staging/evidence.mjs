import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function scrubEvidence(path) {
  const result = spawnSync('python3', [fileURLToPath(new URL('./scrub-evidence.py', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('Evidence scrub failed; private artifacts were not published');
}
