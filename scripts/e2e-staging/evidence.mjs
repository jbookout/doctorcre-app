import { currentRun, effectiveRunLimits } from './run-limits.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function scrubEvidence(path) {
  const run = currentRun();
  run?.checkArtifacts();
  const result = spawnSync('python3', [fileURLToPath(new URL('./scrub-evidence.py', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: effectiveRunLimits().httpTimeoutMs, maxBuffer: effectiveRunLimits().dispatcherOutputBytes });
  run?.checkArtifacts();
  if (result.status !== 0) throw new Error('Evidence scrub failed; private artifacts were not published');
}
