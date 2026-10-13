import { currentRun, effectiveRunLimits } from './run-limits.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function scrubEvidence(path) {
  const run = currentRun();
  run?.checkArtifacts();
  const result = spawnSync('python3', [fileURLToPath(new URL('./scrub-evidence.py', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: effectiveRunLimits().httpTimeoutMs, maxBuffer: effectiveRunLimits().dispatcherOutputBytes });
  run?.checkArtifacts();
  if (result.status !== 0) throw new Error('Evidence scrub failed; private artifacts were not published');
}

// A failure keeps the full-page lossless capture a human needs to diagnose it.
// Every other result is proved by its recorded signals; its picture is a
// viewport JPEG at about a fifteenth of the full-page PNG's bytes.
const FAILURES = new Set(['DEAD', 'ERROR', 'UNREACHABLE']);
export const EVIDENCE_JPEG_QUALITY = 40;
export const evidenceCapture = status => FAILURES.has(status)
  ? { extension: 'png', options: { fullPage: true } }
  : { extension: 'jpg', options: { type: 'jpeg', quality: EVIDENCE_JPEG_QUALITY } };

// The capture is charged once and scrubbed in its private directory, then moved
// (not copied) to its public path, so the artifact retains one copy.
export async function publishScreenshot({ page, budget, paths }) {
  await mkdir(paths.privateDir, { recursive: true, mode: 0o700 });
  budget.check();
  const image = await page.screenshot(paths.capture.options);
  await budget.writeFile(paths.file, image, writeFile);
  scrubEvidence(paths.privateDir);
  await mkdir(paths.publicDir, { recursive: true, mode: 0o700 });
  await rename(paths.file, paths.publishedFile);
  await rm(paths.privateDir, { recursive: true, force: true });
  budget.checkArtifacts();
  return paths.publishedFile;
}
